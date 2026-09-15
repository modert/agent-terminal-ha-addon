import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// Exercise the page's real event handlers and ttyd input packets without a
// browser or a connection to the user's tmux session.
const template = readFileSync(process.env.WEBUI_TEMPLATE || resolve(
  import.meta.dirname, '../agent-terminal/rootfs/opt/webui/index.template.html'), 'utf8');
const script = [...template.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];

async function page({ touch = true, search = '' } = {}) {
  const ids = new Map(), packets = [], timers = new Map(), storage = new Map();
  let timerId = 0, terminal, socket, now = 1000;
  function element() {
    const handlers = new Map(), classes = new Set();
    return {
      children: [], attributes: {}, dataset: {}, hidden: false, style: { setProperty() {} },
      classList: {
        add: c => classes.add(c), remove: c => classes.delete(c),
        toggle: (c, on) => on ? classes.add(c) : classes.delete(c),
      },
      set id(v) { ids.set(v, this); },
      appendChild(child) { this.children.push(child); },
      setAttribute(k, v) { this.attributes[k] = v; },
      getAttribute(k) { return this.attributes[k]; },
      querySelector() { return terminal.textarea; },
      focus() { document.activeElement = this; },
      blur() { if (document.activeElement === this) document.activeElement = null; this.fire('blur'); },
      addEventListener(k, fn) {
        if (!handlers.has(k)) handlers.set(k, []);
        handlers.get(k).push(fn);
      },
      fire(k, props = {}) {
        const event = { preventDefault() {}, stopPropagation() {}, pointerId: 1, ...props };
        for (const fn of handlers.get(k) || []) fn(event);
      },
      setPointerCapture() {},
    };
  }
  const document = {
    getElementById(id) {
      if (!ids.has(id)) {
        const el = element();
        el.hidden = ['paste', 'sel', 'overlay', 'menu', 'toast'].includes(id);
        ids.set(id, el);
      }
      return ids.get(id);
    },
    createElement: element, addEventListener() {}, documentElement: element(),
  };
  class Terminal {
    constructor(options) {
      terminal = this; this.options = options; this.cols = 50; this.rows = 26;
      this.textarea = element(); this.pastes = [];
    }
    parser = { registerOscHandler() {} };
    loadAddon() {} open() {} onResize() {} onBinary() {}
    focus() { this.textarea.focus(); }
    clearSelection() {} reset() {}
    write(data, callback) { if (callback) queueMicrotask(callback); }
    paste(text) { this.pastes.push(text); }
    onData(fn) { this.type = fn; }
    attachCustomKeyEventHandler() {}
  }
  class WebSocket {
    static OPEN = 1;
    readyState = 1;
    constructor() { socket = this; }
    send(data) { packets.push(new TextDecoder().decode(data)); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  }
  const window = { innerHeight: 700, matchMedia: () => ({ matches: touch }), addEventListener() {} };
  window.top = window;
  window.getSelection = () => ({ removeAllRanges() {} });
  vm.runInNewContext(script, {
    Terminal, WebSocket, document, window, navigator: { platform: 'Linux' },
    FitAddon: { FitAddon: class { fit() {} } },
    location: { pathname: '/terminal', protocol: 'https:', host: 'example.test', search },
    TextEncoder, TextDecoder, Uint8Array, URLSearchParams,
    Date: class extends Date { static now() { return now; } },
    fetch: async () => ({ json: async () => ({ token: '' }) }),
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearInterval: id => timers.delete(id),
  });
  await new Promise(setImmediate);
  assert.ok(socket, 'page creates its ttyd connection');
  socket.onopen();
  packets.length = 0;
  const buttons = ['row1', 'row-mods', 'row2'].flatMap(id => ids.get(id).children);
  const button = label => {
    const b = buttons.find(b => b.textContent === label);
    assert.ok(b, `button ${label} exists`);
    return b;
  };
  function tap(label) {
    const b = button(label);
    b.fire('pointerdown'); b.fire('pointerup'); b.fire('click', { detail: 1 });
  }
  function input() {
    return packets.splice(0).filter(p => p.startsWith('0')).map(p => p.slice(1));
  }
  function flush() {
    for (const [id, timer] of [...timers]) {
      if (timer.ms === 0) { timers.delete(id); timer.fn(); }
    }
  }
  return { ids, button, tap, input, terminal, timers, flush, advance: ms => { now += ms; },
    socket: () => socket };
}

test('answering a Codex question is possible with the extra keys closed', async () => {
  const p = await page();
  assert.equal(p.ids.get('row2').hidden, true);
  assert.equal(p.ids.get('row1').hidden, false);
  p.tap('Answer'); p.tap('↓'); p.tap('Enter');
  assert.deepEqual(p.input(), ['\x1b[1;2D', '\x1b[B', '\r']);
});

test('Shift reaches tmux arrow keys and clears after one press', async () => {
  const p = await page();
  p.tap('Shift');
  assert.equal(p.button('Shift').attributes['aria-pressed'], 'true');
  p.tap('←'); p.tap('←');
  assert.deepEqual(p.input(), ['\x1b[1;2D', '\x1b[D']);
  assert.equal(p.button('Shift').attributes['aria-pressed'], 'false');
  p.tap('Shift'); p.tap('Ctrl'); p.tap('Alt'); p.tap('→');
  assert.deepEqual(p.input(), ['\x1b[1;8C']);
});

test('fixed actions clear pending modifiers; Enter and newline are distinct', async () => {
  const p = await page();
  for (const [label, seq] of [['Answer', '\x1b[1;2D'], ['⇧⇥', '\x1b[Z'],
    ['^C', '\x03'], ['↵', '\n'], ['tmux', '\x02']]) {
    p.tap('Ctrl'); p.tap('Alt'); p.tap('Shift'); p.tap(label); p.tap('Enter');
    assert.deepEqual(p.input(), [seq, '\r']);
  }
  p.tap('Shift'); p.tap('Enter'); p.tap('Enter');
  assert.deepEqual(p.input(), ['\n', '\r']);
});

test('typed text supports modifiers, and paste is kept intact', async () => {
  const p = await page();
  p.tap('Shift'); p.terminal.type('a');
  p.tap('Shift'); p.terminal.type(',');
  p.tap('Shift'); p.terminal.type('.');
  p.tap('Ctrl'); p.terminal.type('b');
  p.tap('Alt'); p.terminal.type('x');
  p.tap('Shift'); p.tap('⇥');
  p.tap('Ctrl'); p.terminal.type('\x1b[200~two words\x1b[201~'); p.terminal.type('c');
  assert.deepEqual(p.input(), ['A', '<', '>', '\x02', '\x1bx', '\x1b[Z',
    '\x1b[200~two words\x1b[201~', '\x03']);
});

test('More keeps Answer visible, and keyboard clicks activate only once', async () => {
  const p = await page();
  p.tap('⋯');
  assert.equal(p.ids.get('row2').hidden, false);
  assert.equal(p.button('⋯').attributes['aria-expanded'], 'true');
  p.tap('⋯');
  assert.equal(p.ids.get('row2').hidden, true);
  assert.equal(p.ids.get('row1').hidden, false);
  p.button('Answer').fire('click', { detail: 0 });
  p.tap('Enter');
  assert.deepEqual(p.input(), ['\x1b[1;2D', '\r']);
});

test('double Escape is timed and repeat stops on pointer release', async () => {
  const p = await page();
  p.tap('Esc²');
  assert.deepEqual(p.input(), ['\x1b']);
  [...p.timers.values()].find(t => t.ms === 120).fn();
  assert.deepEqual(p.input(), ['\x1b']);
  p.button('←').fire('pointerdown');
  [...p.timers.values()].find(t => t.ms === 380).fn();
  [...p.timers.values()].find(t => t.ms === 55).fn();
  p.button('←').fire('pointerup');
  assert.equal([...p.timers.values()].some(t => t.ms === 55), false);
  assert.deepEqual(p.input(), ['\x1b[D', '\x1b[D']);
});

test('mobile autocorrect replacements stay in the draft and are inserted once', async () => {
  const p = await page();
  assert.equal(p.terminal.textarea.getAttribute('inputmode'), 'none');
  p.tap('Write');
  const box = p.ids.get('paste-text');
  box.value = 'teh same text';
  box.fire('input', { inputType: 'insertText', data: 'teh same text' });
  box.fire('compositionstart');
  box.value = 'the same text';
  box.fire('input', { inputType: 'insertReplacementText', data: 'the same text' });
  box.fire('input', { inputType: 'insertReplacementText', data: 'the same text' });
  assert.deepEqual(p.input(), []);
  assert.deepEqual(p.terminal.pastes, []);
  p.advance(500);
  const insert = p.ids.get('paste-send');
  insert.fire('click'); insert.fire('click');
  assert.deepEqual(p.terminal.pastes, []);
  box.fire('compositionend');
  box.value = 'the same text.'; // final input event after compositionend
  box.fire('input', { inputType: 'insertText', data: '.' });
  p.flush(); insert.fire('click'); p.flush();
  assert.deepEqual(p.terminal.pastes, ['the same text.']);
  assert.equal(p.ids.get('paste').hidden, true);
});

test('Write keeps pasted text for editing; the original Paste action still inserts directly', async () => {
  const p = await page();
  p.tap('Write');
  const box = p.ids.get('paste-text');
  box.fire('paste', { clipboardData: { getData: () => 'hello hello' } });
  assert.deepEqual(p.terminal.pastes, []);
  box.value = 'hello hello';
  p.advance(500);
  p.ids.get('paste-send').fire('click'); p.flush();
  assert.deepEqual(p.terminal.pastes, ['hello hello']);
  p.tap('📋');
  box.fire('paste', { clipboardData: { getData: () => '/help' } });
  box.fire('paste', { clipboardData: { getData: () => '/help' } });
  assert.deepEqual(p.terminal.pastes, ['hello hello', '/help']);
});

test('IME Enter is not submitted early, Cancel sends nothing, and live typing stays available', async () => {
  const p = await page();
  p.tap('Write');
  const box = p.ids.get('paste-text');
  box.value = 'draft';
  box.fire('keydown', { key: 'Enter', ctrlKey: true, isComposing: true });
  p.flush();
  assert.deepEqual(p.terminal.pastes, []);
  p.advance(500);
  p.ids.get('paste-cancel').fire('click');
  assert.deepEqual(p.terminal.pastes, []);
  p.tap('⌨');
  assert.equal(p.terminal.textarea.getAttribute('inputmode'), 'text');
  p.terminal.type('/help');
  assert.deepEqual(p.input(), ['/help']);
  p.terminal.textarea.blur();
  assert.equal(p.terminal.textarea.getAttribute('inputmode'), 'none');
  for (const label of ['Esc', '⇥', '⇧⇥', '←', '↑', '↓', '→', '⇞', '⇟', '⋯',
    'Ctrl', 'Alt', '^C', 'Esc²', '⌫', '⇱', '⇲', 'Copy', '📋', 'A−', 'A+', '⌨']) p.button(label);
});

test('disconnecting preserves a draft instead of dropping its text', async () => {
  const p = await page();
  p.tap('Write');
  p.ids.get('paste-text').value = 'keep this draft';
  p.socket().readyState = 3;
  p.advance(500);
  p.ids.get('paste-send').fire('click'); p.flush();
  assert.equal(p.ids.get('paste').hidden, false);
  assert.equal(p.ids.get('paste-text').value, 'keep this draft');
  assert.deepEqual(p.terminal.pastes, []);
});

test('desktop and phones with the toolbar hidden retain their original keyboard', async () => {
  for (const options of [{ touch: false }, { touch: true, search: '?keys=0' }]) {
    const p = await page(options);
    assert.equal(p.ids.get('bar').hidden, true);
    assert.equal(p.terminal.textarea.getAttribute('inputmode'), undefined);
  }
});

test('switching agents cancels insertion while a phone composition is pending', async t => {
  const p = await page();
  if (!p.ids.has('agents')) return t.skip('installed version has no live session switching');
  p.tap('Write');
  const box = p.ids.get('paste-text');
  box.value = 'belongs to the original session'; box.fire('compositionstart');
  p.advance(500); p.ids.get('paste-send').fire('click');
  p.ids.get('agents').children.find(b => b.dataset.agent === 'shell').fire('click');
  await new Promise(setImmediate);
  p.socket().onopen();
  box.fire('compositionend'); p.flush();
  assert.deepEqual(p.terminal.pastes, []);
});
