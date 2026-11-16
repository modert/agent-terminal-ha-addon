import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
const controlRoot = process.env.AGENT_TERMINAL_TEST_CONTAINER === '1' ? new URL('file:///opt/agent-terminal/') : new URL('../agent-terminal/rootfs/opt/agent-terminal/', import.meta.url);
const { createWorkService } = await import(new URL('work-service.mjs', controlRoot));
const { createSessionStore } = await import(new URL('sessions.mjs', controlRoot));

import { fakeWorkProvider } from './helpers/workspace-provider.mjs';

import { fixtureHtml } from './helpers/webui-fixture.mjs';

// Opt in with CHROMIUM_BIN and WEBUI_BUNDLE. The real bundled xterm runs in
// Chromium, but its ttyd transport is replaced before any page code executes.
// No test input can reach an agent or tmux process.
test('unified workspace discovers history, chats, approves and inspects without leaving the task', {
  skip: !process.env.CHROMIUM_BIN,
  timeout: 120000,
}, async t => {
  const bundle = process.env.WEBUI_BUNDLE || resolve(import.meta.dirname,
    '../agent-terminal/rootfs/opt/webui/index.html');
  const root = mkdtempSync(join(tmpdir(), 'task-browser-store-'));
  const optionsPath = join(root, 'options.json'); writeFileSync(optionsPath, '{"agent":"codex"}');
  const provider = fakeWorkProvider();
  const service = createWorkService({ stateDir: root, runtime: join(root,'runtime'), providers: { codex: provider }, workspaces: { get() { return { directory: root }; } } });
  const store = createSessionStore({ stateDir: root, optionsPath, homeDirectory: root, tmux: '/nonexistent-task-test-tmux', workRequest: (method, fields) => service.request({ method, ...fields }) });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let html = fixtureHtml(readFileSync(bundle, 'utf8')).replace('window.AGENT_WORKSPACE_DEFAULT = false;', '');
  html = html.replace('window.fetch = async', "window.testTasksRequest = window.fetch.bind(window); window.fetch = async");
  html = html.replace("if (request.method === 'usage')", `if (request.method.startsWith('tasks.') || request.method.startsWith('workspace.')) {
    window.testTasksRequest('/task-api', { method: 'POST', body: JSON.stringify(request) }).then(r => r.json()).then(result => this.packet({ request: request.request, ...result })); return;
  }
  if (request.method === 'usage')`);
  assert.ok(!html.includes('/*{{XTERM_JS}}*/'), 'build the web UI before running the browser test');
  const server = createServer(async (req, res) => {
    if (req.url === '/task-api') {
      let body = ''; for await (const chunk of req) body += chunk;
      res.setHeader('Content-Type','application/json');
      try { const input = JSON.parse(body); const result = input.method === 'workspace.inspect' ? { id: 'agent-homeassistant-codex', agent: 'codex', workspace: 'homeassistant', name: 'Backend fixture' } : await store.request(input); res.end(JSON.stringify({ result })); }
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
    assert.fail('Timed out: ' + expression + ' — ' + JSON.stringify({calls:provider.calls,ui:await evaluate("({notice:document.getElementById('work-notice').textContent,errors:window.testErrors,draft:document.getElementById('work-compose').value,disabled:document.getElementById('work-send').disabled})")}));
  }
  const target = await command('Target.createTarget', { url: 'about:blank' });
  session = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await command('Page.enable');
  await command('Page.addScriptToEvaluateOnNewDocument', { source: "window.testErrors=[];addEventListener('error',e=>testErrors.push(e.message));addEventListener('unhandledrejection',e=>testErrors.push(String(e.reason)));" });

  for (const width of [1280, 390, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    await command('Page.navigate', { url: origin });
    await until("window.testTerminalConnections?.length > 0");
    assert.equal(await evaluate("document.getElementById('tasks-view').hidden"), true, 'terminal remains the default');
    await evaluate("document.getElementById('tasks-open').click()");
    await until("document.getElementById('work-list')?.textContent.includes('Existing saved work')");
    assert.equal(await evaluate("document.getElementById('tasks-view').hidden"), false, 'workspace opens on request');
    await evaluate("document.querySelector('#work-list button').click()");
    await until("document.getElementById('work-messages').textContent.includes('Existing saved conversation')");
    await evaluate("document.getElementById('work-older').click()");
    await until("document.getElementById('work-messages').textContent.includes('An older message')");
    if (width === 1280) {
      await evaluate("document.getElementById('work-compose').value = 'Continue this saved item'; document.getElementById('work-send').click()");
      await until("document.getElementById('work-approvals').textContent.includes('Approval needed')");
      await evaluate("[...document.querySelectorAll('#work-approvals button')].find(b=>b.textContent==='Allow once').click()");
      await until("document.getElementById('work-messages').textContent.includes('Completed after your approval.')");
      assert.equal(provider.calls.find(c => c.text === 'Continue this saved item').id, '550e8400-e29b-41d4-a716-446655440040', 'continuation uses the imported conversation');
      assert.equal((await store.request({ method: 'workspace.list' })).tasks.length, 1, 'continuation creates no replacement task');
    }
    await evaluate(`document.getElementById('work-new').click(); document.getElementById('work-new-title').value = 'Unified task ${width}'; document.getElementById('work-new-case').value = 'A case'; document.getElementById('work-new-form').requestSubmit();`);
    await until("document.getElementById('work-title').textContent.startsWith('Unified task') && !document.getElementById('work-send').disabled");
    await evaluate("document.getElementById('work-compose').value = 'Do the task'; document.getElementById('work-send').click()");
    await until("document.getElementById('work-approvals').textContent.includes('Approval needed')");
    assert.equal(await evaluate("document.getElementById('tasks-view').hidden"), false);
    assert.equal(await evaluate("document.getElementById('work-compose').value"), '');
    await evaluate("[...document.querySelectorAll('#work-approvals button')].find(b=>b.textContent==='Allow once').click()");
    await until("document.getElementById('work-messages').textContent.includes('Completed after your approval.')");
    assert.equal(await evaluate("document.getElementById('work-approvals').textContent"), '');
    assert.deepEqual(await evaluate("window.testPackets.filter(p => p.startsWith('0'))"), [], 'chat never types into a terminal');
    await evaluate("document.getElementById('work-compose').value = 'Unsent draft'; document.getElementById('work-compose').dispatchEvent(new Event('input'))");
    await command('Page.reload');
    await until("window.testTerminalConnections?.length > 0");
    assert.equal(await evaluate("document.getElementById('tasks-view').hidden"), true);
    await evaluate("document.getElementById('tasks-open').click()");
    await until(`document.getElementById('work-list')?.textContent.includes('Unified task ${width}')`);
    await evaluate(`[...document.querySelectorAll('#work-list button')].find(b=>b.textContent.includes('Unified task ${width}')).click()`);
    await until("document.getElementById('work-messages').textContent.includes('Completed after your approval.')");
    assert.equal(await evaluate("document.getElementById('work-compose').value"), 'Unsent draft');
    await evaluate("document.getElementById('work-details').open = true; document.getElementById('work-case').value = 'Reviewed case'; document.getElementById('work-summary').value = '<img src=x onerror=window.unsafe=true>'; document.getElementById('work-save').click()");
    await until("document.getElementById('work-notice').textContent === 'Saved.'");
    assert.equal(await evaluate("!!window.unsafe"), false);
    await evaluate("document.getElementById('work-add-conversation').click()");
    await until("document.getElementById('work-thread').options.length === 2 && !document.getElementById('work-send').disabled");
    assert.equal(await evaluate("document.getElementById('work-title').textContent"), 'Unified task ' + width);
    await evaluate("document.getElementById('work-details').open = false; document.getElementById('work-inspect').click()");
    await until("!document.getElementById('work-inspector').hidden");
    assert.equal(await evaluate("document.getElementById('tasks-view').hidden"), false, 'inspection stays inside the task');
    await evaluate("document.getElementById('work-inspector-close').click()");
    assert.equal(await evaluate("document.getElementById('tasks-view').scrollWidth <= innerWidth"), true, JSON.stringify(await evaluate("({width:innerWidth,overflow:[...document.querySelectorAll('#tasks-view *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>[e.id,e.tagName,Math.round(e.getBoundingClientRect().right)]).slice(0,20)})")));
    if (process.env.TASK_SCREENSHOT_DIR) { const shot = await command('Page.captureScreenshot'); writeFileSync(join(process.env.TASK_SCREENSHOT_DIR, 'workspace-' + width + '.png'), Buffer.from(shot.data,'base64')); }
  }
  assert.equal(provider.calls.filter(c=>c.method==='send').length, 4);
  assert.equal(provider.calls.filter(c=>c.method==='respond').length, 4);
  assert.equal((await store.request({ method:'workspace.list' })).tasks.length, 4);
});
