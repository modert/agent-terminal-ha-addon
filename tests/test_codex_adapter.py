"""Exercise the adapter with the real Codex CLI, without login or API calls.

Requires Python 3.11+, Bash, and the adapter's pinned Codex version on PATH.
Run from the repository root: python3 -m unittest discover -s tests -v
"""

import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import tomllib
import unittest


ADAPTER = (
    Path(__file__).resolve().parents[1]
    / "agent-terminal/rootfs/opt/agents/codex.sh"
)


class CodexAdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("codex"):
            raise RuntimeError("Install the Codex version pinned in codex.sh first")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agent-terminal-test-")
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / "codex"
        self.config = self.data / "config.toml"
        self.auth = self.data / "auth.json"
        self.run_adapter("agent_init")

    def run_adapter(self, *args, check=True):
        # Only this child process gets the adapter's environment. No real
        # credentials, home directory, or global CLI installation are changed.
        env = os.environ.copy()
        for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"):
            env.pop(key, None)
        env["SUPERVISOR_TOKEN"] = "test-token-must-not-be-written-to-config"
        result = subprocess.run(
            [
                "bash", "-euo", "pipefail", "-c",
                '. "$1"\n'
                'AGENT_DATA="$2"\n'
                'while IFS= read -r kv; do export "$kv"; done < <(agent_env)\n'
                'shift 2\n'
                '"$@"',
                "adapter-test", str(ADAPTER), str(self.data), *args,
            ],
            cwd=self.temp.name,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if check:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def test_new_config_uses_private_persistent_file_storage(self):
        self.assertEqual(
            tomllib.loads(self.config.read_text())["cli_auth_credentials_store"],
            "file",
        )
        self.assertEqual(stat.S_IMODE(self.data.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o600)
        self.assertEqual(
            self.run_adapter("printenv", "CODEX_HOME").stdout.strip(),
            str(self.data),
        )

    def test_registration_is_idempotent_and_preserves_user_data(self):
        original = (
            '# Keep my preferences and other MCP servers.\n'
            'cli_auth_credentials_store = "file"\n'
            'model_reasoning_effort = "high"\n'
            '[mcp_servers.other]\n'
            'command = "node"\n'
            'args = ["/some/other/server.mjs"]\n'
        )
        self.config.write_text(original)
        self.auth.write_text('{"test_credentials": "unchanged"}\n')
        arguments = ("agent_register_mcp", "homeassistant", "node", "/opt/ha-mcp/server.mjs")
        self.run_adapter(*arguments)
        first = self.config.read_bytes()
        self.run_adapter(*arguments)
        self.assertEqual(self.config.read_bytes(), first)
        config = tomllib.loads(first.decode())
        self.assertEqual(config["model_reasoning_effort"], "high")
        self.assertEqual(config["mcp_servers"]["other"]["command"], "node")
        self.assertIn("# Keep my preferences", first.decode())
        self.assertEqual(self.auth.read_text(), '{"test_credentials": "unchanged"}\n')
        self.assertNotIn(b"test-token-must-not-be-written-to-config", first)
        registered = json.loads(
            self.run_adapter("codex", "mcp", "get", "homeassistant", "--json").stdout
        )
        self.assertEqual(registered["transport"]["command"], "node")
        self.assertEqual(registered["transport"]["args"], ["/opt/ha-mcp/server.mjs"])

    def test_registration_preserves_argument_boundaries(self):
        args = ["/server with spaces.mjs", 'quote"and\\slash', "--flag=value"]
        self.run_adapter("agent_register_mcp", "example", "node", *args)
        config = tomllib.loads(self.config.read_text())
        self.assertEqual(config["mcp_servers"]["example"]["args"], args)

    def test_registration_preserves_disabled_server_and_tool_restrictions(self):
        config = (
            'cli_auth_credentials_store = "file"\n'
            '[mcp_servers.homeassistant]\n'
            'command = "node"\n'
            'args = ["/opt/ha-mcp/server.mjs"]\n'
            'enabled = false\n'
            'disabled_tools = ["ha_call_service"]\n'
            'tool_timeout_sec = 45\n'
        )
        self.config.write_text(config)
        self.run_adapter("agent_register_mcp", "homeassistant", "node", "/opt/ha-mcp/server.mjs")
        self.assertEqual(self.config.read_text(), config)

    def test_registration_preserves_existing_custom_server(self):
        config = (
            '[mcp_servers.homeassistant]\n'
            'command = "custom-ha-server"\n'
            'args = ["--custom"]\n'
        )
        self.config.write_text(config)
        self.run_adapter("agent_register_mcp", "homeassistant", "node", "/opt/ha-mcp/server.mjs")
        self.assertEqual(self.config.read_text(), config)

    def test_malformed_config_is_rejected_without_overwriting(self):
        bad_config = b'model = "unfinished\n'
        self.config.write_bytes(bad_config)
        self.auth.write_bytes(b"credential sentinel")
        result = self.run_adapter(
            "agent_register_mcp", "homeassistant", "node", "/opt/ha-mcp/server.mjs",
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.config.read_bytes(), bad_config)
        self.assertEqual(self.auth.read_bytes(), b"credential sentinel")

    def test_reinitialization_preserves_settings_auth_and_sessions(self):
        config = 'cli_auth_credentials_store = "file"\nmodel_reasoning_effort = "low"\n'
        self.config.write_text(config)
        self.auth.write_bytes(b"credential sentinel")
        sessions = self.data / "sessions"
        sessions.mkdir()
        saved = sessions / "saved.jsonl"
        saved.write_bytes(b"saved conversation sentinel")
        # Each invocation is a fresh shell, as it would be after a restart.
        self.run_adapter("agent_init")
        self.run_adapter("agent_register_mcp", "homeassistant", "node", "/opt/ha-mcp/server.mjs")
        self.assertEqual(tomllib.loads(self.config.read_text())["model_reasoning_effort"], "low")
        self.assertEqual(self.auth.read_bytes(), b"credential sentinel")
        self.assertEqual(saved.read_bytes(), b"saved conversation sentinel")


if __name__ == "__main__":
    unittest.main()
