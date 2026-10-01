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
  timeout: 60000,
}, async t => {
  const bundle = process.env.WEBUI_BUNDLE || resolve(import.meta.dirname,
    '../agent-terminal/rootfs/opt/webui/index.html');
  const mock = `<script>
    window.testPackets = []; window.testFocus = []; window.testTerminalConnections = [];
    document.addEventListener('focusin', e => {
      window.testFocus.push({ id: e.target.id, active: navigator.userActivation.isActive });
    });
    window.fetch = async () => ({ json: async () => ({ token: '' }) });
    window.testHub = window.parent !== window && window.parent.testHub || {
      workspaces: [{ id: 'homeassistant', name: 'Home Assistant', directory: '/homeassistant' },
        { id: 'addon', name: 'Agent Terminal', directory: '/addons/agent-terminal' }],
      sessions: JSON.parse(localStorage.getItem('test-sessions') || 'null') || [
        ...['claude', 'codex', 'shell'].map(agent =>
          ({ id: 'agent-homeassistant-' + agent, name: 'Main', workspace: 'homeassistant', agent, stopped: false, running: false })),
        { id: 'session-' + 'b'.repeat(32), name: 'Session navigation', description: 'Polish the provider chooser',
          workspace: 'addon', agent: 'claude', stopped: false, running: false }],
      controls: [],
      publish() {
        localStorage.setItem('test-sessions', JSON.stringify(this.sessions));
        for (const socket of this.controls) if (socket.readyState === 1) socket.packet({ type: 'sessions', sessions: this.sessions,
          agents: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'ChatGPT' }, { id: 'shell', name: 'Shell' }],
          workspaces: this.workspaces });
      }
    };
    window.WebSocket = class {
      static OPEN = 1;
      readyState = 1;
      constructor(url) {
        this.url = url; this.args = new URL(url).searchParams.getAll('arg'); this.control = this.args[0] === 'sessions';
        if (this.control) testHub.controls.push(this); else { window.testSocket = this; window.testTerminalConnections.push(this); }
        setTimeout(() => this.onopen(), 0);
      }
      packet(value) { this.onmessage({ data: '0' + JSON.stringify(value) + '\\n' }); }
      send(data) {
        const text = new TextDecoder().decode(data);
        if (!this.control) {
          window.testPackets.push(text);
          if (text[0] === '{') {
            const id = this.args[2] || 'agent-' + this.args[1] + '-' + this.args[0];
            const record = testHub.sessions.find(s => s.id === id);
            if (record && !record.stopped) record.running = true;
          }
          return;
        }
        if (text[0] === '{') { testHub.publish(); return; }
        const request = JSON.parse(text.slice(1));
        let record = testHub.sessions.find(s => s.id === request.session);
        if (request.method === 'create') {
          record = { id: 'session-' + crypto.randomUUID().replaceAll('-', ''), name: request.name, description: request.description || '',
            agent: request.agent, workspace: request.workspace, running: false, stopped: false };
          testHub.sessions.push(record);
        } else if (request.method === 'rename') { record.name = request.name; record.description = request.description ?? record.description; }
        else if (request.method === 'stop') { record.stopped = true; record.running = false; }
        else if (request.method === 'start') record.stopped = false;
        if (request.method !== 'list') this.packet({ request: request.request, result: record });
        else this.packet({ request: request.request, result: { sessions: testHub.sessions,
          agents: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'ChatGPT' }, { id: 'shell', name: 'Shell' }],
          workspaces: testHub.workspaces } });
        testHub.publish();
      }
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
  await tap("document.getElementById('term')");
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
    const rect = await evaluate(`(() => {
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
  }
  const sessionAction = text => `[...document.querySelectorAll('.session-actions button')].find(b => b.textContent === ${JSON.stringify(text)})`;
  await click("document.getElementById('sessions-open')");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.session-workspace')].map(g => g.dataset.workspace)"), ['homeassistant', 'addon']);
  assert.equal(await evaluate(`document.querySelector('[data-session="${second}"] .session-place').textContent`), 'Current');
  assert.equal(await evaluate("document.querySelectorAll('.session-choice .provider-mark svg').length === document.querySelectorAll('.session-choice').length"), true);
  assert.equal(await evaluate("document.querySelector('[data-session=\"agent-homeassistant-shell\"]') === null"), true, 'unused defaults stay out of the main task list');
  await click("document.getElementById('sessions-unused')");
  assert.equal(await evaluate("!!document.querySelector('[data-session=\"agent-homeassistant-shell\"]')"), true);
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
});
