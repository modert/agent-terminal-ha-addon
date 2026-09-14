"""Check real Codex/MCP interoperability without account login or model calls."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import threading
import unittest

import test_codex_adapter as adapter_tests


class McpIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.adapter = adapter_tests.CodexAdapterTests()
        self.adapter.setUp()
        self.addCleanup(self.adapter.doCleanups)
        installed = Path("/opt/ha-mcp/server.mjs")
        self.server = installed if installed.is_file() else (
            Path(__file__).resolve().parents[1]
            / "agent-terminal/rootfs/opt/ha-mcp/server.mjs"
        )

    def start_rpc(self, command, env=None):
        child_env = os.environ.copy()
        for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "SUPERVISOR_TOKEN"):
            child_env.pop(key, None)
        child_env.update(env or {})
        process = subprocess.Popen(
            command, cwd=self.adapter.temp.name, env=child_env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, start_new_session=True,
        )
        inbox = queue.Queue()

        def read():
            for line in process.stdout:
                inbox.put(json.loads(line))

        reader = threading.Thread(target=read, daemon=True)
        reader.start()

        def stop():
            process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
            reader.join(timeout=2)
            process.stdout.close()

        self.addCleanup(stop)

        def send(message):
            process.stdin.write(json.dumps(message) + "\n")
            process.stdin.flush()

        def request(ident, method, params):
            send({"jsonrpc": "2.0", "id": ident, "method": method, "params": params})
            while True:
                message = inbox.get(timeout=20)
                if message.get("id") == ident:
                    self.assertNotIn("error", message, message)
                    return message["result"]

        return send, request

    def test_codex_discovers_all_home_assistant_tools(self):
        self.adapter.run_adapter("agent_register_mcp", "homeassistant", "node", str(self.server))
        send, request = self.start_rpc([
            "bash", "-euo", "pipefail", "-c",
            '. "$1"\nAGENT_DATA="$2"\n'
            'while IFS= read -r kv; do export "$kv"; done < <(agent_env)\n'
            'exec codex app-server',
            "mcp-test", str(adapter_tests.ADAPTER), str(self.adapter.data),
        ])
        request(1, "initialize", {"clientInfo": {"name": "agent_terminal_test", "version": "1.0.0"}})
        send({"method": "initialized", "params": {}})
        result = request(2, "mcpServerStatus/list", {"detail": "toolsAndAuthOnly"})
        ha = next(server for server in result["data"] if server["name"] == "homeassistant")
        tools = ha["tools"].values() if isinstance(ha["tools"], dict) else ha["tools"]
        self.assertEqual({tool["name"] for tool in tools}, {
            "ha_list_entities", "ha_get_entity_state", "ha_call_service",
            "ha_render_template", "ha_list_services", "ha_get_error_log",
        })

    @unittest.skipUnless(os.environ.get("AGENT_TERMINAL_TEST_CONTAINER") == "1", "requires disposable image")
    def test_ha_request_uses_supervisor_token_file(self):
        class FakeHomeAssistant(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                if self.headers.get("Authorization") != "Bearer agent-terminal-test-supervisor-token":
                    self.send_error(401)
                    return
                if self.path != "/api/states":
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps([
                    {"entity_id": "light.kitchen", "state": "on", "attributes": {"friendly_name": "Kitchen"}},
                    {"entity_id": "sensor.temperature", "state": "20", "attributes": {}},
                ]).encode())

        api = ThreadingHTTPServer(("127.0.0.1", 0), FakeHomeAssistant)
        thread = threading.Thread(target=api.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(api.server_close)
        self.addCleanup(api.shutdown)
        send, request = self.start_rpc(
            ["node", str(self.server)],
            {"HA_API_BASE": f"http://127.0.0.1:{api.server_port}/api"},
        )
        request(1, "initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "agent_terminal_test", "version": "1.0.0"},
        })
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        result = request(2, "tools/call", {"name": "ha_list_entities", "arguments": {"domain": "light"}})
        self.assertFalse(result.get("isError"), result)
        self.assertEqual(json.loads(result["content"][0]["text"]), {
            "count": 1,
            "entities": [{"entity_id": "light.kitchen", "state": "on", "name": "Kitchen"}],
        })
