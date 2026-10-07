import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fixtureHtml } from './helpers/webui-fixture.mjs';

// Opt in with CHROMIUM_BIN and WEBUI_BUNDLE. The real bundled xterm runs in
// Chromium, but its ttyd transport is replaced before any page code executes.
// No test input can reach an agent or tmux process.
test('phone taps and composition with real browser events and xterm', {
  skip: !process.env.CHROMIUM_BIN,
  timeout: 60000,
}, async t => {
  const bundle = process.env.WEBUI_BUNDLE || resolve(import.meta.dirname,
    '../agent-terminal/rootfs/opt/webui/index.html');
  const html = fixtureHtml(readFileSync(bundle, 'utf8'));
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
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
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
      try { await command('Browser.close', {}, undefined); } catch { browser.kill('SIGTERM'); }
      await exit;
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
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
  async function tap(expression, corner = false) {
    const rect = await evaluate(`(() => {
      const r = (${expression}).getBoundingClientRect();
      return { x: r.x + ${corner ? 8 : 'r.width / 2'}, y: r.y + ${corner ? 8 : 'r.height / 2'} };
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
  async function shortcut(key, windowsVirtualKeyCode, modifiers = 2) {
    for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', {
      type, key, code: key, windowsVirtualKeyCode, modifiers,
    });
  }
  const button = label => `[...document.querySelectorAll('#bar button')].find(b => b.dataset.key === ${JSON.stringify(label)})`;
  // The group button, then a group from the list it shows in the same row.
  async function group(id) { await tap(button('Group')); await tap(`document.getElementById('group-${id}')`); }
  const target = await command('Target.createTarget', { url: 'about:blank' });
  session = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  async function load(search = '') {
    await command('Page.navigate', { url: origin + '/' + search });
    await until("!!document.querySelector('#keys-agent button') && window.testSocket?.onmessage && document.getElementById('overlay').hidden");
    await evaluate(`window.testPackets = []; window.testFocus = [];
      window.testSocket.onmessage({ data: new TextEncoder().encode('0\\x1b[?2004h').buffer });`);
    await delay(30);
  }
  async function packets() {
    return evaluate("window.testPackets.filter(p => p.startsWith('0')).map(p => p.slice(1))");
  }
  await load();
  assert.equal(await evaluate("matchMedia('(pointer: coarse)').matches"), true);
  const railKeys = "[...document.querySelectorAll('#key-rail button')].filter(b => b.getBoundingClientRect().width).map(b => b.dataset.key)";
  assert.deepEqual(await evaluate(railKeys), ['Esc', '←', '↑', '↓', '→', 'Enter', 'Keys'],
    'a 390px phone shows all four arrows in the bottom row');
  if (process.env.WEBUI_SCREENSHOT) {
    const screenshot = await command('Page.captureScreenshot');
    writeFileSync(process.env.WEBUI_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
  assert.equal(await evaluate("document.getElementById('key-panel')?.hidden === true"), true,
    'helpers start minimized');
  await evaluate("localStorage.setItem('cc-mobile:extraKeys', '1')");
  await load();
  assert.equal(await evaluate("document.getElementById('key-panel').hidden"), true,
    'old saved expansion must not open the helpers');
  await tap(button('Keys'));
  await group('tools');
  await tap("document.getElementById('term')");
  await until("document.activeElement.id === 'paste-text'");
  assert.equal(await evaluate("document.getElementById('key-panel').hidden"), true,
    'opening a draft minimizes the keys');
  assert.equal(await evaluate("window.testFocus.find(f => f.id === 'paste-text').active"), true,
    'keyboard focus must occur during a browser-authorized touch gesture');
  assert.equal(await evaluate("Math.min(...[...document.querySelectorAll('#bar button')].filter(b => b.getBoundingClientRect().height > 0).map(b => b.getBoundingClientRect().height)) >= 44"), true);
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 440, deviceScaleFactor: 1, mobile: true });
  await until('window.innerHeight === 440');
  await delay(100);
  assert.equal(await evaluate(`(() => {
    const terminal = document.getElementById('term').getBoundingClientRect();
    const draft = document.getElementById('paste').getBoundingClientRect();
    return terminal.height > 180 && terminal.bottom <= draft.top && draft.height <= 80 &&
      document.elementFromPoint(terminal.x + 30, terminal.y + 30).closest('#term') !== null;
  })()`), true, 'the draft must leave terminal output visible above the phone keyboard');
  await tap(button('Keys'));
  assert.equal(await evaluate("document.activeElement.id === 'paste-text'"), true,
    'opening helper keys leaves the native editor focused');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 430, deviceScaleFactor: 1, mobile: true });
  await delay(100);
  assert.equal(await evaluate("document.getElementById('key-panel').hidden"), false,
    'the keyboard resizing does not close explicitly opened helpers');
  await group('edit');
  assert.equal(await evaluate("document.getElementById('keys-agent').hidden && !document.getElementById('keys-edit').hidden"), true);
  assert.equal(await evaluate("document.getElementById('term').getBoundingClientRect().height > 100"), true,
    'another group still leaves response space above a draft');
  if (process.env.WEBUI_SCREENSHOT) {
    const shot = await command('Page.captureScreenshot');
    writeFileSync(process.env.WEBUI_SCREENSHOT.replace('.png', '-more.png'), Buffer.from(shot.data, 'base64'));
  }
  await group('agent');
  if (process.env.WEBUI_SCREENSHOT) {
    const shot = await command('Page.captureScreenshot');
    writeFileSync(process.env.WEBUI_SCREENSHOT.replace('.png', '-keys.png'), Buffer.from(shot.data, 'base64'));
  }
  await tap(button('Keys'));
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
  await tap("document.getElementById('term')");
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
  await tap("document.getElementById('term')");
  await command('Input.insertText', { text: 'first' });
  await enter(8); // Shift+Enter edits a line without submitting.
  await command('Input.insertText', { text: 'second' });
  await tap("document.getElementById('paste-newline')");
  await command('Input.insertText', { text: 'third' });
  await tap(button('Keys')); await group('edit'); await tap(button('↵'));
  await command('Input.insertText', { text: 'fourth' });
  assert.equal(await evaluate("document.getElementById('paste-text').value"), 'first\nsecond\nthird\nfourth');
  assert.equal(await evaluate("document.activeElement.id === 'paste-text'"), true, 'the helper keeps editing the open draft');
  assert.deepEqual(await packets(), []);
  if (process.env.WEBUI_SCREENSHOT) {
    const screenshot = await command('Page.captureScreenshot');
    writeFileSync(process.env.WEBUI_SCREENSHOT.replace('.png', '-composer.png'), Buffer.from(screenshot.data, 'base64'));
  }
  await enter();
  await until("document.getElementById('paste').hidden");
  assert.deepEqual(await packets(), ['\x1b[200~first\rsecond\rthird\rfourth\x1b[201~', '\r']);

  await load();
  await tap("document.getElementById('term')");
  await command('Input.imeSetComposition', { text: '한글', selectionStart: 2, selectionEnd: 2 });
  await tap("document.getElementById('paste-newline')");
  assert.equal(await evaluate("document.getElementById('paste-text').value"), '한글\n');
  assert.deepEqual(await packets(), [], 'newline edits must not send a partially composed word');
  await command('Input.insertText', { text: 'next' });
  await tap(button('Keys'));
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
  // The menu may cover the terminal's center as more actions are added.
  // Touch an uncovered corner to dismiss it and open the keyboard.
  await tap("document.getElementById('term')", true);
  await until("document.activeElement.id === 'paste-text'");
  await tap("document.getElementById('paste-cancel')");
  async function direct() { await tap(button('Keys')); await group('tools'); await tap(button('Direct')); }
  await direct();
  assert.equal(await evaluate("document.activeElement.classList.contains('xterm-helper-textarea')"), true);
  await direct();
  assert.equal(await evaluate("document.activeElement.classList.contains('xterm-helper-textarea')"), false, 'direct keyboard can be hidden again');
  await tap(button('Direct')); // still in Tools after hiding the direct keyboard
  await evaluate('window.testPackets = []');
  await tap(button('Keys')); await group('ctrl'); await tap(button('Ctrl'));
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'l', code: 'KeyL', text: 'l', windowsVirtualKeyCode: 76 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76 });
  await group('agent');
  await tap(button('Answer')); await tap(button('↓')); await tap(button('Enter'));
  await tap(button('Mode')); await tap(button('Space'));
  await tap(button('Esc²')); await delay(160);
  await group('edit'); await tap(button('↵')); await enter(8);
  await group('ctrl'); await tap(button('tmux')); await tap(button('tmux'));
  assert.deepEqual(await packets(), ['\x0c', '\x1b[1;2D', '\x1b[B', '\r', '\x1b[Z', ' ', '\x1b', '\x1b', '\n', '\n', '\x02', '\x02'],
    'retain shared controls, Codex questions and Claude background via tmux');
  // A narrow phone keeps every state of the keys usable, without overflowing
  // labels: 44px tall, and at least 40px wide in the seven-key rows.
  await command('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 1, mobile: true });
  await until('innerWidth === 320');
  await delay(100);
  for (const step of [() => tap(button('Keys')), () => tap(button('Keys')), () => tap(button('Group')),
    () => tap("document.getElementById('group-tools')"), () => group('edit')]) {
    await step();
    assert.equal(await evaluate(`[...document.querySelectorAll('#bar button')].filter(b => b.getBoundingClientRect().height).every(b => {
      const r = b.getBoundingClientRect();
      return r.width >= 40 && r.height >= 44 && r.left >= 0 && r.right <= 320 && b.scrollWidth <= b.clientWidth + 1;
    })`), true, 'all visible keys fit a 320px phone with usable touch targets');
  }
  assert.equal(await evaluate("document.getElementById('key-row').getBoundingClientRect().height < 60"), true, 'the panel is one row');
  assert.deepEqual(await evaluate(railKeys), ['Esc', '←', '↑', '↓', '→', 'Enter', 'Keys']);
  // The group button keeps its spot, so a second tap undoes the first.
  await load();
  await tap(button('Keys'));
  const spot = () => evaluate(`(() => { const r = ${button('Group')}.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join(); })()`);
  const groupSpot = await spot();
  await tap(button('Group'));
  assert.equal(await evaluate("!document.getElementById('key-groups').hidden"), true);
  assert.equal(await spot(), groupSpot);
  assert.equal(await evaluate(`(() => { const g = ${button('Group')}.getBoundingClientRect(), k = ${button('Keys')}.getBoundingClientRect();
    return Math.round(g.x) === Math.round(k.x) && Math.round(g.width) === Math.round(k.width); })()`), true, 'the group button sits right above Keys');
  await tap(button('Group'));
  assert.equal(await evaluate("!document.getElementById('keys-agent').hidden"), true);

  await load('?keys=0');
  await tap("document.getElementById('term')");
  assert.equal(await evaluate("document.getElementById('paste').hidden"), true, 'the explicit toolbar opt-out keeps original typing');

  // A drag that starts on text keeps scrolling once xterm redraws the rows under
  // the finger, which replaces their elements.
  await load();
  await evaluate(`testSocket.onmessage({ data: new TextEncoder().encode('0' +
    Array.from({ length: 200 }, (_, i) => 'Scrollback line ' + i + '\\r\\n').join('')).buffer })`);
  await until('testTerminal.buffer.active.baseY > 100');
  const dragTop = await evaluate("document.getElementById('term').getBoundingClientRect().top");
  await touch('touchStart', 40, dragTop + 40);
  await touch('touchMove', 40, dragTop + 80);
  await until('testTerminal.buffer.active.viewportY < testTerminal.buffer.active.baseY');
  await delay(50);
  const midDrag = await evaluate('testTerminal.buffer.active.viewportY');
  await touch('touchMove', 40, dragTop + 300);
  await touch('touchEnd');
  await until('testTerminal.buffer.active.viewportY < ' + midDrag);

  // The session bar's switch hides the keys for direct typing and brings them back.
  const keysSwitch = "document.getElementById('keys-switch')";
  await load();
  assert.equal(await evaluate(`${keysSwitch}.getBoundingClientRect().width >= 44`), true);
  await tap(keysSwitch);
  assert.equal(await evaluate("document.getElementById('bar').hidden"), true);
  await tap("document.getElementById('term')");
  assert.equal(await evaluate(`document.getElementById('paste').hidden &&
    document.activeElement === testTerminal.textarea && !testTerminal.textarea.hasAttribute('inputmode')`), true,
    'with the keys hidden, a tap types into the terminal');
  await tap(keysSwitch);
  assert.equal(await evaluate(`!document.getElementById('bar').hidden && !document.getElementById('key-panel').hidden &&
    testTerminal.textarea.getAttribute('inputmode') === 'none'`), true, 'showing the keys restores the draft mode');

  // The top bar collapses to a strip, and back, without taking the draft's focus.
  const termHeight = "document.getElementById('term').getBoundingClientRect().height";
  await load();
  await tap("document.getElementById('term')");
  await until("document.activeElement.id === 'paste-text'");
  const expandedHeight = await evaluate(termHeight);
  await tap("document.getElementById('top-collapse')");
  await delay(100);
  assert.equal(await evaluate(`document.getElementById('session-bar').hidden && document.activeElement.id === 'paste-text' &&
    ${termHeight} > ${expandedHeight} + 50`), true, 'collapsing gives the terminal the space and keeps typing');
  assert.equal(await evaluate("document.getElementById('session-strip').getBoundingClientRect().height >= 32"), true);
  await tap("document.getElementById('session-strip')");
  assert.equal(await evaluate("!document.getElementById('session-bar').hidden && document.activeElement.id === 'paste-text'"), true);
  await tap("document.getElementById('paste-cancel')");

  // A phone on its side moves the keys beside the terminal, even with its
  // keyboard up; an upright phone's keyboard never flips it that way.
  const sideways = "document.getElementById('app').classList.contains('side-keys')";
  await command('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  await load();
  await tap(button('Keys'));
  assert.equal(await evaluate(`${sideways} && (() => {
    const keys = document.getElementById('bar').getBoundingClientRect();
    return keys.left >= document.getElementById('term').getBoundingClientRect().right &&
      [...document.querySelectorAll('#bar button')].filter(b => b.getBoundingClientRect().height).every(b => {
        const r = b.getBoundingClientRect();
        return r.width >= 44 && r.height >= 44 && r.left >= keys.left && r.right <= keys.right;
      });
  })()`), true, 'the side column keeps 44px keys within it');
  await tap("document.getElementById('term')");
  await command('Emulation.setDeviceMetricsOverride', { width: 844, height: 190, deviceScaleFactor: 1, mobile: true });
  await delay(150);
  assert.equal(await evaluate(`${sideways} && ${termHeight} >= 60`), true, 'a sideways phone keeps rows visible while typing');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await load();
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 300, deviceScaleFactor: 1, mobile: true });
  await delay(150);
  assert.equal(await evaluate(sideways), false);

  // A desktop hides the keys until the switch asks for them; its clicks keep
  // the terminal focused, so typing carries on.
  async function click(expression) {
    await until(`!!(${expression})`);
    const rect = await evaluate(`(async () => {
      (${expression}).scrollIntoView({ block: 'nearest', inline: 'nearest' });
      // A viewport resize or scrolling needs a frame before Chrome hit-tests
      // the new coordinates. Resolve the node again after list updates.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const node = (${expression}), r = node.getBoundingClientRect();
      let x = r.x + r.width / 2, y = r.y + r.height / 2, frame = node.ownerDocument.defaultView.frameElement;
      while (frame) { const f = frame.getBoundingClientRect(); x += f.x; y += f.y; frame = frame.ownerDocument.defaultView.frameElement; }
      return { x, y };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await command('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    }
  }
  await command('Emulation.setTouchEmulationEnabled', { enabled: false });
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await evaluate("localStorage.removeItem('cc-mobile:keybar')");
  await load();
  assert.equal(await evaluate("matchMedia('(pointer: coarse)').matches"), false);
  assert.equal(await evaluate("document.getElementById('bar').hidden"), true, 'desktops start without the keys');
  await evaluate('testTerminal.focus()');
  await click(keysSwitch);
  assert.equal(await evaluate("!document.getElementById('bar').hidden && !document.getElementById('key-panel').hidden"), true);
  assert.equal(await evaluate(`[...document.querySelectorAll('#bar button')].filter(b => b.getBoundingClientRect().height).every(b => {
    const r = b.getBoundingClientRect(); return r.left >= (innerWidth - 660) / 2 && r.right <= (innerWidth + 660) / 2;
  })`), true, 'a wide screen gets a compact centred keypad');
  await click(button('Esc')); await click(button('Mode'));
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'l', code: 'KeyL', text: 'l', windowsVirtualKeyCode: 76 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76 });
  assert.deepEqual(await packets(), ['\x1b', '\x1b[Z', 'l'], 'helper clicks leave the terminal focused');
  assert.equal(await evaluate(`${button('Direct')}.hidden`), true);
  await load();
  assert.equal(await evaluate("!document.getElementById('bar').hidden && document.getElementById('key-panel').hidden"), true,
    'the desktop remembers the keys, minimized');
  await evaluate('testTerminal.focus()');
  await click("document.getElementById('top-collapse')");
  await load();
  assert.equal(await evaluate("document.getElementById('session-bar').hidden && !document.getElementById('session-strip').hidden"), true,
    'the desktop remembers a collapsed top bar');
  await evaluate('testTerminal.focus()');
  await click("document.getElementById('session-strip')");
  assert.equal(await evaluate("!document.getElementById('session-bar').hidden && document.activeElement === testTerminal.textarea"), true);

  // Exercise real desktop key events through xterm, including the ^H that
  // Ctrl+Backspace used to emit and the native text fields outside xterm.
  for (const agent of ['claude', 'codex']) {
    await load('?arg=' + agent + '&arg=homeassistant');
    await evaluate('testTerminal.focus()');
    await shortcut('ArrowLeft', 37);
    await shortcut('ArrowRight', 39);
    await shortcut('Backspace', 8);
    await shortcut('Delete', 46);
    assert.deepEqual(await packets(), ['\x1bb', '\x1bf', '\x1b\x7f', '\x1bd'],
      'desktop word editing reaches ' + agent + ' exactly once per key');
    await evaluate('window.testPackets = []');
    await enter(8);
    await enter();
    assert.deepEqual(await packets(), ['\n', '\r'], 'Shift+Enter adds a line, and Enter submits in ' + agent);
    await evaluate('window.testPackets = []');
    await shortcut('Backspace', 8, 0);
    await shortcut('Delete', 46, 0);
    await shortcut('ArrowLeft', 37, 10); // Ctrl+Shift: preserve the native selection sequence
    assert.deepEqual(await packets(), ['\x7f', '\x1b[3~', '\x1b[1;6D']);
  }
  await evaluate('window.testPackets = []');
  await click("document.getElementById('sessions-open')");
  await click("document.getElementById('sessions-search')");
  await command('Input.insertText', { text: 'alpha beta' });
  await shortcut('Backspace', 8);
  assert.equal(await evaluate("document.getElementById('sessions-search').value"), 'alpha ');
  assert.deepEqual(await packets(), [], 'editing a search field must never send terminal input');
  await click("document.getElementById('sessions-done')");

  // Named sessions use the real picker and two independent browser clients.
  // Only the transport is simulated; key routing, layout and reloads are real.
  await evaluate("localStorage.setItem('cc-mobile:keybar', '0')");
  await load();
  async function createSession(name, purpose = '') {
    await click("document.getElementById('sessions-open')");
    await click("document.getElementById('sessions-new')");
    await evaluate(`document.getElementById('sessions-name').value = ${JSON.stringify(name)};
      document.getElementById('sessions-purpose').value = ${JSON.stringify(purpose)};
      document.getElementById('sessions-provider').value = 'codex'`);
    await click("document.getElementById('sessions-save')");
    await until("document.getElementById('sessions-sheet').hidden && testSocket.args[0] === 'codex' && !document.getElementById('overlay').hidden === false");
    return evaluate('testSocket.args[2]');
  }
  const first = await createSession('Dashboard refresh', 'Make the wall tablet easier to read');
  const second = await createSession('Attic fan');
  assert.notEqual(first, second, 'same provider and workspace must get separate terminal identities');
  assert.equal(await evaluate(`testHub.sessions.find(s => s.id === ${JSON.stringify(first)}).running`), true);
  assert.equal(await evaluate("document.getElementById('sessions-open').textContent"), 'Attic fan');

  async function actions(id) {
    await click(`document.querySelector('[data-session-action="${id}:actions"]')`);
    await until(`document.querySelector('[data-session-action="${id}:actions"]')?.getAttribute('aria-expanded') === 'true'`);
  }
  const sessionAction = text => `[...document.querySelectorAll('.session-actions button')].find(b => b.textContent === ${JSON.stringify(text)})`;
  await click("document.getElementById('sessions-open')");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.session-workspace')].map(g => g.dataset.workspace)"), ['homeassistant', 'addon']);
  assert.equal(await evaluate(`document.querySelector('[data-session="${second}"] .session-place').textContent`), 'Current');
  assert.equal(await evaluate("document.querySelectorAll('.session-choice .provider-mark svg').length === document.querySelectorAll('.session-choice').length"), true);
  assert.equal(await evaluate("document.querySelector('[data-session=\"agent-homeassistant-shell\"]') === null"), true, 'unused defaults stay out of the main task list');
  await click("document.getElementById('sessions-unused')");
  assert.equal(await evaluate("!!document.querySelector('[data-session=\"agent-homeassistant-shell\"]')"), true);
  await actions('agent-homeassistant-shell');
  assert.equal(await evaluate(`!!(${sessionAction('Delete')})`), false, 'built-in sessions have no Delete action');
  await evaluate("document.getElementById('sessions-search').value = 'wall tablet'; document.getElementById('sessions-search').dispatchEvent(new Event('input'))");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.session-choice strong')].map(n => n.textContent)"), ['Dashboard refresh'], 'purpose is searchable');
  await evaluate("document.getElementById('sessions-search').value = ''; document.getElementById('sessions-search').dispatchEvent(new Event('input'))");
  if (process.env.WEBUI_SCREENSHOT) {
    const shot = await command('Page.captureScreenshot');
    writeFileSync(process.env.WEBUI_SCREENSHOT.replace('.png', '-groups.png'), Buffer.from(shot.data, 'base64'));
  }
  await actions(second);
  await click(sessionAction('Edit details'));
  await evaluate("document.getElementById('sessions-name').value = 'Fan tuning'; document.getElementById('sessions-purpose').value = 'Tune the upstairs cooling schedule'");
  await click("document.getElementById('sessions-save')");
  await until("document.getElementById('sessions-title').textContent === 'Sessions'");
  await click("document.getElementById('sessions-done')");
  assert.equal(await evaluate("document.getElementById('sessions-open').textContent"), 'Fan tuning');

  const side = "document.getElementById('side-terminal').contentWindow";
  const connections = await evaluate('testTerminalConnections.length');
  await click("document.getElementById('split-toggle')");
  await until(`!!document.getElementById('side-terminal') && ${side}.document.getElementById('sessions-title')?.textContent === 'Add a second session' && !!${side}.document.querySelector('.session-choice')`);
  assert.equal(await evaluate("document.getElementById('sessions-sheet').hidden"), true, 'Split keeps the left terminal visible');
  assert.equal(await evaluate(`${side}.testTerminalConnections.length`), 0, 'an empty second pane must not attach to or start any agent');
  assert.equal(await evaluate(`${side}.document.querySelector('[data-session-action="${second}:open"]') === null`), true, 'the left session cannot be selected for both panes');
  assert.equal(await evaluate('testTerminalConnections.length'), connections);
  if (process.env.WEBUI_SCREENSHOT) {
    const shot = await command('Page.captureScreenshot');
    writeFileSync(process.env.WEBUI_SCREENSHOT.replace('.png', '-choose-pane.png'), Buffer.from(shot.data, 'base64'));
  }
  await click(`${side}.document.getElementById('sessions-done')`);
  await until("!document.getElementById('side-terminal')");
  assert.equal(await evaluate('testTerminalConnections.length'), connections, 'cancel only removes the empty pane');
  await click("document.getElementById('split-toggle')");
  await until(`!!document.getElementById('side-terminal') && !!${side}.document.querySelector('[data-session-action="${first}:open"]')`);
  await click(`${side}.document.querySelector('[data-session-action="${first}:open"]')`);
  await until(`!!document.getElementById('side-terminal') && ${side}.testSocket?.args[2] === ${JSON.stringify(first)} && !!${side}.testTerminal`);
  assert.equal(await evaluate('testSocket.args[2]'), second);
  await evaluate(`window.testPackets = []; ${side}.testPackets = []; testTerminal.focus()`);
  async function letter(key) {
    for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', {
      type, key, code: 'Key' + key.toUpperCase(), windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), ...(type === 'keyDown' ? { text: key } : {}) });
  }
  await letter('l');
  await evaluate(`${side}.testTerminal.focus()`);
  await letter('r');
  await shortcut('Backspace', 8);
  await enter(8);
  assert.deepEqual(await packets(), ['l'], 'right-pane typing cannot reach the left session');
  assert.deepEqual(await evaluate(`${side}.testPackets.filter(p => p.startsWith('0')).map(p => p.slice(1))`), ['r', '\x1b\x7f', '\n']);
  const leftWidth = await evaluate("document.getElementById('term').getBoundingClientRect().width");
  const dividerX = await evaluate("document.getElementById('split-divider').getBoundingClientRect().x + 4");
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: dividerX, y: 300, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dividerX + 100, y: 300, button: 'left', buttons: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dividerX + 100, y: 300, button: 'left', clickCount: 1 });
  await until(`document.getElementById('term').getBoundingClientRect().width > ${leftWidth + 80}`);
  assert.equal(await evaluate(`document.getElementById('term').getBoundingClientRect().right < document.getElementById('side-terminal').getBoundingClientRect().left`), true);

  if (process.env.WEBUI_SCREENSHOT) {
    await evaluate(`testSocket.onmessage({ data: '0Fan tuning\\r\\nReviewing the attic fan controls…\\r\\n' });
      ${side}.testSocket.onmessage({ data: '0Dashboard refresh\\r\\nWorking on the overview layout…\\r\\n' })`);
    await delay(100);
    const shot = await command('Page.captureScreenshot');
    writeFileSync(process.env.WEBUI_SCREENSHOT.replace('.png', '-split.png'), Buffer.from(shot.data, 'base64'));
  }
  await load();
  await until(`document.getElementById('side-terminal') && ${side}.testSocket?.args[2] === ${JSON.stringify(first)}`);
  assert.equal(await evaluate('testSocket.args[2]'), second, 'reload restores the two different sessions');
  assert.equal(await evaluate("document.getElementById('sessions-open').textContent"), 'Fan tuning');
  assert.equal(await evaluate(`testHub.sessions.find(s => s.id === ${JSON.stringify(second)}).description`), 'Tune the upstairs cooling schedule', 'purpose survives reload');

  // The panes connect on their own schedules. The keyboard starts in the left
  // pane, and a pane whose connection comes back never takes it from the
  // pane being typed in: the rest of a prompt would land in the other session.
  const typingIn = `document.activeElement === testTerminal.textarea ? 'left'
    : document.activeElement === document.getElementById('side-terminal') ? 'right' : 'neither'`;
  await until(`${side}.document.getElementById('overlay').hidden && document.getElementById('overlay').hidden`);
  await delay(50);
  assert.equal(await evaluate(typingIn), 'left', 'a second pane that loads later leaves the keyboard alone');
  let opened = await evaluate(`${side}.testTerminalConnections.length`);
  await evaluate(`${side}.testSocket.close()`);
  await until(`${side}.testTerminalConnections.length > ${opened} && ${side}.document.getElementById('overlay').hidden`);
  assert.equal(await evaluate(typingIn), 'left', 'the right pane reconnecting does not take the keyboard');
  await evaluate(`${side}.testTerminal.focus()`);
  opened = await evaluate('testTerminalConnections.length');
  await evaluate('testSocket.close()');
  await until(`testTerminalConnections.length > ${opened} && document.getElementById('overlay').hidden`);
  assert.equal(await evaluate(typingIn), 'right', 'nor does the left pane');

  await click("document.getElementById('sessions-open')");
  assert.equal(await evaluate(`document.querySelector('[data-session="${second}"] .session-place').textContent`), 'Left pane');
  assert.equal(await evaluate(`document.querySelector('[data-session="${first}"] .session-place').textContent`), 'Right pane');
  await click(`document.querySelector('[data-session-action="${first}:open"]')`);
  await until("document.activeElement === document.getElementById('side-terminal')");

  // Stopping through the picker must hold the disconnected view until Start.
  await click("document.getElementById('sessions-open')");
  await actions(second);
  await click(sessionAction('Stop'));
  await click("document.getElementById('sessions-save')");
  await until("document.getElementById('overlay-msg').textContent.includes('Session stopped')");
  assert.equal(await evaluate('testSocket.readyState'), 3);
  await click(sessionAction('Start'));
  await until("document.getElementById('sessions-sheet').hidden && !document.getElementById('overlay').hidden === false && testSocket.readyState === 1");

  // A shortcut from inside the other iframe opens its own picker.
  await evaluate(`${side}.testTerminal.focus()`);
  for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', {
    type, key: 'K', code: 'KeyK', modifiers: 10, windowsVirtualKeyCode: 75 });
  await until(`!${side}.document.getElementById('sessions-sheet').hidden`);
  assert.equal(await evaluate("document.getElementById('sessions-sheet').hidden"), true);
  await evaluate(`${side}.document.getElementById('sessions-done').click(); ${side}.testTerminal.focus()`);
  await delay(50);
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await until("!document.getElementById('side-terminal')");
  await until(`testSocket.args[2] === ${JSON.stringify(first)}`);
  assert.equal(await evaluate(`testHub.sessions.find(s => s.id === ${JSON.stringify(second)}).running`), true,
    'collapsing to one pane keeps the hidden agent running');
  assert.equal(await evaluate("document.getElementById('split-toggle').hidden"), true);
  assert.equal(await evaluate("document.getElementById('session-bar').getBoundingClientRect().height <= 110"), true,
    'a named session keeps the phone header within two rows');
  await click("document.getElementById('sessions-open')");
  await evaluate("document.getElementById('sessions-search').value = 'fan'; document.getElementById('sessions-search').dispatchEvent(new Event('input'))");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.session-choice strong')].map(n => n.textContent)"), ['Fan tuning']);
  if (process.env.WEBUI_SCREENSHOT) {
    const shot = await command('Page.captureScreenshot');
    writeFileSync(process.env.WEBUI_SCREENSHOT.replace('.png', '-sessions.png'), Buffer.from(shot.data, 'base64'));
  }
  await click("document.getElementById('sessions-done')");
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await until("!document.getElementById('split-toggle').hidden");
  await click("document.getElementById('split-toggle')");
  await until(`!!document.getElementById('side-terminal') && !!${side}.document.querySelector('.session-choice')`);
  await click(`${side}.document.getElementById('sessions-new')`);
  await evaluate(`${side}.document.getElementById('sessions-name').value = 'Release notes';
    ${side}.document.getElementById('sessions-purpose').value = 'Summarize the add-on changes';
    ${side}.document.getElementById('sessions-workspace').value = 'addon';
    ${side}.document.getElementById('sessions-provider').value = 'claude'`);
  await click(`${side}.document.getElementById('sessions-save')`);
  await until(`${side}.testSocket?.args[0] === 'claude' && ${side}.testSocket.args[1] === 'addon'`);
  assert.equal(await evaluate('testSocket.args[2]'), first, 'creating on the right does not replace the left session');
  assert.equal(await evaluate(`${side}.document.getElementById('sessions-sheet').hidden`), true);
  await click(`${side}.document.getElementById('split-toggle')`);
  await until("!document.getElementById('side-terminal')");
  assert.equal(await evaluate("testHub.sessions.find(s => s.name === 'Release notes').running"), true);

  // Delete a visible second session through the first pane. Confirmation can
  // be canceled, and deleting must never redirect typing or revive a task.
  const disposable = await evaluate("testHub.sessions.find(s => s.name === 'Release notes').id");
  await click("document.getElementById('sessions-open')");
  await actions(disposable);
  await click(sessionAction('Open beside'));
  await until(`${side}.testSocket?.args[2] === ${JSON.stringify(disposable)}`);
  // Asking for a session beside this one moves the keyboard to it.
  await until(`document.activeElement === document.getElementById('side-terminal') &&
    ${side}.document.activeElement === ${side}.testTerminal.textarea`);
  const survivorConnections = await evaluate('testTerminalConnections.length');
  await click("document.getElementById('sessions-open')");
  await actions(disposable);
  await click(sessionAction('Delete'));
  assert.equal(await evaluate("document.getElementById('sessions-title').textContent"), 'Delete session');
  assert.equal(await evaluate('document.activeElement.id'), 'sessions-back', 'confirmation focuses the non-destructive choice');
  assert.match(await evaluate("document.getElementById('sessions-explanation').textContent"), /Release notes.*Agent Terminal.*Claude.*Workspace files and provider-saved conversations are kept/);
  if (process.env.WEBUI_SCREENSHOT) {
    const shot = await command('Page.captureScreenshot');
    writeFileSync(process.env.WEBUI_SCREENSHOT.replace('.png', '-delete.png'), Buffer.from(shot.data, 'base64'));
  }
  await click("document.getElementById('sessions-back')");
  assert.equal(await evaluate(`${side}.testSocket.readyState`), 1, 'cancel keeps the target running');
  await click(sessionAction('Delete'));
  await click("document.getElementById('sessions-save')");
  await until(`${side}.document.getElementById('overlay-msg').textContent.includes('Session unavailable')`);
  assert.equal(await evaluate(`${side}.testSocket.readyState`), 3);
  assert.equal(await evaluate(`testHub.sessions.some(s => s.id === ${JSON.stringify(disposable)})`), false);
  assert.equal(await evaluate(`!!document.querySelector('[data-session="${disposable}"]')`), false);
  assert.equal(await evaluate(`!!${side}.document.querySelector('[data-session="${disposable}"]')`), false);
  assert.equal(await evaluate('testSocket.args[2]'), first);
  assert.equal(await evaluate('testTerminalConnections.length'), survivorConnections);
  await click("document.getElementById('sessions-done')");
  const removedConnections = await evaluate(`${side}.testTerminalConnections.length`);
  await evaluate(`${side}.dispatchEvent(new Event('online')); ${side}.dispatchEvent(new Event('focus'))`);
  await delay(600);
  assert.equal(await evaluate(`${side}.testTerminalConnections.length`), removedConnections, 'stale tabs cannot reconnect after deletion');
  await evaluate('window.testPackets = []; testTerminal.focus()');
  await letter('s');
  assert.deepEqual(await packets(), ['s'], 'the surviving terminal still receives its own input');
  await click(`${side}.document.getElementById('split-toggle')`);
  await until("!document.getElementById('side-terminal')");

  // A stopped session can be removed too, including on a narrow screen.
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await click("document.getElementById('sessions-open')");
  await actions(second);
  await click(sessionAction('Stop'));
  await click("document.getElementById('sessions-save')");
  await until(`testHub.sessions.find(s => s.id === ${JSON.stringify(second)}).stopped`);
  await click(sessionAction('Delete'));
  assert.equal(await evaluate("document.getElementById('sessions-save').getBoundingClientRect().right <= innerWidth"), true);
  await click("document.getElementById('sessions-save')");
  await until(`!testHub.sessions.some(s => s.id === ${JSON.stringify(second)})`);
  await click("document.getElementById('sessions-done')");

  // Removing the current session leaves the picker ready for another choice.
  const currentTemporary = await createSession('Quick check');
  await click("document.getElementById('sessions-open')");
  await actions(currentTemporary);
  await click(sessionAction('Delete'));
  await click("document.getElementById('sessions-save')");
  await until("document.getElementById('overlay-msg').textContent.includes('Session unavailable')");
  assert.equal(await evaluate('testSocket.readyState'), 3);
  assert.equal(await evaluate("document.getElementById('sessions-sheet').hidden"), false);
  await click(`document.querySelector('[data-session-action="${first}:open"]')`);
  await until(`testSocket.args[2] === ${JSON.stringify(first)} && testSocket.readyState === 1`);
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await load();
  assert.equal(await evaluate(`testHub.sessions.some(s => ${JSON.stringify([second, disposable, currentTemporary])}.includes(s.id))`), false, 'removed sessions stay gone after reload');

  // Attaching files with real browser events: a pasted screenshot, a drop of
  // two files, and a large photo picked from the phone draft, which goes as a
  // 2048-pixel JPEG. Each saved path is pasted on its own, then a typed space.
  await load();
  const bracketed = name => '\x1b[200~/data/agent-terminal/uploads/2026-10-02/153012-abc123-' + name + '\x1b[201~';
  await evaluate(`(() => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }));
    testTerminal.textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  })()`);
  await until('window.testUploaded[0]?.path && window.testPackets.length >= 2');
  assert.deepEqual(await packets(), [bracketed('image.png'), ' '], 'a pasted screenshot becomes its path');
  await evaluate('window.testPackets = []');
  assert.equal(await evaluate(`(() => {
    const data = new DataTransfer(), term = document.getElementById('term');
    data.items.add(new File(['kitchen,21.5'], 'temps.csv', { type: 'text/csv' }));
    data.items.add(new File(['%PDF-1.7'], 'manual.pdf', { type: 'application/pdf' }));
    term.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    const highlighted = document.getElementById('app').classList.contains('dropping');
    return highlighted && !term.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  })()`), true, 'a file drag is highlighted, and the drop is the page\'s rather than the browser\'s');
  await until('window.testUploaded.filter(f => f.path).length === 3 && window.testPackets.length >= 4');
  assert.deepEqual(await packets(), [bracketed('temps.csv'), ' ', bracketed('manual.pdf'), ' ']);
  assert.equal(await evaluate("document.getElementById('app').classList.contains('dropping')"), false);

  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate("localStorage.removeItem('cc-mobile:keybar')");
  await load();
  await tap("document.getElementById('term')");
  await until("document.activeElement.id === 'paste-text'");
  assert.equal(await evaluate(`(() => {
    const attach = document.getElementById('paste-attach').getBoundingClientRect();
    const text = document.getElementById('paste-text').getBoundingClientRect();
    return attach.width >= 40 && attach.height >= 44 && text.width >= 150 && text.right <= attach.left;
  })()`), true, 'Attach sits beside the draft and leaves room to write');
  const photo = Buffer.from(await evaluate(`(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 2400; canvas.height = 1600;
    const context = canvas.getContext('2d'), image = context.createImageData(2400, 1600);
    for (let i = 0; i < image.data.length; i++) image.data[i] = i % 4 === 3 ? 255 : Math.random() * 256;
    context.putImageData(image, 0, 0);
    const bytes = new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8))).arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(text);
  })()`), 'base64');
  assert.ok(photo.length > 1572864, 'the test photo is large enough to shrink');
  writeFileSync(join(profile, 'IMG_0042.jpg'), photo);
  await command('Page.setInterceptFileChooserDialog', { enabled: true });
  await evaluate("document.getElementById('upload-input').addEventListener('click', () => { window.testPicker = true; })");
  await tap("document.getElementById('paste-attach')");
  await until('window.testPicker');
  const { root } = await command('DOM.getDocument', { depth: 0 });
  const { nodeId } = await command('DOM.querySelector', { nodeId: root.nodeId, selector: '#upload-input' });
  await command('DOM.setFileInputFiles', { nodeId, files: [join(profile, 'IMG_0042.jpg')] });
  await until('window.testUploaded[0]?.path && window.testPackets.length >= 2');
  const sent = await evaluate(`(async () => {
    const file = window.testUploaded[0];
    const parts = file.chunks.map(chunk => Uint8Array.from(atob(chunk), c => c.charCodeAt(0)));
    const bitmap = await createImageBitmap(new Blob(parts, { type: 'image/jpeg' }));
    return { name: file.name, size: file.size, received: parts.reduce((n, p) => n + p.length, 0), width: bitmap.width, height: bitmap.height };
  })()`);
  assert.equal(sent.received, sent.size);
  assert.ok(sent.size < photo.length, 'the photo shrank before upload');
  assert.deepEqual([sent.name, sent.width, sent.height], ['IMG_0042.jpg', 2048, 1365]);
  assert.deepEqual(await packets(), [bracketed('IMG_0042.jpg'), ' ']);
  assert.equal(await evaluate("document.getElementById('paste').hidden"), false, 'the draft stays open to finish the message');

  // Real microphone API and Web Audio, with Chromium's synthetic audio source
  // and the inert voice receiver. Dictation never sends a terminal command.
  await load();
  await tap("document.getElementById('voice-open')");
  await until("document.getElementById('voice-message').textContent.startsWith('Listening')");
  assert.equal(await evaluate("document.getElementById('paste-send').disabled"), true);
  await evaluate("document.getElementById('paste-text').value = 'Please'");
  await delay(500);
  await tap("document.getElementById('voice-action')");
  await until("document.getElementById('paste-text').value === 'Please Review the kitchen dashboard.'");
  assert.deepEqual(await packets(), [], 'speech stays in the editable draft');
  assert.ok(await evaluate("window.testVoiceRequests.some(r => r.method === 'chunk' && r.data.length > 0)"), 'Web Audio captured PCM');
  assert.equal(await evaluate("document.getElementById('paste-send').disabled"), false);
  if (process.env.WEBUI_SCREENSHOT) {
    const screenshot = await command('Page.captureScreenshot');
    writeFileSync(process.env.WEBUI_SCREENSHOT.replace('.png', '-voice.png'), Buffer.from(screenshot.data, 'base64'));
  }
  await tap("document.getElementById('paste-send')");
  await until("window.testPackets.filter(p => p.startsWith('0')).length >= 2");
  assert.deepEqual(await packets(), ['\x1b[200~Please Review the kitchen dashboard.\x1b[201~', '\r']);

  // Health remains opt-in; saving choices never sends a terminal prompt.
  // The complete response flow uses the same inert session backend.
  await load();
  await tap("document.getElementById('sessions-open')");
  await tap("document.getElementById('health-open')");
  await until("!document.getElementById('health-sheet').hidden && document.getElementById('health-delayMinutes').value === '10'");
  assert.equal(await evaluate("document.getElementById('health-enabled').checked"), false);
  await evaluate(`(() => {
    const reviewer = document.getElementById('health-reviewer'); reviewer.value = 'ollama'; reviewer.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('health-ollamaUrl').value = 'http://model.test:11434';
    document.getElementById('health-model').value = 'example:4b';
    document.getElementById('health-criticalEntities').value = 'climate.main';
    document.getElementById('health-investigationAgent').value = 'claude';
    document.querySelector('#health-notifyServices option').selected = true;
    document.querySelector('#health-form button').scrollIntoView({ block: 'center' });
  })()`);
  await tap("document.querySelector('#health-form button')");
  await until("document.getElementById('health-status').textContent.includes('Settings saved')");
  assert.equal(await evaluate('testHub.health.config.reviewer'), 'ollama');
  assert.equal(await evaluate('testHub.health.config.investigationAgent'), 'claude');
  assert.deepEqual(await packets(), [], 'health setup sends no terminal commands');
  await evaluate(`(() => {
    testHub.health.incidents = [{ id: '${'a'.repeat(32)}', title: 'Thermostat unavailable', kind: 'entity', severity: 'major',
      evidence: '<img src=x onerror="window.healthInjected=true"> climate.main unavailable', firstSeen: Date.now() - 900000,
      lastSeen: Date.now(), count: 4 }];
    testHub.publish(); document.getElementById('health-settings').open = false;
  })()`);
  await until("document.querySelectorAll('.health-incident').length === 1");
  assert.equal(await evaluate("document.querySelector('#health-incidents img') === null && !window.healthInjected"), true, 'untrusted evidence stays plain text');
  assert.equal(await evaluate("document.getElementById('health-sheet').scrollWidth <= document.getElementById('health-sheet').clientWidth"), true, 'phone dialog has no horizontal overflow');
  if (process.env.WEBUI_SCREENSHOT) {
    const screenshot = await command('Page.captureScreenshot');
    writeFileSync(process.env.WEBUI_SCREENSHOT.replace('.png', '-health.png'), Buffer.from(screenshot.data, 'base64'));
  }
  await tap("Array.from(document.querySelectorAll('.health-actions button')).find(b => b.textContent === 'Snooze 1h')");
  await until('testHub.health.incidents[0].snoozedUntil > Date.now()');
  await tap("Array.from(document.querySelectorAll('.health-actions button')).find(b => b.textContent === 'Investigate')");
  await until("!document.getElementById('paste').hidden && document.getElementById('paste-text').value.includes('read-only checks')");
  // The draft opens immediately; fetching ttyd's token connects the selected
  // terminal asynchronously. Check the new socket only after it has opened.
  await until("testSocket?.args[0] === 'claude' && testSocket.readyState === 1");
  assert.equal(await evaluate("testSocket.args[0]"), 'claude');
  assert.equal(await evaluate("testHub.sessions.find(s => s.id === testSocket.args[2]).name"), 'Investigate: Thermostat unavailable');
  assert.deepEqual(await packets(), [], 'the investigation is prepared in a draft for the user to send');

  // A local provider owns its connection just like the hosted providers.
  await load();
  await tap("document.querySelector('#agents button[data-agent=ollama]')");
  await until("testSocket?.args[0] === 'ollama' && testSocket.readyState === 1");
  assert.equal(await evaluate('testSocket.args[1]'), 'homeassistant');
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, 'Ollama provider fits the phone layout');
  await tap("document.getElementById('sessions-open')");
  await tap("document.getElementById('sessions-new')");
  await evaluate("document.getElementById('sessions-name').value = 'Local coding task'");
  assert.equal(await evaluate("document.getElementById('sessions-provider').value"), 'ollama');
  await tap("document.getElementById('sessions-save')");
  await until("testSocket?.args[0] === 'ollama' && testSocket.args[2]?.startsWith('session-')");
  assert.equal(await evaluate('testHub.sessions.find(s => s.id === testSocket.args[2]).name'), 'Local coding task');
});
