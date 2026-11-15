import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createSessionStore } from '../agent-terminal/rootfs/opt/agent-terminal/sessions.mjs';
import { fixtureHtml } from './helpers/webui-fixture.mjs';

// Opt in with CHROMIUM_BIN and WEBUI_BUNDLE. The real bundled xterm runs in
// Chromium, but its ttyd transport is replaced before any page code executes.
// No test input can reach an agent or tmux process.
test('task workspace persists work and preserves the terminal on desktop and phone', {
  skip: !process.env.CHROMIUM_BIN,
  timeout: 120000,
}, async t => {
  const bundle = process.env.WEBUI_BUNDLE || resolve(import.meta.dirname,
    '../agent-terminal/rootfs/opt/webui/index.html');
  const root = mkdtempSync(join(tmpdir(), 'task-browser-store-'));
  const optionsPath = join(root, 'options.json'); writeFileSync(optionsPath, '{"agent":"codex"}');
  const store = createSessionStore({ stateDir: root, optionsPath, homeDirectory: root, tmux: '/nonexistent-task-test-tmux' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let html = fixtureHtml(readFileSync(bundle, 'utf8'));
  html = html.replace('window.fetch = async', "window.testTasksRequest = window.fetch.bind(window); window.fetch = async");
  html = html.replace("if (request.method === 'usage')", `if (request.method.startsWith('tasks.')) {
    window.testTasksRequest('/task-api', { method: 'POST', body: JSON.stringify(request) }).then(r => r.json()).then(result => this.packet({ request: request.request, ...result })); return;
  }
  if (request.method === 'usage')`);
  assert.ok(!html.includes('/*{{XTERM_JS}}*/'), 'build the web UI before running the browser test');
  const server = createServer(async (req, res) => {
    if (req.url === '/task-api') {
      let body = ''; for await (const chunk of req) body += chunk;
      res.setHeader('Content-Type','application/json');
      try { res.end(JSON.stringify({ result: store.request(JSON.parse(body)) })); }
      catch (error) { res.end(JSON.stringify({ error: error.message })); }
      return;
    }
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
    assert.fail('Timed out: ' + expression + ' — ' + await evaluate("document.getElementById('tasks-message').textContent"));
  }
  const target = await command('Target.createTarget', { url: 'about:blank' });
  session = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await command('Page.enable');
  for (const width of [1280, 390, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    await command('Page.navigate', { url: origin });
    await until("window.testSocket?.onmessage && document.getElementById('overlay').hidden");
    await evaluate("document.getElementById('sessions-open').click(); document.getElementById('tasks-open').click();");
    await until("!document.getElementById('tasks-view').hidden");
    assert.equal(await evaluate("document.getElementById('app').inert"), true);
    await evaluate(`document.getElementById('tasks-new').click();
      document.getElementById('task-new-title').value = 'Task at ${width}';
      document.getElementById('task-new-case').value = 'Review';
      document.getElementById('task-new-session').value = 'agent-homeassistant-codex';
      document.getElementById('task-create').requestSubmit();`);
    await until("!document.getElementById('task-detail').hidden && !document.getElementById('task-save').disabled && !document.getElementById('tasks-message').textContent");
    await evaluate("document.querySelector('#task-detail details').open = true; document.getElementById('task-state').value = 'needs_you'; document.getElementById('task-summary').value = '<img src=x onerror=window.unsafe=true>'; document.getElementById('task-save').click()");
    await until("document.getElementById('tasks-list').textContent.includes('Needs you') && !document.getElementById('task-save').disabled && !document.getElementById('tasks-message').textContent");
    assert.equal(await evaluate("!!window.unsafe"), false);
    assert.equal(await evaluate("document.getElementById('tasks-view').scrollWidth <= innerWidth"), true);
    await evaluate("document.getElementById('task-draft').value = 'Inspect the configuration'; document.getElementById('task-draft').dispatchEvent(new Event('input')); document.getElementById('task-prepare').click()");
    await until("document.getElementById('tasks-view').hidden && !document.getElementById('paste').hidden");
    assert.equal(await evaluate("document.getElementById('paste-text').value"), 'Inspect the configuration');
    assert.equal(await evaluate("document.getElementById('app').inert"), false);
    assert.deepEqual(await evaluate("window.testPackets.filter(p => p.startsWith('0'))"), [], 'review never sends the draft automatically');
    await evaluate("document.getElementById('sessions-open').click(); document.getElementById('tasks-open').click()");
    assert.equal(await evaluate("document.getElementById('task-draft').value"), 'Inspect the configuration');
    if (process.env.TASK_SCREENSHOT_DIR) {
      const shot = await command('Page.captureScreenshot');
      writeFileSync(join(process.env.TASK_SCREENSHOT_DIR, 'tasks-' + width + '.png'), Buffer.from(shot.data,'base64'));
    }
    // Esc closes only the task workspace; an unsent terminal draft survives.
    await command('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
    await until("document.getElementById('tasks-view').hidden");
    assert.equal(await evaluate("document.getElementById('paste-text').value"), 'Inspect the configuration');
  }
  assert.equal(store.request({ method: 'tasks.list' }).length, 3);
});
