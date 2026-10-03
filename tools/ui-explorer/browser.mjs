import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function launchBrowser({ executable, origin, viewport }) {
  const profile = await mkdtemp(join(tmpdir(), 'agent-explorer-'));
  const child = spawn(executable, ['--headless', '--disable-dev-shm-usage', '--disable-gpu',
    '--disable-background-networking', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let buffer = '', nextId = 0, session, stderr = '', failure;
  const pending = new Map(), events = [];
  function fail(error) {
    failure = error;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  }
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  child.on('error', fail);
  child.on('exit', () => fail(new Error('Chromium exited: ' + stderr)));
  function command(method, params = {}, sessionId = session) {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Browser command timed out: ' + method)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0', error => { if (error) fail(error); });
    });
  }
  child.stdio[4].on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (message.method === 'Fetch.requestPaused') {
        const url = new URL(message.params.request.url);
        const allowed = url.origin === origin;
        if (!allowed) events.push({ type: 'blocked-network', url: url.href });
        command(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
          requestId: message.params.requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}),
        }, message.sessionId).catch(error => events.push({ type: 'browser-error', message: error.message }));
      } else if (message.method === 'Runtime.exceptionThrown') {
        events.push({ type: 'page-error', details: message.params.exceptionDetails });
      } else if (message.method === 'Page.javascriptDialogOpening') {
        events.push({ type: 'dialog-dismissed', message: message.params.message });
        command('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
      }
      const p = pending.get(message.id);
      if (!p) continue;
      clearTimeout(p.timer); pending.delete(message.id);
      if (message.error) p.reject(new Error(JSON.stringify(message.error))); else p.resolve(message.result);
    }
  });
  async function close() {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit').catch(() => {});
      const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { await command('Browser.close', {}, undefined); } catch { child.kill('SIGTERM'); }
      await exited; clearTimeout(kill);
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  try {
    await once(child, 'spawn');
    const target = await command('Target.createTarget', { url: 'about:blank' });
    session = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    await command('Page.enable'); await command('Runtime.enable');
    await command('Browser.setDownloadBehavior', { behavior: 'deny' });
    await command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await command('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
    await command('Page.navigate', { url: origin + '/?arg=codex&arg=homeassistant' });
    let ready = false;
    for (let n = 0; n < 100; n++) {
      if (await evaluate("!!window.testSocket?.onmessage && document.getElementById('overlay')?.hidden && !!document.querySelector('#keys-agent button')")) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error('Test page did not become ready');
    return { command, evaluate, close, events,
      screenshot: async () => (await command('Page.captureScreenshot', { format: 'png' })).data,
      evidence: () => evaluate(`({ sessions: window.testHub.sessions, inputs: window.testPackets,
        url: location.href, split: document.body.classList.contains('split'),
        rightInputs: document.getElementById('side-terminal')?.contentWindow?.testPackets || [] })`),
    };
  } catch (error) { await close(); throw error; }
}
