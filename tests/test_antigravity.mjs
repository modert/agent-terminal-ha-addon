// The Antigravity adapter's boot and launch functions, against temporary
// folders. Nothing here signs in or needs the real CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, readlinkSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const adapter = new URL('../agent-terminal/rootfs/opt/agents/antigravity.sh', import.meta.url).pathname;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'antigravity-adapter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data'), home = join(root, 'home');
  mkdirSync(home);
  // Functions run the way boot runs them: sourced, with errors fatal. The
  // environment starts empty: these tests may run inside a live session.
  const run = (script, { env = {}, input = '' } = {}) => spawnSync('bash', ['-euo', 'pipefail', '-c',
    '. "$1"; AGENT_DATA="$2"; ANTIGRAVITY_HOME="$3"; ' + script, 'bash', adapter, data, home],
  { encoding: 'utf8', input, env: { PATH: process.env.PATH, ...env } });
  const json = file => JSON.parse(readFileSync(join(data, file), 'utf8'));
  return { root, data, home, run, json };
}
const boot = 'agent_init; agent_register_mcp homeassistant node /opt/ha-mcp/server.mjs';

test('boot keeps the login, the session hook and the HA server in persistent storage', t => {
  const { data, home, run, json } = fixture(t);
  assert.equal(run(boot).status, 0);
  assert.equal(statSync(data).mode & 0o777, 0o700, 'the folder holds the login');
  for (const folder of ['.gemini', '.config/antigravity']) {
    assert.equal(lstatSync(join(home, folder)).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(home, folder)), join(data, folder));
  }
  assert.deepEqual(json('.gemini/config/mcp_config.json'),
    { mcpServers: { homeassistant: { command: 'node', args: ['/opt/ha-mcp/server.mjs'] } } });
  const hook = json('.gemini/config/hooks.json')['agent-terminal'];
  assert.deepEqual(Object.keys(hook), ['PreInvocation', 'Stop']);
  for (const event of ['PreInvocation', 'Stop']) {
    assert.deepEqual(hook[event], [{ type: 'command', timeout: 5,
      command: 'node /opt/agent-terminal/session-hook.mjs antigravity ' + event }]);
  }
  assert.equal(run('agent_env').stdout, 'AGY_CLI_DISABLE_AUTO_UPDATE=true\n', 'the image supplies the CLI');
});

test('later boots leave the user\'s servers, hooks and files exactly as they are', t => {
  const { data, run } = fixture(t);
  run(boot);
  const servers = join(data, '.gemini/config/mcp_config.json'), hooks = join(data, '.gemini/config/hooks.json');
  writeFileSync(servers, JSON.stringify({ mcpServers: {
    homeassistant: { command: 'custom-ha-server', args: ['--read-only'], disabledTools: ['ha_call_service'] },
    other: { serverUrl: 'https://mcp.example.test/' } } }));
  writeFileSync(hooks, JSON.stringify({ lint: { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] },
    ...JSON.parse(readFileSync(hooks, 'utf8')) }));
  writeFileSync(join(data, '.gemini/antigravity-cli-token'), 'unchanged');
  const before = [servers, hooks].map(file => readFileSync(file, 'utf8'));
  assert.equal(run(boot).status, 0);
  assert.deepEqual([servers, hooks].map(file => readFileSync(file, 'utf8')), before);
  assert.equal(readFileSync(join(data, '.gemini/antigravity-cli-token'), 'utf8'), 'unchanged');

  // The add-on's own hook follows the image; the user's stay beside it.
  const stale = JSON.parse(before[1]);
  stale['agent-terminal'].Stop[0].command = 'node /opt/agent-terminal/old-hook.mjs';
  writeFileSync(hooks, JSON.stringify(stale));
  run(boot);
  const refreshed = JSON.parse(readFileSync(hooks, 'utf8'));
  assert.equal(refreshed['agent-terminal'].Stop[0].command, 'node /opt/agent-terminal/session-hook.mjs antigravity Stop');
  assert.deepEqual(refreshed.lint, stale.lint);
});

test('a file that does not parse is never rewritten', t => {
  const { data, run } = fixture(t);
  run(boot);
  const servers = join(data, '.gemini/config/mcp_config.json'), hooks = join(data, '.gemini/config/hooks.json');
  writeFileSync(servers, '{ "mcpServers": ');
  writeFileSync(hooks, '[]');
  assert.equal(run('agent_init').status, 0, 'boot continues without the hook');
  assert.notEqual(run('agent_register_mcp homeassistant node /opt/ha-mcp/server.mjs').status, 0);
  assert.equal(readFileSync(servers, 'utf8'), '{ "mcpServers": ');
  assert.equal(readFileSync(hooks, 'utf8'), '[]');
});

test('files a CLI wrote before the first boot move into persistent storage', t => {
  const { data, home, run } = fixture(t);
  mkdirSync(join(home, '.gemini/antigravity-cli'), { recursive: true });
  writeFileSync(join(home, '.gemini/antigravity-cli/antigravity-oauth-token'), 'early login');
  assert.equal(run(boot).status, 0);
  assert.equal(lstatSync(join(home, '.gemini')).isSymbolicLink(), true);
  assert.equal(readFileSync(join(data, '.gemini/antigravity-cli/antigravity-oauth-token'), 'utf8'), 'early login');
});

test('the launcher reopens only its assigned conversation', t => {
  const { root, run } = fixture(t);
  const bin = join(root, 'bin'), output = join(root, 'args');
  mkdirSync(bin);
  writeFileSync(join(bin, 'agy'), '#!/bin/sh\n[ "$1" = --version ] && { echo 1.3.3; exit 0; }\nprintf "%s\\n" "$#" "$@" > "$CAPTURE_ARGS"\n', { mode: 0o755 });
  const launch = extra => {
    assert.equal(run('agent_run', { env: { PATH: bin + ':' + process.env.PATH, CAPTURE_ARGS: output, ...extra } }).status, 0);
    return readFileSync(output, 'utf8').trim().split('\n');
  };
  const id = '550e8400-e29b-41d4-a716-446655440000';
  assert.deepEqual(launch({}), ['0']);
  assert.deepEqual(launch({ AGENT_CONVERSATION_ID: id }), ['2', '--conversation', id]);
});

test('a processor that cannot run the CLI gets an explanation and a stopped session, not a restart loop', t => {
  const { root, run } = fixture(t);
  const bin = join(root, 'bin'), started = join(root, 'started');
  mkdirSync(bin);
  // The real binary's own words on such a processor, and its exit status.
  writeFileSync(join(bin, 'agy'), `#!/bin/sh
[ "$1" = --version ] || touch "${started}"
printf '%s\\n\\0' 'FATAL ERROR: This binary was compiled with pclmul enabled, but this feature is not available on this processor (go/sigill-fail-fast).' >&2
exit 132
`, { mode: 0o755 });
  const result = run('agent_run', { env: { PATH: bin + ':' + process.env.PATH }, input: '\n' });
  assert.notEqual(result.status, 0, 'agent-run then marks the session stopped');
  assert.match(result.stdout, /Antigravity cannot start on this machine/);
  assert.match(result.stdout, /compiled with pclmul enabled/, 'the CLI\'s own reason is shown');
  assert.match(result.stdout, /CPU type to "host"/);
  assert.equal(result.stderr, '', 'nothing but the explanation reaches the terminal');
  assert.equal(existsSync(started), false, 'the session is never started');

  writeFileSync(join(bin, 'agy'), '#!/bin/sh\necho "agy: something else is wrong" >&2\nexit 1\n', { mode: 0o755 });
  const other = run('agent_run', { env: { PATH: bin + ':' + process.env.PATH }, input: '\n' });
  assert.match(other.stdout, /something else is wrong/);
  assert.doesNotMatch(other.stdout, /CPU type/, 'processor advice only for a processor fault');
});
