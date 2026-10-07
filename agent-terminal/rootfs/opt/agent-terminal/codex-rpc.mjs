// Local app-server client. The privileged socket lives in Codex's reserved
// directory, which Codex hides from model-generated sandboxed commands.
import WebSocket from 'ws';

export async function connectCodex(socketPath, { timeout = 15000, connectTimeout = 1000, onNotification = () => {} } = {}) {
  const socket = new WebSocket('ws+unix:' + socketPath + ':/', { maxPayload: 16 * 1024 * 1024 });
  const pending = new Map();
  let serial = 0, closed = false;
  function fail(error) {
    closed = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }
  socket.on('error', () => fail(new Error('Codex Remote server is unavailable.')));
  socket.on('close', () => fail(new Error('Codex Remote server disconnected.')));
  socket.on('message', bytes => {
    let message;
    try { message = JSON.parse(bytes.toString()); } catch { return; }
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
    } else if (message.method) onNotification(message);
    // This client never handles approvals or agent tools. Those belong to
    // the phone or terminal that starts the turn, not this service.
  });
  function call(method, params = {}) {
    if (closed || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Codex Remote server is unavailable.'));
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        pending.delete(id); reject(new Error('Codex Remote server did not respond.'));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  const dispose = () => { fail(new Error('Codex Remote connection closed.')); socket.terminate(); };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('Codex Remote server did not become ready.')); }, connectTimeout);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', () => { clearTimeout(timer); reject(new Error('Codex Remote server is unavailable.')); });
      socket.once('close', () => { clearTimeout(timer); reject(new Error('Codex Remote server disconnected.')); });
    });
    await call('initialize', { clientInfo: { name: 'agent_terminal_remote', title: 'Agent Terminal', version: '2.10.0' },
      capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: 'initialized' }));
    return { call, dispose, get closed() { return closed; } };
  } catch (error) { dispose(); throw error; }
}
