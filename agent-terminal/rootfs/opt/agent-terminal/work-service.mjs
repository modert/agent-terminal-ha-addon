import { createServer } from 'node:net';
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexProvider, createClaudeProvider, validThread, UUID } from './work-providers.mjs';
import { workRuntime, requestWork } from './work-client.mjs';
import { createWorkspaceStore } from './workspaces.mjs';

export function createWorkService({ runtime = workRuntime(), stateDir = '/data/agent-terminal', providers, workspaces = createWorkspaceStore(), home = '/data' } = {}) {
  const freshPath = join(stateDir, 'work-conversations.json');
  const fresh = existsSync(freshPath) ? JSON.parse(readFileSync(freshPath, 'utf8')) : [];
  function remember(row) {
    const at = fresh.findIndex(r => r.id === row.id && r.provider === row.provider); if (at < 0) fresh.push(row); else fresh[at] = row;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 }); const tmp = freshPath + '.tmp'; writeFileSync(tmp, JSON.stringify(fresh), { mode: 0o600 }); renameSync(tmp, freshPath);
  }
  providers ||= {
    codex: createCodexProvider({ provider: 'codex', home: join(home, 'codex'), runtime }),
    ollama: createCodexProvider({ provider: 'ollama', home: join(home, 'ollama/codex'), runtime }),
    claude: createClaudeProvider({ home: join(home, 'claude/.claude'), onNew: remember }),
  };
  for (const row of fresh) providers[row.provider]?.restore?.(row);
  const sent = new Map(), locks = new Map(); let catalog = null, catalogAt = 0, listing = null;
  async function list(force = false) {
    if (catalog && !force && Date.now() - catalogAt < 10000) return catalog;
    if (listing) return listing;
    listing = (async () => {
      const result = { threads: [], errors: [] };
      await Promise.all(Object.entries(providers).map(async ([name, p]) => {
        try { result.threads.push(...await p.list()); } catch (error) { result.errors.push({ provider: name, message: error.message }); }
      }));
      catalog = result; catalogAt = Date.now(); return result;
    })().finally(() => { listing = null; }); return listing;
  }
  async function request(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid workspace request.');
    if (input.method === 'list') return list(input.force === true);
    const p = providers[input.provider]; if (!p) throw new Error('This provider uses the embedded terminal.');
    if (input.method === 'models') return p.models ? p.models() : [];
    if (input.method === 'create') {
      const cwd = workspaces.get(input.workspace).directory;
      if (input.model !== undefined && (typeof input.model !== 'string' || input.model.length > 150)) throw new Error('Invalid model.');
      const row = await p.create(cwd, input.model); remember(row); catalogAt = 0; return row;
    }
    const id = validThread(input.thread);
    if (input.method === 'history') {
      if (input.cursor !== undefined && input.cursor !== null && (typeof input.cursor !== 'string' || input.cursor.length > 4000)) throw new Error('Invalid history cursor.');
      return p.history(id, input.cursor);
    }
    if (input.method === 'send') {
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16000 || /\x00/.test(input.text)) throw new Error('Message must contain 1–16000 characters.');
      if (!UUID.test(input.messageId || '')) throw new Error('Invalid message identifier.');
      if (input.model !== undefined && (typeof input.model !== 'string' || input.model.length > 150)) throw new Error('Invalid model.');
      if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length > 10)) throw new Error('Attach at most 10 files.');
      const attachments = []; let text = input.text;
      for (const entry of input.attachments || []) {
        if (typeof entry !== 'string') throw new Error('Invalid attachment.');
        const root = realpathSync(join(stateDir, 'uploads')), path = realpathSync(entry);
        if (!path.startsWith(root + sep) || !statSync(path).isFile()) throw new Error('Only uploaded files can be attached.');
        const extension = /\.(png|jpe?g|gif|webp)$/i.exec(path)?.[1].toLowerCase();
        if (extension) {
          if (statSync(path).size > 5 * 1024 * 1024) throw new Error('Images must be 5 MB or smaller.');
          attachments.push({ path, mime: 'image/' + (extension === 'jpg' ? 'jpeg' : extension), ...(input.provider === 'claude' ? { data: readFileSync(path).toString('base64') } : {}) });
        } else text += '\n\nAttached file: ' + path;
      }
      const key = input.provider + ':' + id + ':' + input.messageId;
      if (sent.has(key)) return sent.get(key);
      const conversationKey = input.provider + ':' + id;
      // Serialize submissions without blocking unrelated conversations.
      const previous = locks.get(conversationKey) || Promise.resolve();
      const promise = previous.catch(() => {}).then(() => p.send(id, text, input.messageId, input.model, attachments));
      locks.set(conversationKey, promise); sent.set(key, promise);
      promise.finally(() => { if (locks.get(conversationKey) === promise) locks.delete(conversationKey); }).catch(() => {});
      if (sent.size > 1000) sent.delete(sent.keys().next().value);
      return promise;
    }
    if (input.method === 'interrupt') return p.interrupt(id);
    if (input.method === 'respond') return p.respond(id, input.requestId, input.answer || {});
    if (input.method === 'inspect') return p.inspect(id);
    if (input.method === 'file') {
      if (typeof input.path !== 'string' || input.path.length > 4096) throw new Error('Invalid file path.');
      const history = await p.history(id), root = realpathSync(history.cwd);
      const path = realpathSync(resolve(root, input.path));
      if (path !== root && !path.startsWith(root + sep)) throw new Error('Only files within this conversation’s project can be previewed.');
      const stat = statSync(path); if (!stat.isFile() || stat.size > 512 * 1024) throw new Error('Preview supports files up to 512 KB. Inspect larger files in the terminal.');
      const data = readFileSync(path);
      const imageType = /\.(png|jpe?g|webp|gif)$/i.exec(path)?.[1].toLowerCase();
      if (imageType) return { path: input.path, mime: 'image/' + (imageType === 'jpg' ? 'jpeg' : imageType), data: data.toString('base64') };
      if (data.includes(0)) throw new Error('This binary file cannot be previewed.');
      return { path: input.path, text: data.toString('utf8') };
    }
    throw new Error('Unknown workspace operation.');
  }
  let server;
  async function listen() {
    mkdirSync(runtime, { recursive: true, mode: 0o700 }); chmodSync(runtime, 0o700);
    const socketPath = join(runtime, 'control.sock');
    if (existsSync(socketPath)) {
      try { await requestWork('list', {}, { socketPath, timeout: 1000 }); throw new Error('Workspace service already running.'); }
      catch (e) { if (/already running|timed out/.test(e.message)) throw e; unlinkSync(socketPath); }
    }
    server = createServer(socket => {
      let buffer = '', used = false; socket.setEncoding('utf8'); socket.setTimeout(60000, () => socket.destroy()); socket.on('error', () => {});
      socket.on('data', chunk => {
        if (used) return; buffer += chunk; if (buffer.length > 65536) return socket.destroy();
        const end = buffer.indexOf('\n'); if (end < 0) return; used = true;
        let input; try { input = JSON.parse(buffer.slice(0, end)); } catch { socket.end(JSON.stringify({ error: 'Invalid request.' }) + '\n'); return; }
        Promise.resolve().then(() => request(input)).then(result => socket.end(JSON.stringify({ result }) + '\n'), error => socket.end(JSON.stringify({ error: error.message }) + '\n'));
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); }); chmodSync(socketPath, 0o600);
  }
  async function close() { for (const p of Object.values(providers)) await p.close(); if (server) await new Promise(r => server.close(r)); }
  return { request, listen, close };
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.env.CLAUDE_CONFIG_DIR ||= '/data/claude/.claude';
  const service = createWorkService();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close().finally(() => process.exit(0)));
  service.listen().catch(error => { console.error(error.message); process.exitCode = 1; });
}
