import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

// Opt in with CHROMIUM_BIN and WEBUI_BUNDLE. The real bundled xterm runs in
// Chromium, but its ttyd transport is replaced before any page code executes.
// No test input can reach an agent or tmux process.
test('phone taps and composition with real browser events and xterm', {
  skip: !process.env.CHROMIUM_BIN,
  timeout: 30000,
}, async t => {
  const bundle = process.env.WEBUI_BUNDLE || resolve(import.meta.dirname,
    '../agent-terminal/rootfs/opt/webui/index.html');
  const mock = `<script>
    window.testPackets = []; window.testFocus = [];
    document.addEventListener('focusin', e => {
      window.testFocus.push({ id: e.target.id, active: navigator.userActivation.isActive });
    });
    window.fetch = async () => ({ json: async () => ({ token: '' }) });
    window.WebSocket = class {
      static OPEN = 1;
      readyState = 1;
      constructor() { window.testSocket = this; setTimeout(() => this.onopen(), 0); }
      send(data) { window.testPackets.push(new TextDecoder().decode(data)); }
      close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    };
  </script>`;
  const html = readFileSync(bundle, 'utf8').replace('<head>', '<head>' + mock)
    .replace('term.open(termEl);', 'term.open(termEl); window.testTerminal = term;');
  assert.ok(!html.includes('/*{{XTERM_JS}}*/'), 'build the web UI before running the browser test');
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = mkdtempSync(join(tmpdir(), 'agent-terminal-browser-'));
  const browser = spawn(process.env.CHROMIUM_BIN, [
    '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '', buffer = '', nextId = 0, session;
  const pending = new Map();
  browser.stderr.on('data', chunk => { stderr += chunk; });
  browser.on('error', error => { for (const p of pending.values()) p.reject(error); });
  browser.on('exit', () => {
    for (const p of pending.values()) p.reject(new Error('Chromium exited: ' + stderr));
    pending.clear();
  });
  t.after(async () => {
    if (browser.exitCode === null) {
      const exit = once(browser, 'exit');
      browser.kill('SIGTERM');
      await exit;
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  browser.stdio[4].on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const p = pending.get(message.id);
      if (!p) continue;
      pending.delete(message.id);
      if (message.error) p.reject(new Error(JSON.stringify(message.error)));
      else p.resolve(message.result);
    }
  });
  function command(method, params = {}, sessionId = session) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function until(expression) {
    for (let n = 0; n < 100; n++) {
      if (await evaluate(expression)) return;
      await delay(20);
    }
    assert.fail('Timed out: ' + expression);
  }
  async function touch(type, x, y) {
    await command('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y }],
    });
  }
  async function tap(expression) {
    const rect = await evaluate(`(() => {
      const r = (${expression}).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await touch('touchStart', rect.x, rect.y);
    await touch('touchEnd');
  }
  async function enter(modifiers = 0) {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter',
      text: '\r', windowsVirtualKeyCode: 13, modifiers });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, modifiers });
  }
  const button = label => `[...document.querySelectorAll('#bar button')].find(b => b.textContent === ${JSON.stringify(label)})`;
  const target = await command('Target.createTarget', { url: 'about:blank' });
  session = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  async function load(search = '') {
    await command('Page.navigate', { url: origin + '/' + search });
    await until("!!document.querySelector('#row1 button') && window.testSocket?.onmessage && document.getElementById('overlay').hidden");
    await evaluate(`window.testPackets = []; window.testFocus = [];
      window.testSocket.onmessage({ data: new TextEncoder().encode('0\\x1b[?2004h').buffer });`);
    await delay(30);
  }
  async function packets() {
    return evaluate("window.testPackets.filter(p => p.startsWith('0')).map(p => p.slice(1))");
  }
  await load();
  assert.equal(await evaluate("matchMedia('(pointer: coarse)').matches"), true);
  if (process.env.WEBUI_SCREENSHOT) {
    const screenshot = await command('Page.captureScreenshot');
    writeFileSync(process.env.WEBUI_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
  await tap(button('Write'));
  await until("document.activeElement.id === 'paste-text'");
  assert.equal(await evaluate("window.testFocus.find(f => f.id === 'paste-text').active"), true,
    'keyboard focus must occur during a browser-authorized touch gesture');
  assert.equal(await evaluate("Math.min(...[...document.querySelectorAll('#row1 button, #row-mods button')].map(b => b.getBoundingClientRect().height)) >= 44"), true);
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 440, deviceScaleFactor: 1, mobile: true });
  await until('window.innerHeight === 440');
  await delay(100);
  assert.equal(await evaluate(`(() => {
    const terminal = document.getElementById('term').getBoundingClientRect();
    const draft = document.getElementById('paste').getBoundingClientRect();
    return terminal.height > 100 && terminal.bottom <= draft.top && draft.height <= 80 &&
      document.elementFromPoint(terminal.x + 30, terminal.y + 30).closest('#term') !== null;
  })()`), true, 'the draft must leave terminal output visible above the phone keyboard');
  await evaluate(`testSocket.onmessage({ data: new TextEncoder().encode('0' +
    Array.from({ length: 100 }, (_, i) => 'Response line ' + (i + 1) + '\\r\\n').join('')).buffer })`);
  await until('testTerminal.buffer.active.baseY > 50');
  const scroll = await evaluate(`({ y: testTerminal.buffer.active.viewportY,
    top: document.getElementById('term').getBoundingClientRect().top })`);
  await touch('touchStart', 100, scroll.top + 20);
  await touch('touchMove', 100, scroll.top + 80);
  await touch('touchEnd');
  await until('testTerminal.buffer.active.viewportY < ' + scroll.y);
  assert.equal(await evaluate("document.activeElement.id === 'paste-text'"), true, 'scrolling must keep the editor and keyboard focused');

  // Use Chromium's IME API, then select and replace the corrected word twice.
  await command('Input.imeSetComposition', { text: 'teh', selectionStart: 3, selectionEnd: 3 });
  await command('Input.insertText', { text: 'the' });
  await command('Input.insertText', { text: ' hello hello' });
  for (let i = 0; i < 2; i++) {
    await evaluate("document.getElementById('paste-text').setSelectionRange(0, 3)");
    await command('Input.insertText', { text: 'the' });
  }
  assert.equal(await evaluate("document.getElementById('paste-text').value"), 'the hello hello');
  assert.deepEqual(await packets(), [], 'correction edits must not reach the terminal');
  if (process.env.WEBUI_SCREENSHOT) {
    const screenshot = await command('Page.captureScreenshot');
    writeFileSync(process.env.WEBUI_SCREENSHOT.replace('.png', '-response.png'), Buffer.from(screenshot.data, 'base64'));
  }
  await tap("document.getElementById('paste-send')");
  await until("document.getElementById('paste').hidden");
  assert.deepEqual(await packets(), ['\x1b[200~the hello hello\x1b[201~', '\r'], 'send only the final draft once, then submit');
  await evaluate("window.previousEditor = document.getElementById('paste-text')");
  await tap(button('Write'));
  assert.equal(await evaluate("previousEditor !== document.getElementById('paste-text')"), true);
  assert.equal(await evaluate("document.getElementById('paste-text').getAttribute('autocorrect')"), 'on');
  assert.equal(await evaluate("document.getElementById('paste-text').value"), '');
  await command('Input.imeSetComposition', { text: 'second', selectionStart: 6, selectionEnd: 6 });
  await evaluate("previousEditor.dispatchEvent(new CompositionEvent('compositionend', { data: 'old text' }))");
  await command('Input.insertText', { text: 'second draft' });
  await tap("document.getElementById('paste-send')");
  await until("document.getElementById('paste').hidden");
  assert.deepEqual(await packets(), ['\x1b[200~the hello hello\x1b[201~', '\r', '\x1b[200~second draft\x1b[201~', '\r']);

  await load(); // A fresh document has no previous user activation to mask tap bugs.
  await tap("document.getElementById('term')");
  await until("document.activeElement.id === 'paste-text'");
  assert.equal(await evaluate("window.testFocus.find(f => f.id === 'paste-text').active"), true);
  await command('Input.imeSetComposition', { text: '한글', selectionStart: 2, selectionEnd: 2 });
  await tap("document.getElementById('paste-send')");
  await until("document.getElementById('paste').hidden");
  assert.deepEqual(await packets(), ['\x1b[200~한글\x1b[201~', '\r'], 'commit an active composition before reading its value');

  await load();
  await tap(button('Write'));
  await command('Input.insertText', { text: 'first' });
  await enter(8); // Shift+Enter edits a line without submitting.
  await command('Input.insertText', { text: 'second' });
  await tap(button('↵'));
  await command('Input.insertText', { text: 'third' });
  assert.equal(await evaluate("document.getElementById('paste-text').value"), 'first\nsecond\nthird');
  assert.deepEqual(await packets(), []);
  if (process.env.WEBUI_SCREENSHOT) {
    const screenshot = await command('Page.captureScreenshot');
    writeFileSync(process.env.WEBUI_SCREENSHOT.replace('.png', '-composer.png'), Buffer.from(screenshot.data, 'base64'));
  }
  await enter();
  await until("document.getElementById('paste').hidden");
  assert.deepEqual(await packets(), ['\x1b[200~first\rsecond\rthird\x1b[201~', '\r']);

  await load();
  await tap(button('Write'));
  await command('Input.imeSetComposition', { text: '한글', selectionStart: 2, selectionEnd: 2 });
  await tap(button('↵'));
  assert.equal(await evaluate("document.getElementById('paste-text').value"), '한글\n');
  assert.deepEqual(await packets(), [], 'newline edits must not send a partially composed word');
  await command('Input.insertText', { text: 'next' });
  await tap(button('Enter'));
  await until("document.getElementById('paste').hidden");
  assert.deepEqual(await packets(), ['\x1b[200~한글\rnext\x1b[201~', '\r']);

  await load();
  await touch('touchStart', 100, 220);
  await touch('touchMove', 100, 120);
  await touch('touchEnd');
  await touch('touchStart', 100, 220);
  await touch('touchCancel');
  assert.equal(await evaluate("document.getElementById('paste').hidden"), true, 'scroll and cancellation must not open the keyboard');
  await touch('touchStart', 100, 220);
  await delay(550);
  await touch('touchEnd');
  assert.equal(await evaluate("document.getElementById('menu').hidden"), false, 'long-press still opens the copy/paste menu');
  assert.equal(await evaluate("document.getElementById('paste').hidden"), true);
  await tap(button('⋯'));
  await tap(button('⌨'));
  await until("document.activeElement.id === 'paste-text'");
  await tap("document.getElementById('paste-cancel')");
  await tap(button('Keys'));
  assert.equal(await evaluate("document.activeElement.classList.contains('xterm-helper-textarea')"), true);
  await tap(button('Keys'));
  assert.equal(await evaluate("document.activeElement.classList.contains('xterm-helper-textarea')"), false, 'direct keyboard can be hidden again');
  await tap(button('Keys'));
  await evaluate('window.testPackets = []');
  await tap(button('Ctrl'));
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'l', code: 'KeyL', text: 'l', windowsVirtualKeyCode: 76 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76 });
  await tap(button('Answer'));
  await tap(button('↓'));
  await tap(button('Enter'));
  assert.deepEqual(await packets(), ['\x0c', '\x1b[1;2D', '\x1b[B', '\r'], 'retain live shortcuts and Codex question controls');

  await load('?keys=0');
  await tap("document.getElementById('term')");
  assert.equal(await evaluate("document.getElementById('paste').hidden"), true, 'the explicit toolbar opt-out keeps original typing');
});
