// Supervise a foreground native Codex app-server. Do not install its separate
// daemon/updater, expose a TCP port, or change the user's Codex configuration.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { connectCodex } from './codex-rpc.mjs';
import { remoteRuntimeDir } from './remote-client.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function nativeCodex() {
  // The npm launcher is a Node parent. Killing only that parent leaves the
  // native server alive, so supervise the platform binary directly.
  const launcher = realpathSync('/usr/local/bin/codex');
  if (!launcher.endsWith('.js')) return launcher;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const target = process.arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl';
  const require = createRequire(launcher);
  let vendor;
  try { vendor = join(dirname(require.resolve('@openai/codex-linux-' + arch + '/package.json')), 'vendor'); }
  catch { vendor = join(dirname(launcher), '..', 'vendor'); }
  const binary = join(vendor, target, 'bin', 'codex');
  if (!existsSync(binary)) throw new Error('Codex native server binary is missing.');
  return binary;
}
function processStart(pid) {
  try {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return null; }
}
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error('Unsafe Remote socket directory.');
  chmodSync(path, 0o700);
}
export function createRemoteService({
  stateDir = '/data/agent-terminal', runtimeDir = remoteRuntimeDir(), codexHome = '/data/codex',
  statusPath = '/run/agent-terminal/remote-status.json', command = null,
  spawnServer = spawn, connect = connectCodex, healthMs = 15000, retryMs = 2000,
  startupMs = 10000, onStatus = () => {},
} = {}) {
  const statePath = join(stateDir, 'remote.json'), appSocket = join(runtimeDir, 'app-server.sock');
  const pidPath = join(runtimeDir, 'native.json');
  let enabled = false, stopping = false, child = null, rpc = null, starting = null;
  let retry = null, health = null, failures = 0, restartCount = 0, control = null, operations = Promise.resolve();
  let checking = false;
  let current = { status: 'disabled', serverName: '', environmentId: null, error: null };
  const snapshot = () => ({ enabled, ...current, restartCount });
  function ownedPid() {
    try {
      const { pid, start } = JSON.parse(readFileSync(pidPath, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 1 || typeof start !== 'string' || processStart(pid) !== start) return null;
      const argv = readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0');
      if (argv[1] !== 'app-server' || argv[2] !== '--listen' || argv[3] !== 'unix://' + appSocket) return null;
      return pid;
    } catch { return null; }
  }
  function forgetPid() { if (existsSync(pidPath)) unlinkSync(pidPath); }
  function publish(update) {
    current = { ...current, ...update };
    const value = snapshot();
    if (statusPath) {
      const temporary = statusPath + '.tmp';
      writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
      renameSync(temporary, statusPath);
    }
    onStatus(value);
  }
  function save(value) {
    privateDirectory(stateDir);
    const temporary = statePath + '.tmp';
    writeFileSync(temporary, JSON.stringify({ enabled: value }) + '\n', { mode: 0o600 });
    renameSync(temporary, statePath);
    enabled = value;
  }
  function remoteStatus(value) {
    if (!value || !['disabled', 'connecting', 'connected', 'errored'].includes(value.status)) return;
    publish({ status: value.status, serverName: value.serverName || '', environmentId: value.environmentId || null,
      error: value.status === 'errored' ? 'Remote could not connect. Check your Codex ChatGPT login and network.' : null });
    if (value.status === 'connected') failures = 0;
  }
  function scheduleRestart() {
    if (!enabled || stopping || retry) return;
    const delay = Math.min(30000, retryMs * 2 ** Math.min(failures++, 4));
    retry = setTimeout(() => {
      retry = null;
      ensure().catch(() => {});
    }, delay);
  }
  function disconnect(ownedChild) {
    if (child !== ownedChild) return;
    child = null; rpc?.dispose(); rpc = null;
    forgetPid();
    clearInterval(health); health = null;
    if (enabled && !stopping) {
      restartCount++;
      publish({ status: 'connecting', environmentId: null, error: 'Codex Remote stopped. Reconnecting…' });
      scheduleRestart();
    }
  }
  async function stopChild() {
    clearInterval(health); health = null;
    rpc?.dispose(); rpc = null;
    const owned = child;
    const adopted = !owned && ownedPid();
    child = null;
    if (owned && owned.exitCode === null && owned.signalCode === null) {
      await new Promise(resolve => {
        const kill = setTimeout(() => owned.kill('SIGKILL'), 3000);
        owned.once('exit', () => { clearTimeout(kill); resolve(); });
        owned.kill('SIGTERM');
      });
    }
    if (adopted) {
      try { process.kill(adopted, 'SIGTERM'); } catch {}
      const deadline = Date.now() + 3000;
      while (ownedPid() === adopted && Date.now() < deadline) await pause(50);
      if (ownedPid() === adopted) { try { process.kill(adopted, 'SIGKILL'); } catch {} }
    }
    forgetPid();
  }
  function ensure() {
    if (starting) return starting;
    if (rpc && !rpc.closed) return Promise.resolve(snapshot());
    if (!enabled || stopping) return Promise.reject(new Error('Enable Remote first.'));
    starting = (async () => {
      clearTimeout(retry); retry = null;
      if (child) await stopChild();
      publish({ status: 'connecting', error: null, environmentId: null });
      let connection, owned = null;
      // A killed supervisor may leave its foreground server alive. Reattach
      // only when both the PID identity and its exact socket command match.
      if (ownedPid()) {
        try { connection = await connect(appSocket, { onNotification: message => {
          if (rpc && message.method === 'remoteControl/status/changed') remoteStatus(message.params);
        } }); }
        catch { await stopChild(); }
      }
      if (!connection) {
        owned = spawnServer(command || nativeCodex(), ['app-server', '--listen', 'unix://' + appSocket], {
          cwd: '/homeassistant', env: { ...process.env, CODEX_HOME: codexHome,
            // Per-terminal hook tokens must never leak into the shared server.
            AGENT_TERMINAL_SESSION_ID: '', AGENT_TERMINAL_LAUNCH_ID: '', AGENT_CONVERSATION_ID: '' },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        child = owned;
        if (owned.pid && processStart(owned.pid)) {
          const temporary = pidPath + '.tmp';
          writeFileSync(temporary, JSON.stringify({ pid: owned.pid, start: processStart(owned.pid) }) + '\n', { mode: 0o600 });
          renameSync(temporary, pidPath);
        }
        // Drain stderr without broadcasting logs or private chat metadata.
        owned.stderr?.on('data', () => {});
        owned.on('exit', () => disconnect(owned));
        owned.on('error', () => disconnect(owned));
        const deadline = Date.now() + startupMs;
        while (child === owned && !stopping && enabled && Date.now() < deadline) {
          try {
            connection = await connect(appSocket, { connectTimeout: Math.min(1000, startupMs), onNotification: message => {
              if (child === owned && message.method === 'remoteControl/status/changed') remoteStatus(message.params);
            } });
            break;
          } catch { await pause(100); }
        }
      }
      if (!connection || child !== owned || !enabled || stopping) {
        connection?.dispose();
        throw new Error('Codex Remote server did not become ready.');
      }
      rpc = connection;
      remoteStatus(await rpc.call('remoteControl/enable', { ephemeral: true }));
      health = setInterval(async () => {
        if (!rpc || !enabled || stopping || checking) return;
        checking = true;
        const active = rpc;
        try {
          const status = await active.call('remoteControl/status/read');
          if (rpc === active && enabled && !stopping) remoteStatus(status);
        }
        catch {
          if (rpc !== active || !enabled || stopping) return;
          await stopChild();
          if (enabled && !stopping) {
            restartCount++;
            publish({ status: 'connecting', environmentId: null, error: 'Codex Remote lost its connection. Reconnecting…' });
            scheduleRestart();
          }
        } finally { checking = false; }
      }, healthMs);
      return snapshot();
    })().catch(async error => {
      await stopChild();
      if (enabled && !stopping) {
        publish({ status: 'errored', environmentId: null, error: error.message });
        scheduleRestart();
      }
      throw error;
    }).finally(() => { starting = null; });
    return starting;
  }
  async function perform(method) {
    switch (method) {
      case 'status': return snapshot();
      case 'start':
        save(true);
        return ensure();
      case 'stop':
        save(false); clearTimeout(retry); retry = null;
        if (starting) await starting.catch(() => {});
        if (rpc) await rpc.call('remoteControl/disable', { ephemeral: true }).catch(() => {});
        await stopChild();
        publish({ status: 'disabled', error: null, environmentId: null });
        return snapshot();
      case 'pair': {
        if (!enabled) throw new Error('Enable Remote first.');
        await ensure();
        const deadline = Date.now() + 12000;
        while (current.status === 'connecting' && Date.now() < deadline) {
          await pause(200);
          if (!rpc || !enabled) throw new Error('Remote disconnected. Try again when it reconnects.');
          remoteStatus(await rpc.call('remoteControl/status/read'));
        }
        if (current.status !== 'connected') throw new Error(current.error || 'Remote is still connecting. Try again in a moment.');
        // Pairing material exists only in this response. Never persist it,
        // include it in status snapshots, or send it to other browsers.
        const pair = await rpc.call('remoteControl/pairing/start', { manualCode: true });
        if (!pair.manualPairingCode || !Number.isFinite(pair.expiresAt)) throw new Error('Codex did not return a pairing code.');
        return { manualPairingCode: pair.manualPairingCode, expiresAt: pair.expiresAt };
      }
      default: throw new Error('Unknown Remote operation.');
    }
  }
  function request(method) {
    // Status reads stay responsive during startup; mutations serialize.
    if (method === 'status') return Promise.resolve(snapshot());
    const result = operations.then(() => perform(method));
    operations = result.catch(() => {});
    return result;
  }
  async function listen() {
    privateDirectory(dirname(runtimeDir));
    privateDirectory(runtimeDir);
    if (statusPath) privateDirectory(join(statusPath, '..'));
    if (existsSync(statePath)) {
      const saved = JSON.parse(readFileSync(statePath, 'utf8'));
      if (typeof saved.enabled !== 'boolean') throw new Error('Invalid Remote settings.');
      enabled = saved.enabled;
    }
    const controlPath = join(runtimeDir, 'control.sock');
    // Do not unlink another running supervisor's socket. Probe before
    // removing a stale socket from an interrupted earlier service.
    if (existsSync(controlPath)) {
      const { requestRemote } = await import('./remote-client.mjs');
      try {
        await requestRemote('status', { socketPath: controlPath, timeout: 1000 });
        throw new Error('Remote service is already running.');
      } catch (error) {
        if (error.message === 'Remote service is already running.' || error.message.includes('did not respond')) throw error;
        unlinkSync(controlPath);
      }
    }
    control = createServer(socket => {
      socket.setEncoding('utf8'); socket.setTimeout(50000, () => socket.destroy());
      let buffer = '', used = false;
      socket.on('error', () => {});
      socket.on('data', chunk => {
        if (used) return;
        buffer += chunk;
        if (buffer.length > 1024) { socket.destroy(); return; }
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        used = true;
        let method;
        try {
          const input = JSON.parse(buffer.slice(0, end));
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== 'method')) throw new Error('Invalid Remote request.');
          method = input.method;
          if (!['status', 'start', 'stop', 'pair'].includes(method)) throw new Error('Unknown Remote operation.');
        } catch (error) { socket.end(JSON.stringify({ error: error.message }) + '\n'); return; }
        request(method).then(result => socket.end(JSON.stringify({ result }) + '\n'),
          error => socket.end(JSON.stringify({ error: error.message }) + '\n'));
      });
    });
    await new Promise((resolve, reject) => { control.once('error', reject); control.listen(controlPath, resolve); });
    chmodSync(controlPath, 0o600);
    publish({ status: enabled ? 'connecting' : 'disabled' });
    if (enabled) ensure().catch(() => {});
    else await stopChild();
    return snapshot();
  }
  async function close() {
    stopping = true; clearTimeout(retry); retry = null;
    if (starting) await starting.catch(() => {});
    await stopChild();
    if (control) await new Promise(resolve => control.close(resolve));
  }
  return { listen, request, snapshot, close };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = createRemoteService();
  let closing = false;
  const shutdown = () => { if (!closing) { closing = true; service.close().finally(() => process.exit(0)); } };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  service.listen().catch(error => {
    console.error('[agent-terminal] Remote service: ' + error.message);
    service.close().finally(() => process.exit(1));
  });
}
