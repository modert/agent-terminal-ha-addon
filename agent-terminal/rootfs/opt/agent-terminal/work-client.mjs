import { createConnection } from 'node:net';
import { join } from 'node:path';
export const workRuntime = () => join('/tmp', 'codex-daemon-' + process.getuid(), 'agent-terminal-work');
export function requestWork(method, fields = {}, { socketPath = join(workRuntime(), 'control.sock'), timeout = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath); let buffer = '', settled = false;
    const timer = setTimeout(() => done(new Error('Workspace service timed out. Check the conversation before retrying.')), timeout);
    function done(error, result) { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); }
    socket.on('connect', () => socket.write(JSON.stringify({ method, ...fields }) + '\n'));
    socket.on('error', () => done(new Error('Workspace service is unavailable. Your terminal sessions remain available.')));
    socket.on('end', () => { if (!settled) done(new Error('Workspace service disconnected.')); });
    socket.on('data', chunk => {
      buffer += chunk; if (buffer.length > 4 * 1024 * 1024) return done(new Error('Workspace response is too large.'));
      const end = buffer.indexOf('\n'); if (end < 0) return;
      try { const r = JSON.parse(buffer.slice(0, end)); done(r.error ? new Error(r.error) : null, r.result); }
      catch { done(new Error('Invalid workspace response.')); }
    });
  });
}
