import { createConnection } from 'node:net';
import { join } from 'node:path';

// Match upstream's executor-local rendezvous root, not CODEX_HOME or TMPDIR.
export const remoteRuntimeDir = () => join('/tmp', 'codex-daemon-' + process.getuid(), 'agent-terminal');

export function requestRemote(method, { socketPath = join(remoteRuntimeDir(), 'control.sock'), timeout = 45000 } = {}) {
  if (!['status', 'start', 'stop', 'pair'].includes(method)) return Promise.reject(new Error('Unknown Remote operation.'));
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '', settled = false;
    const timer = setTimeout(() => done(new Error('Remote did not respond. Reopen Phone remote to check its status.')), timeout);
    function done(error, result) {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(result);
    }
    socket.on('connect', () => socket.write(JSON.stringify({ method }) + '\n'));
    socket.on('error', () => done(new Error('Remote service is unavailable.')));
    socket.on('end', () => { if (!settled) done(new Error('Remote service disconnected.')); });
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 65536) return done(new Error('Invalid Remote response.'));
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, end));
        if (response.error) done(new Error(response.error)); else done(null, response.result);
      } catch { done(new Error('Invalid Remote response.')); }
    });
  });
}
