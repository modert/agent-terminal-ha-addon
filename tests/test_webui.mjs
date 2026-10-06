// Run the actual client script with controlled network and input timing.
// A real-browser layout check complements these reproducible race checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const template = readFileSync(new URL('../agent-terminal/rootfs/opt/webui/index.template.html', import.meta.url), 'utf8');
const webui = name => readFileSync(new URL('../agent-terminal/rootfs/opt/webui/' + name, import.meta.url), 'utf8');
const source = webui('sessions.js') + '\n' + webui('uploads.js') + '\n' + webui('health.js') + '\n' + template.split('<script>').at(-1).split('</script>')[0];
const tick = () => new Promise(resolve => setImmediate(resolve));

function client(search = '') {
  class Element {
    children = []; dataset = {}; attributes = {}; listeners = {}; hidden = true; value = '';
    style = { setProperty() {} }; classList = { add() {}, remove() {}, toggle() {} };
    appendChild(child) { this.children.push(child); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    emit(type, event = {}) { for (const callback of this.listeners[type] || []) callback({ preventDefault() {}, ...event }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    focus() {} blur() {} contains() { return false; }
    click() { this.clicks = (this.clicks || 0) + 1; }
  }
  const elements = {};
  const document = new Element();
  document.getElementById = id => elements[id] ||= new Element();
  document.createElement = () => new Element();
  document.documentElement = new Element(); document.body = new Element();
  const window = new Element();
  window.top = window.parent = window; window.innerHeight = 800; window.matchMedia = () => ({ matches: false });
  window.isSecureContext = true;                   // as Ingress serves the page
  window.getSelection = () => ({ removeAllRanges() {} });
  const location = new URL('https://example.test/api/hassio_ingress/test/' + search);
  const storage = new Map(), fetches = [], sockets = [], uploads = [], timers = new Map(), copies = [];
  const clock = { now: 1000 };
  let timerId = 0, terminal, clipboardResolve, control;
  class Terminal {
    constructor(options) { this.options = options; terminal = this; }
    cols = 100; rows = 30; output = []; pastes = []; resets = 0; selection = ''; focused = 0;
    parser = { registerOscHandler() {} };
    loadAddon() {} open() {} focus() { this.focused++; }
    // Selecting text is the page's copy trigger, so the stub keeps a selection
    // and reports it the way xterm does.
    onSelectionChange(callback) { this.selectionChanged = callback; }
    hasSelection() { return this.selection !== ''; }
    getSelection() { return this.selection; }
    clearSelection() { this.select(''); }
    select(text) { this.selection = text; this.selectionChanged?.(); }
    onResize() {} onBinary() {} attachCustomKeyEventHandler() {}
    onData(callback) { this.input = callback; }
    write(data, callback) { this.output.push(data); if (callback) queueMicrotask(callback); }
    reset() { this.resets++; }
    paste(data) { this.pastes.push(data); this.input(data); }
  }
  class WebSocket {
    static OPEN = 1;
    constructor(url) { this.url = new URL(url); this.sent = []; this.readyState = 0;
      const arg = this.url.searchParams.get('arg');
      if (arg === 'sessions') control = this; else if (arg === 'uploads') uploads.push(this); else sockets.push(this); }
    send(bytes) { this.sent.push(new TextDecoder().decode(bytes)); }
    open() { this.readyState = 1; this.onopen(); }
    close() { this.readyState = 3; this.onclose?.(); }
    output(text) { this.onmessage({ data: '0' + text }); }
  }
  vm.runInNewContext(source, { document, window, location, Terminal, WebSocket,
    TextEncoder, TextDecoder, URLSearchParams, Uint8Array, Promise, Blob, File, btoa,
    Date: class extends Date { static now() { return clock.now; } },
    FitAddon: { FitAddon: class { fit() {} } },
    navigator: { platform: 'Linux', clipboard: {
      readText: () => new Promise(resolve => { clipboardResolve = resolve; }),
      writeText: text => { copies.push(text); return Promise.resolve(); },
    } },
    history: { replaceState(_state, _title, url) { location.href = new URL(url, location).href; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    fetch: () => new Promise(resolve => fetches.push(() => resolve({ json: async () => ({ token: '' }) }))),
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    setInterval: callback => { timers.set(++timerId, callback); return timerId; },
    clearInterval: id => timers.delete(id),
  });
  const select = agent => elements.agents.children.find(b => b.dataset.agent === agent).emit('click');
  return { elements, document, window, location, fetches, sockets, uploads, terminal, timers, select, copies, clock, control: () => control,
    resolveClipboard: text => clipboardResolve(text),
    settle: () => { const id = [...timers.keys()].at(-1); const callback = timers.get(id); timers.delete(id); callback(); },
    // tmux draws the session as soon as it attaches; keys wait for that.
    async connect(index = fetches.length - 1) { fetches[index](); await tick(); sockets.at(-1).open(); sockets.at(-1).output(''); },
  };
}

test('latest selection wins while token requests and old sockets complete out of order', async () => {
  const c = client('?keys=1');
  await tick();
  c.select('codex'); await tick();
  await c.connect(1);
  assert.deepEqual(c.sockets[0].url.searchParams.getAll('arg'), ['codex', 'homeassistant']);
  assert.equal(c.sockets[0].url.searchParams.get('keys'), '1');
  c.fetches[0](); await tick();
  assert.equal(c.sockets.length, 1, 'stale token response must not create a connection');
  const old = c.sockets[0];
  c.select('shell'); await tick(); await c.connect(2);
  const outputCount = c.terminal.output.length;
  old.output('wrong conversation'); old.onopen(); old.onclose();
  assert.equal(c.terminal.output.length, outputCount, 'late output must be ignored');
  c.terminal.input('shell input');
  assert.equal(c.sockets[1].sent.at(-1), '0shell input');
  assert.equal(old.sent.includes('0shell input'), false);
  assert.equal(c.elements.agents.children[2].attributes['aria-pressed'], 'true');
});

test('named session URLs survive reload and remote stops cancel every terminal reconnect', async () => {
  const id = 'session-' + 'a'.repeat(32);
  const c = client('?arg=codex&arg=homeassistant&arg=' + id);
  await tick(); await c.connect();
  assert.deepEqual(c.sockets[0].url.searchParams.getAll('arg'), ['codex', 'homeassistant', id]);
  const control = c.control(); control.open();
  const snapshot = stopped => JSON.stringify({ type: 'sessions',
    agents: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'ChatGPT' }, { id: 'shell', name: 'Shell' }],
    workspaces: [{ id: 'homeassistant', name: 'Home Assistant', directory: '/homeassistant' }],
    sessions: [{ id, name: 'Dashboard refresh', agent: 'codex', workspace: 'homeassistant', stopped, running: !stopped }] }) + '\n';
  control.output(snapshot(false));
  assert.equal(c.elements['sessions-open'].textContent, 'Dashboard refresh');
  control.output(snapshot(true));
  assert.equal(c.sockets[0].readyState, 3);
  assert.match(c.elements['overlay-msg'].textContent, /Session stopped/);
  const requests = c.fetches.length;
  c.sockets[0].onclose(); c.window.emit('online'); await tick();
  assert.equal(c.fetches.length, requests, 'a stopped session cannot auto-reconnect');
  control.output(snapshot(false)); await tick();
  assert.equal(c.fetches.length, requests + 1, 'an explicit start observed from another browser reconnects');
  await c.connect();
  assert.deepEqual(c.sockets.at(-1).url.searchParams.getAll('arg'), ['codex', 'homeassistant', id]);
});

test('shortcuts change agents and delayed clipboard input stays with its original session', async () => {
  const c = client(); await tick(); await c.connect();
  c.elements['keys-tools'].children.find(b => b.textContent === 'Paste').emit('click', { detail: 1 });
  let prevented = false, stopped = false;
  c.window.emit('keydown', { code: 'Digit2', key: '@', ctrlKey: true, shiftKey: true,
    preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
  await tick(); await c.connect();
  c.resolveClipboard('belongs to Claude'); await tick();
  assert.equal(prevented && stopped, true);
  assert.deepEqual(c.terminal.pastes, []);
  assert.equal(c.sockets.at(-1).url.searchParams.get('arg'), 'codex');
});

test('switching cancels a pending reconnect and validates saved URL selections', async () => {
  const c = client('?arg=bad-command&arg=../../data&keys=0');
  await tick(); await c.connect();
  assert.deepEqual(c.sockets[0].url.searchParams.getAll('arg'), ['claude', 'homeassistant']);
  c.sockets[0].close();
  const reconnectTimer = [...c.timers.keys()].at(-1);
  c.select('shell');
  assert.equal(c.timers.has(reconnectTimer), false);
  await tick(); await c.connect();
  assert.equal(c.location.searchParams.get('keys'), '0');
  assert.equal(c.sockets.length, 2);
});

test('selecting text copies it once, with no key press', async () => {
  const c = client(); await tick(); await c.connect();
  // A selection no mouse release completes (Select all, a drag off the page)
  // still copies, from the settle timer.
  c.terminal.select('ABCD-EF123');
  c.settle(); await tick();
  assert.deepEqual(c.copies, ['ABCD-EF123']);
  c.window.emit('mouseup'); await tick();
  assert.deepEqual(c.copies, ['ABCD-EF123'], 'one selection copies once');

  // A drag copies on release, before any timer runs.
  c.terminal.select('second selection');
  c.window.emit('mouseup'); await tick();
  assert.deepEqual(c.copies, ['ABCD-EF123', 'second selection']);

  // Clearing the selection copies nothing, and the same text can be selected
  // again afterwards.
  c.terminal.clearSelection();
  c.window.emit('mouseup'); await tick();
  assert.deepEqual(c.copies, ['ABCD-EF123', 'second selection']);
  c.terminal.select('second selection');
  c.window.emit('mouseup'); await tick();
  assert.deepEqual(c.copies, ['ABCD-EF123', 'second selection', 'second selection']);
});

test('coming back to the page reconnects at once instead of waiting out the backoff', async () => {
  const c = client(); await tick(); await c.connect();
  c.sockets[0].close();
  const waiting = c.fetches.length;
  c.document.hidden = true;
  c.document.emit('visibilitychange'); await tick();
  assert.equal(c.fetches.length, waiting, 'a page in the background keeps waiting');
  c.document.hidden = false;
  c.document.emit('visibilitychange'); await tick();
  assert.equal(c.fetches.length, waiting + 1, 'a visible page starts a new connection right away');
  await c.connect();
  c.document.emit('visibilitychange'); await tick();
  assert.equal(c.fetches.length, waiting + 1, 'a live connection is left alone');
  c.sockets.at(-1).close();
  c.window.emit('online'); await tick();
  assert.equal(c.fetches.length, waiting + 2, 'so is coming back online');
});

test('keys typed while a session connects wait for tmux, arrive once and in order, and never reach another session', async () => {
  const c = client(); await tick();
  c.document.hidden = false;                             // a visible page reconnects when asked
  c.terminal.input('git');                               // "Connecting…": there is no socket yet
  c.fetches[0](); await tick();
  const claude = c.sockets[0]; claude.open();
  c.terminal.input(' status'); c.terminal.input('\r');
  assert.equal(claude.sent.length, 1, 'only the handshake: ttyd\'s terminal is in line mode until tmux attaches');
  assert.ok(c.terminal.output.includes('\x1b[?2004h'), 'a paste made meanwhile is bracketed');
  claude.output('tmux draws the session');
  assert.equal(claude.sent.at(-1), '0git status\r');
  c.terminal.input('y');
  assert.equal(claude.sent.at(-1), '0y', 'an attached session is typed into directly');

  claude.close(); c.window.emit('online'); await tick();
  c.terminal.input('typed for Claude');
  c.select('codex'); await tick(); await c.connect();
  const codex = c.sockets.at(-1);
  assert.equal(codex.sent.length, 1, 'keys held for the session being left are dropped');

  codex.close(); c.window.emit('online'); await tick();
  c.terminal.input('rm -rf build'); c.terminal.input('\r');
  c.clock.now += 11000;
  await c.connect();
  assert.equal(c.sockets.at(-1).sent.length, 1, 'an Enter that waited through a long disconnect must not land late');
  assert.equal(c.elements.toast.textContent, 'Keys typed while disconnected were not sent');
});

test('a split pane whose connection opens leaves the keyboard with the pane being typed in', async () => {
  const c = client(); await tick(); await c.connect();
  assert.equal(c.terminal.focused, 1, 'a single pane takes the keyboard when it connects');
  c.document.hidden = false;
  c.window.innerWidth = 1400;
  c.elements['split-toggle'].emit('click');
  const frame = c.document.body.children.find(child => child.id === 'side-terminal');
  assert.ok(frame, 'the second pane opened');
  const reconnect = async () => { c.sockets.at(-1).close(); c.window.emit('online'); await tick(); await c.connect(); };
  c.document.activeElement = frame;                      // typing in the right pane
  await reconnect();
  assert.equal(c.terminal.focused, 1, 'the left pane reconnecting does not take the keyboard back');
  c.document.activeElement = null;
  await reconnect();
  assert.equal(c.terminal.focused, 2);

  const side = client('?pane=side&arg=codex&arg=homeassistant'); await tick();
  side.document.hidden = false;
  side.document.hasFocus = () => false;                  // the left pane is being typed in
  await side.connect();
  assert.equal(side.terminal.focused, 0, 'the right pane loading or reconnecting does not take it either');
  side.document.hasFocus = () => true;
  side.sockets[0].close(); side.window.emit('online'); await tick(); await side.connect();
  assert.equal(side.terminal.focused, 1);
});

async function until(check, message) {
  for (let i = 0; i < 200 && !check(); i++) await tick();
  assert.ok(check(), message);
}
// Plays the add-on's upload receiver behind ttyd: says it is ready, then
// answers each request as it arrives, as the client waits for every reply.
async function receiver(c, handlers = {}) {
  const before = c.uploads.length;
  await until(() => c.fetches.length > 1, 'the upload never asked for a token');
  c.fetches.at(-1)();
  await until(() => c.uploads.length > before, 'no upload connection opened');
  const socket = c.uploads.at(-1);
  assert.deepEqual(socket.url.searchParams.getAll('arg'), ['uploads']);
  socket.open();
  assert.match(socket.sent[0], /^\{"AuthToken"/, 'ttyd handshake comes first');
  assert.equal(socket.sent.length, 1, 'nothing is sent before the receiver is ready');
  socket.output(JSON.stringify({ type: 'ready', maxBytes: 1048576 }) + '\n');
  const files = new Map(), saved = [], requests = [];
  let serial = 0, index = 1, idle = 0;
  const defaults = {
    begin: r => { const id = String(++serial); files.set(id, { name: r.name, size: r.size, data: [] }); return { upload: id }; },
    chunk: r => { files.get(r.upload).data.push(Buffer.from(r.data, 'base64')); return { received: 0 }; },
    finish: r => {
      const file = files.get(r.upload), path = '/data/agent-terminal/uploads/2026-10-02/153012-abc123-' + file.name;
      saved.push({ path, bytes: Buffer.concat(file.data), chunks: file.data.length });
      return { path, name: path.split('/').pop(), size: file.size };
    },
    cancel: () => true,
  };
  while (idle < 50) {
    await tick();
    if (index >= socket.sent.length) { idle++; continue; }
    idle = 0;
    const text = socket.sent[index++];
    assert.equal(text[0], '0'); assert.ok(text.endsWith('\n'), 'one request per line');
    const request = JSON.parse(text.slice(1));
    requests.push(request);
    let reply;
    try { reply = { request: request.request, result: (handlers[request.method] || defaults[request.method])(request, defaults) }; }
    catch (error) { reply = { request: request.request, error: error.message }; }
    socket.output(JSON.stringify(reply) + '\n');
  }
  return { socket, saved, requests };
}
function paste(c, files, text = '') {
  const event = { clipboardData: { files, getData: () => text }, prevented: false, stopped: false,
    preventDefault() { event.prevented = true; }, stopPropagation() { event.stopped = true; } };
  c.document.emit('paste', event);
  return event;
}

test('a pasted screenshot uploads in acknowledged chunks and its path goes into the prompt', async () => {
  const c = client(); await tick(); await c.connect();
  const bytes = Buffer.from(Array.from({ length: 150000 }, (_, i) => i % 251));
  const event = paste(c, [new File([bytes], 'image.png', { type: 'image/png' })]);
  assert.equal(event.prevented && event.stopped, true, 'xterm must not also paste the empty text');
  const { socket, saved, requests } = await receiver(c);
  assert.deepEqual(requests.map(r => r.method), ['begin', 'chunk', 'chunk', 'chunk', 'finish']);
  assert.deepEqual(requests[0], { request: 1, method: 'begin', name: 'image.png', size: 150000 });
  assert.deepEqual(saved[0].bytes, bytes, 'chunks reassemble to the original file');
  assert.deepEqual(c.terminal.pastes, [saved[0].path], 'the path is pasted on its own');
  assert.deepEqual(c.sockets[0].sent.slice(-2), ['0' + saved[0].path, '0 ']);
  assert.equal(socket.readyState, 3, 'the receiver only runs while uploading');
  assert.equal(c.elements.toast.textContent, 'Attached 153012-abc123-image.png');
});

test('copied cells paste as text despite their picture; a file copied with its name attaches', async () => {
  const c = client(); await tick(); await c.connect();
  const fetches = c.fetches.length;
  const cells = paste(c, [new File(['png'], 'image.png', { type: 'image/png' })], 'Kitchen\t21.5\n');
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(cells.prevented, false, 'xterm pastes the text as usual');
  assert.equal(c.fetches.length, fetches, 'no upload starts');
  const copied = paste(c, [new File(['%PDF'], 'report.pdf', { type: 'application/pdf' })], 'report.pdf');
  assert.equal(copied.prevented, true);
  const { saved } = await receiver(c);
  assert.deepEqual(c.terminal.pastes, [saved[0].path]);
  assert.equal(saved[0].bytes.toString(), '%PDF');
});

test('a file that finishes after switching sessions is never typed into the new one', async () => {
  const c = client(); await tick(); await c.connect();
  paste(c, [new File(['notes'], 'notes.txt', { type: 'text/plain' })]);
  const terminal = c.sockets[0];
  await receiver(c, { finish(request, defaults) { c.select('codex'); return defaults.finish(request); } });
  assert.deepEqual(c.terminal.pastes, []);
  assert.equal(terminal.sent.some(text => text.includes('notes.txt')), false);
  assert.match(c.elements.toast.textContent, /^Saved \/data\/agent-terminal\/uploads\/.*notes\.txt - not inserted: the session changed$/);
});

test('dropped files go one at a time; a failed one is cancelled and the next still attaches', async () => {
  const c = client(); await tick(); await c.connect();
  const toasts = [];
  Object.defineProperty(c.elements.toast, 'textContent', { set(value) { toasts.push(value); }, get() { return toasts.at(-1); } });
  let prevented = false;
  c.window.emit('drop', { preventDefault() { prevented = true; }, dataTransfer: { types: ['Files'],
    files: [new File(['x'.repeat(10)], 'broken.bin'), new File(['fine'], 'fine.txt', { type: 'text/plain' })] } });
  assert.equal(prevented, true, 'the browser must not open the dropped file');
  const { requests, saved } = await receiver(c, { chunk(request, defaults) {
    if (request.upload === '1') throw new Error('File is larger than announced.');
    return defaults.chunk(request);
  } });
  assert.deepEqual(requests.map(r => r.method + (r.upload ? ':' + r.upload : '')),
    ['begin', 'chunk:1', 'cancel:1', 'begin', 'chunk:2', 'finish:2']);
  assert.ok(toasts.includes('Could not attach broken.bin: File is larger than announced.'));
  assert.deepEqual(c.terminal.pastes, [saved[0].path]);
  assert.equal(toasts.at(-1), 'Attached 153012-abc123-fine.txt');
});

test('Attach opens the file picker from the keys and the draft, and a pick uploads', async () => {
  const c = client(); await tick(); await c.connect();
  const input = c.elements['upload-input'];
  c.elements['keys-tools'].children.find(b => b.textContent === 'Attach').emit('click', { detail: 1 });
  assert.equal(input.clicks, 1);
  c.elements['paste-attach'].emit('click', { detail: 1 });
  assert.equal(input.clicks, 2);
  input.files = [new File(['csv'], 'energy.csv', { type: 'text/csv' })];
  input.emit('change');
  assert.equal(input.value, '', 'the same file can be picked again');
  const { saved } = await receiver(c);
  assert.deepEqual(c.terminal.pastes, [saved[0].path]);
});

test('Enter pressed while a file uploads waits for it; a failed upload leaves the prompt unsent', async () => {
  const c = client(); await tick(); await c.connect();
  const terminal = c.sockets[0];
  paste(c, [new File(['png'], 'shot.png', { type: 'image/png' })]);
  c.terminal.input('what is wrong here?'); c.terminal.input('\r'); c.terminal.input('x');
  assert.equal(terminal.sent.at(-1), '0what is wrong here?', 'text is typed at once; Enter and what follows it wait');
  const { saved } = await receiver(c);
  assert.deepEqual(terminal.sent.slice(-3), ['0' + saved[0].path, '0 ', '0\rx'], 'the path goes in ahead of the Enter');

  const fetched = c.fetches.length;
  paste(c, [new File(['x'.repeat(10)], 'broken.bin')]);
  c.terminal.input('\r');
  const sent = terminal.sent.length;
  await until(() => c.fetches.length > fetched, 'the second upload never asked for a token');
  await receiver(c, { chunk() { throw new Error('File is larger than announced.'); } });
  assert.equal(terminal.sent.length, sent, 'a prompt is not sent without its file');
  assert.equal(c.elements.toast.textContent, 'Could not attach broken.bin: File is larger than announced. - prompt not sent');
  c.terminal.input('\r');
  assert.equal(terminal.sent.at(-1), '0\r', 'the next Enter sends as usual');
});
