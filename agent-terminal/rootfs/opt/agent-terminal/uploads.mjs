// Files pasted, dropped or picked in the web terminal. Like the session
// controls, the stream travels through ttyd's authenticated Ingress
// connection. The browser sends a file name and the bytes, never a directory;
// the reply is the saved path, which the page pastes into the prompt.
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync,
  rmSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPLOAD_ROOT = '/data/agent-terminal/uploads';
export const MAX_BYTES = 50 * 1024 * 1024;
export const KEEP_DAYS = 7;
// A chunk is 64 KiB before base64; a line also carries the JSON around it.
const MAX_LINE = 128 * 1024;
const MAX_OPEN = 8;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Agents get the path as typed text, so keep it to characters no prompt or
// shell treats specially: no spaces, quotes, or a leading dash or dot.
export function safeName(value) {
  const base = String(value ?? '').split(/[\\/]/).pop().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const dot = base.lastIndexOf('.');
  const clean = s => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/[-.]{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  const ext = dot > 0 ? clean(base.slice(dot + 1)).replace(/\./g, '').toLowerCase().slice(0, 10) : '';
  const stem = clean(dot > 0 ? base.slice(0, dot) : base).slice(0, 80).replace(/[-.]+$/, '') || 'upload';
  return ext ? stem + '.' + ext : stem;
}

const pad = n => String(n).padStart(2, '0');
const day = date => date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());

export function createUploadStore({ root = UPLOAD_ROOT, maxBytes = MAX_BYTES, now = () => new Date() } = {}) {
  const open = new Map();
  let serial = 0;
  function find(id) {
    const upload = open.get(id);
    if (!upload) throw new Error('Unknown upload.');
    return upload;
  }
  function discard(id) {
    const upload = open.get(id);
    if (!upload) return;
    open.delete(id);
    try { closeSync(upload.fd); } catch { /* already closed */ }
    try { unlinkSync(upload.part); } catch { /* already gone */ }
  }
  function begin(name, size) {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid file size.');
    if (size > maxBytes) throw new Error('Files can be at most ' + Math.round(maxBytes / 1048576) + ' MB.');
    if (open.size >= MAX_OPEN) throw new Error('Too many uploads at once.');
    const date = now(), directory = join(root, day(date));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds()) +
      '-' + randomBytes(3).toString('hex') + '-' + safeName(name));
    const part = file + '.part';
    const id = String(++serial);
    open.set(id, { fd: openSync(part, 'wx', 0o600), file, part, size, received: 0 });
    return { upload: id };
  }
  function chunk(id, data) {
    const upload = find(id);
    if (typeof data !== 'string' || !BASE64.test(data)) { discard(id); throw new Error('Invalid file data.'); }
    const bytes = Buffer.from(data, 'base64');
    if (upload.received + bytes.length > upload.size) { discard(id); throw new Error('File is larger than announced.'); }
    writeSync(upload.fd, bytes);
    upload.received += bytes.length;
    return { received: upload.received };
  }
  function finish(id) {
    const upload = find(id);
    if (upload.received !== upload.size) { discard(id); throw new Error('File arrived incomplete.'); }
    open.delete(id);
    closeSync(upload.fd);
    renameSync(upload.part, upload.file);
    return { path: upload.file, name: upload.file.slice(upload.file.lastIndexOf('/') + 1), size: upload.size };
  }
  function cancel(id) { find(id); discard(id); return true; }
  function abortAll() { for (const id of [...open.keys()]) discard(id); }
  // Uploads are inputs for a conversation, not storage: drop whole days once
  // they are older than KEEP_DAYS.
  function prune(days = KEEP_DAYS) {
    const cutoff = now(); cutoff.setDate(cutoff.getDate() - days);
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && DAY.test(entry.name) && entry.name < day(cutoff)) {
        rmSync(join(root, entry.name), { recursive: true, force: true });
      }
    }
  }
  function request(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid request.');
    switch (input.method) {
      case 'begin': return begin(input.name, input.size);
      case 'chunk': return chunk(input.upload, input.data);
      case 'finish': return finish(input.upload);
      case 'cancel': return cancel(input.upload);
      default: throw new Error('Unknown upload operation.');
    }
  }
  return { maxBytes, begin, chunk, finish, cancel, abortAll, prune, request };
}

export function serve(store, input = process.stdin, output = process.stdout) {
  // Raw mode before anything is read: a cooked PTY echoes input back and cuts
  // lines at 4 KiB. The page waits for "ready" before it sends a request.
  if (input.isTTY) input.setRawMode(true);
  input.setEncoding('utf8');
  const send = value => output.write(JSON.stringify(value) + '\n');
  let buffer = '';
  const end = () => store.abortAll();
  input.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let request;
      try {
        request = JSON.parse(line);
        if (!Number.isSafeInteger(request?.request) || request.request < 0) throw new Error('Invalid request number.');
        send({ request: request.request, result: store.request(request) });
      } catch (error) {
        send({ request: Number.isSafeInteger(request?.request) ? request.request : null, error: error.message });
      }
    }
    if (buffer.length > MAX_LINE) { end(); input.destroy(); }
  });
  input.on('end', end);
  input.on('close', end);
  try { store.prune(); } catch { /* the next connection tries again */ }
  send({ type: 'ready', maxBytes: store.maxBytes });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, ...args] = process.argv.slice(2);
  try {
    if (operation === 'serve' && !args.length) {
      const store = createUploadStore();
      // ttyd hangs up when the page disconnects; keep no partial files.
      for (const signal of ['SIGHUP', 'SIGTERM']) process.on(signal, () => { store.abortAll(); process.exit(0); });
      serve(store);
    }
    else if (operation === 'prune' && !args.length) createUploadStore().prune();
    else throw new Error('Usage: uploads.mjs serve | prune');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
