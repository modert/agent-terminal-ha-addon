import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
// CI mounts the source read-only; dependencies live in the built image.
const controlRoot = process.env.AGENT_TERMINAL_TEST_CONTAINER === '1'
  ? new URL('file:///opt/agent-terminal/') : new URL('../agent-terminal/rootfs/opt/agent-terminal/', import.meta.url);
const { createRemoteService } = await import(new URL('remote.mjs', controlRoot));
const { requestRemote } = await import(new URL('remote-client.mjs', controlRoot));
const { connectCodex } = await import(new URL('codex-rpc.mjs', controlRoot));
const require = createRequire(new URL('package.json', controlRoot));
const { WebSocketServer } = require('ws');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  const deadline = Date.now() + 3000;
  while (!fn()) { if (Date.now() > deadline) throw new Error('Condition did not become true.'); await pause(10); }
}
function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-remote-test-'));
  const children = [], calls = [], snapshots = [];
  let failHealth = false;
  const remote = { status: 'connected', serverName: 'Test Home Assistant', environmentId: 'env_test' };
  const options = { stateDir: join(root, 'state'), runtimeDir: join(root, 'runtime'), statusPath: join(root, 'status.json'), command: 'codex',
    startupMs: 150, healthMs: 30, retryMs: 10,
    onStatus: value => snapshots.push(value),
    spawnServer(command, args, options) {
      const child = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null; child.signalCode = null;
      child.kill = signal => { child.signalCode = signal; queueMicrotask(() => child.emit('exit', null)); };
      child.command = command; child.args = args; child.options = options;
      children.push(child); return child;
    },
    async connect(socket, options) {
      return { closed: false, dispose() { this.closed = true; }, async call(method, params) {
        calls.push({ method, params });
        if (method === 'remoteControl/status/read' && failHealth) { failHealth = false; throw new Error('disconnected'); }
        if (method === 'remoteControl/disable') return { ...remote, status: 'disabled' };
        if (method === 'remoteControl/pairing/start') return { pairingCode: 'secret-long-code', manualPairingCode: '123-456', expiresAt: Math.floor(Date.now() / 1000) + 600 };
        return remote;
      } };
    }, ...overrides };
  const service = createRemoteService(options);
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  return { service, options, root, children, calls, snapshots, breakHealth() { failHealth = true; } };
}

test('Remote is off until enabled and pairing codes never enter persistent state or status', async t => {
  const f = fixture(t); await f.service.listen();
  assert.equal(f.service.snapshot().enabled, false); assert.equal(f.children.length, 0);
  await assert.rejects(f.service.request('pair'), /Enable Remote/);
  const status = await f.service.request('start');
  assert.equal(status.status, 'connected');
  assert.ok(f.children[0].args.includes('unix://' + join(f.options.runtimeDir, 'app-server.sock')));
  assert.equal(f.children[0].options.env.AGENT_TERMINAL_SESSION_ID, '');
  const pair = await f.service.request('pair'); assert.equal(pair.manualPairingCode, '123-456');
  const stored = readFileSync(join(f.options.stateDir, 'remote.json'), 'utf8') + readFileSync(f.options.statusPath, 'utf8') + JSON.stringify(f.snapshots);
  assert.ok(!stored.includes('123-456') && !stored.includes('secret-long-code'));
  assert.equal(statSync(join(f.options.runtimeDir, 'control.sock')).mode & 0o777, 0o600);
  assert.equal(statSync(f.options.runtimeDir).mode & 0o777, 0o700);
});

test('parallel enables launch one server and child death reconnects without changing saved preference', async t => {
  const f = fixture(t); await f.service.listen();
  await Promise.all([f.service.request('start'), f.service.request('start')]);
  assert.equal(f.children.length, 1);
  f.children[0].exitCode = 1; f.children[0].emit('exit', 1);
  await until(() => f.children.length === 2 && f.service.snapshot().status === 'connected');
  assert.equal(f.service.snapshot().restartCount, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(f.options.stateDir, 'remote.json'))), { enabled: true });
  assert.equal(f.calls.filter(c => c.method === 'remoteControl/enable').length, 2);
});

test('health failure replaces the server, while disabling Remote prevents automatic restart', async t => {
  const f = fixture(t); await f.service.listen(); await f.service.request('start');
  f.breakHealth(); await until(() => f.children.length === 2 && f.service.snapshot().status === 'connected');
  await f.service.request('stop'); await pause(80);
  assert.equal(f.children.length, 2); assert.equal(f.service.snapshot().status, 'disabled');
  assert.equal(f.calls.at(-1).method, 'remoteControl/disable');
  assert.deepEqual(JSON.parse(readFileSync(join(f.options.stateDir, 'remote.json'))), { enabled: false });
});

test('supervisor replacement restores the enabled preference without another UI action', async t => {
  const f = fixture(t); await f.service.listen(); await f.service.request('start'); await f.service.close();
  const replacement = createRemoteService(f.options);
  t.after(() => replacement.close());
  await replacement.listen(); await until(() => replacement.snapshot().status === 'connected');
  assert.equal(f.children.length, 2);
});

test('control channel accepts only fixed Remote operations and returns request-specific pairing material', async t => {
  const f = fixture(t); await f.service.listen();
  const socketPath = join(f.options.runtimeDir, 'control.sock');
  await assert.rejects(requestRemote('exec', { socketPath }), /Unknown Remote/);
  await requestRemote('start', { socketPath });
  const [status, pair] = await Promise.all([requestRemote('status', { socketPath }), requestRemote('pair', { socketPath })]);
  assert.equal(status.status, 'connected'); assert.equal(status.manualPairingCode, undefined);
  assert.equal(pair.manualPairingCode, '123-456');
  const duplicate = createRemoteService(f.options);
  await assert.rejects(duplicate.listen(), /already running/);
  assert.equal(f.children.length, 1);
});

test('RPC initializes experimental native Remote and rejects pending requests when the server disconnects', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-remote-rpc-')), path = join(root, 'app.sock');
  const server = createServer(), wss = new WebSocketServer({ server });
  const methods = []; let peer;
  wss.on('connection', socket => {
    peer = socket;
    socket.on('message', bytes => {
      const m = JSON.parse(bytes); methods.push(m.method);
      if (m.method === 'initialize') {
        assert.equal(m.params.capabilities.experimentalApi, true);
        socket.send(JSON.stringify({ id: m.id, result: { platformOs: 'linux' } }));
      } else if (m.method === 'remoteControl/status/read') socket.send(JSON.stringify({ id: m.id, result: { status: 'connected' } }));
    });
  });
  await new Promise(resolve => server.listen(path, resolve));
  t.after(async () => { for (const socket of wss.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const rpc = await connectCodex(path, { timeout: 1000 });
  assert.equal((await rpc.call('remoteControl/status/read')).status, 'connected');
  assert.deepEqual(methods.slice(0, 3), ['initialize', 'initialized', 'remoteControl/status/read']);
  const pending = rpc.call('unanswered'); peer.terminate();
  await assert.rejects(pending, /disconnected|unavailable/); assert.equal(rpc.closed, true);
});
