// Run the actual client script with controlled network and input timing.
// A real-browser layout check complements these reproducible race checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const template = readFileSync(new URL('../agent-terminal/rootfs/opt/webui/index.template.html', import.meta.url), 'utf8');
const source = template.split('<script>').at(-1).split('</script>')[0];
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
    focus() {} blur() {} contains() { return false; }
  }
  const elements = {};
  const document = new Element();
  document.getElementById = id => elements[id] ||= new Element();
  document.createElement = () => new Element();
  document.documentElement = new Element(); document.body = new Element();
  const window = new Element();
  window.top = window; window.innerHeight = 800; window.matchMedia = () => ({ matches: false });
  window.getSelection = () => ({ removeAllRanges() {} });
  const location = new URL('https://example.test/api/hassio_ingress/test/' + search);
  const storage = new Map(), fetches = [], sockets = [], timers = new Map();
  let timerId = 0, terminal, clipboardResolve;
  class Terminal {
    constructor(options) { this.options = options; terminal = this; }
    cols = 100; rows = 30; output = []; pastes = []; resets = 0;
    parser = { registerOscHandler() {} };
    loadAddon() {} open() {} focus() {} clearSelection() {}
    onResize() {} onBinary() {} attachCustomKeyEventHandler() {}
    onData(callback) { this.input = callback; }
    write(data, callback) { this.output.push(data); if (callback) queueMicrotask(callback); }
    reset() { this.resets++; }
    paste(data) { this.pastes.push(data); this.input(data); }
  }
  class WebSocket {
    static OPEN = 1;
    constructor(url) { this.url = new URL(url); this.sent = []; this.readyState = 0; sockets.push(this); }
    send(bytes) { this.sent.push(new TextDecoder().decode(bytes)); }
    open() { this.readyState = 1; this.onopen(); }
    close() { this.readyState = 3; this.onclose?.(); }
    output(text) { this.onmessage({ data: '0' + text }); }
  }
  vm.runInNewContext(source, { document, window, location, Terminal, WebSocket,
    TextEncoder, TextDecoder, URLSearchParams, Uint8Array, Promise,
    FitAddon: { FitAddon: class { fit() {} } },
    navigator: { platform: 'Linux', clipboard: { readText: () => new Promise(resolve => { clipboardResolve = resolve; }) } },
    history: { replaceState(_state, _title, url) { location.href = new URL(url, location).href; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    fetch: () => new Promise(resolve => fetches.push(() => resolve({ json: async () => ({ token: '' }) }))),
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    setInterval: callback => { timers.set(++timerId, callback); return timerId; },
    clearInterval: id => timers.delete(id),
  });
  const select = agent => elements.agents.children.find(b => b.dataset.agent === agent).emit('click');
  return { elements, window, location, fetches, sockets, terminal, timers, select,
    resolveClipboard: text => clipboardResolve(text),
    async connect(index = fetches.length - 1) { fetches[index](); await tick(); sockets.at(-1).open(); },
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

test('shortcuts change agents and delayed clipboard input stays with its original session', async () => {
  const c = client(); await tick(); await c.connect();
  c.elements.row2.children.find(b => b.textContent === '📋').emit('pointerdown');
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
