import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const adapter = new URL('../agent-terminal/rootfs/opt/agents/grok.sh', import.meta.url).pathname;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'grok-adapter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data'), home = join(root, 'home');
  mkdirSync(home);
  const run = (script, extra = {}) => spawnSync('bash', ['-euo', 'pipefail', '-c',
    '. "$1"; AGENT_DATA="$2"; GROK_DEFAULT_HOME="$3"; ' + script, 'bash', adapter, data, home],
  { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, GROK_DISABLE_AUTOUPDATER: '1', ...extra } });
  return { root, data, home, run };
}

test('Grok boot persists only its own hooks and does not change user settings or login', t => {
  const { data, run } = fixture(t);
  assert.equal(run('agent_init').status, 0);
  assert.equal(statSync(data).mode & 0o777, 0o700);
  const own = join(data, 'hooks/agent-terminal.json');
  const hooks = JSON.parse(readFileSync(own, 'utf8')).hooks;
  for (const event of ['SessionStart', 'Stop']) {
    assert.equal(hooks[event][0].hooks[0].command, 'node /opt/agent-terminal/session-hook.mjs grok ' + event);
  }
  writeFileSync(join(data, 'config.toml'), '[cli]\nauto_update = false\n');
  writeFileSync(join(data, 'auth.json'), 'private login');
  writeFileSync(join(data, 'hooks/custom.json'), '{"hooks":{}}');
  const before = ['config.toml', 'auth.json', 'hooks/custom.json', 'hooks/agent-terminal.json'].map(f => readFileSync(join(data, f), 'utf8'));
  assert.equal(run('agent_init').status, 0);
  assert.deepEqual(['config.toml', 'auth.json', 'hooks/custom.json', 'hooks/agent-terminal.json'].map(f => readFileSync(join(data, f), 'utf8')), before);
  assert.equal(run('agent_env').stdout, 'GROK_HOME=' + data + '\nGROK_DISABLE_AUTOUPDATER=1\n');
});

test('Grok launcher resumes its exact conversation with no workspace-wide continue', t => {
  const { root, run } = fixture(t);
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'grok'), '#!/bin/sh\nprintf "%s\\n" "$#" "$@"\n', { mode: 0o755 });
  const env = { PATH: bin + ':' + process.env.PATH };
  assert.equal(run('agent_run', env).stdout, '0\n');
  assert.equal(run('agent_run', { ...env, AGENT_CONVERSATION_ID: 'exact-id' }).stdout, '2\n--resume\nexact-id\n');
});

test('an early Grok login moves into persistent storage for already-open shells', t => {
  const { home, data, run } = fixture(t);
  mkdirSync(join(home, '.grok'));
  writeFileSync(join(home, '.grok/auth.json'), 'early login');
  assert.equal(run('agent_init').status, 0);
  assert.equal(readlinkSync(join(home, '.grok')), data);
  assert.equal(readFileSync(join(data, 'auth.json'), 'utf8'), 'early login');
});

test('the real Grok CLI reads boot hooks and MCP, preserves disabled servers, and rejects invalid config', {
  skip: spawnSync('grok', ['--version']).status !== 0 && 'Grok CLI not installed',
}, t => {
  const { data, run } = fixture(t);
  const boot = 'agent_init; agent_register_mcp homeassistant node /opt/ha-mcp/server.mjs';
  let result = run(boot); assert.equal(result.status, 0, result.stderr);
  result = run('GROK_HOME="$AGENT_DATA" grok inspect --json');
  assert.equal(result.status, 0, result.stderr);
  const discovered = JSON.parse(result.stdout);
  assert.ok(discovered.hooks.some(h => h.event === 'session_start' && h.target.endsWith('grok SessionStart')));
  assert.ok(discovered.mcpServers.some(s => s.name === 'homeassistant' && s.target === 'node'));
  const config = join(data, 'config.toml');
  writeFileSync(config, '[mcp_servers.homeassistant]\ncommand="custom-server"\nargs=["--read-only"]\nenabled=false\n');
  const before = readFileSync(config, 'utf8');
  result = run(boot); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(config, 'utf8'), before);
  writeFileSync(config, '[broken');
  assert.notEqual(run(boot).status, 0);
  assert.equal(readFileSync(config, 'utf8'), '[broken');
});
