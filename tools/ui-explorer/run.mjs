#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture.mjs';
import { launchBrowser } from './browser.mjs';
import { performAction } from './actions.mjs';
import { nextAction, ollamaRequest } from './ollama.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: {
  help: { type: 'boolean' }, check: { type: 'boolean' },
  ollama: { type: 'string', default: process.env.OLLAMA_URL || 'http://127.0.0.1:11434' },
  model: { type: 'string', default: 'qwen3-vl:4b-instruct' },
  chromium: { type: 'string', default: process.env.CHROMIUM_BIN || '/usr/bin/chromium' },
  bundle: { type: 'string', default: process.env.WEBUI_BUNDLE || join(root, 'agent-terminal/rootfs/opt/webui/index.html') },
  output: { type: 'string', default: join(root, 'artifacts/ui-explorer', new Date().toISOString().replaceAll(':','-')) },
  goal: { type: 'string', default: 'Create a second ChatGPT session named UI exploration, then open two different sessions side by side. Explore switching sessions and report anything confusing.' },
  steps: { type: 'string', default: '16' }, minutes: { type: 'string', default: '8' },
  'request-seconds': { type: 'string', default: '120' },
  width: { type: 'string', default: '1280' }, height: { type: 'string', default: '800' },
} });
if (values.help) {
  console.log(`Usage: node tools/ui-explorer/run.mjs [options]
  --ollama URL           Local Ollama origin (or OLLAMA_URL)
  --model NAME           Installed vision model; default qwen3-vl:4b-instruct
  --goal TEXT            Free-form exploratory task
  --steps N              Decision limit (default 16)
  --minutes N            Overall time budget (default 8)
  --request-seconds N    Per-model-request limit (default 120)
  --width N --height N   Desktop viewport, also supports narrow desktop widths
  --bundle PATH         Built UI bundle, never a live website
  --output PATH         New directory for screenshots, JSON and Markdown report
  --chromium PATH       Chromium executable, launched as a non-root user
  --check               Check browser, fixture, and model metadata without inference
Runs are manual. Only the model chooses exploratory actions. No provider API keys are needed.`);
  process.exit(0);
}
function number(name, min, max, integer = true) {
  const n = Number(values[name]);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`--${name} must be between ${min} and ${max}`);
  return n;
}
const steps = number('steps', 1, 200), minutes = number('minutes', 0.1, 60, false);
const requestMs = number('request-seconds', 1, 300) * 1000;
const viewport = { width: number('width', 320, 1920), height: number('height', 480, 1440) };
const output = resolve(values.output);
await mkdir(resolve(output, '..'), { recursive: true });
await mkdir(output); // Never overwrite evidence from an earlier run.
const started = Date.now(), deadline = started + minutes * 60000;
const remaining = () => Math.max(1, deadline - Date.now());
const stop = new AbortController();
const interrupt = () => stop.abort(new Error('Run interrupted'));
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
let fixture, browser, runtimeError;
const report = { started: new Date(started).toISOString(), model: values.model,
  goal: values.goal, viewport, limits: { steps, minutes, requestSeconds: requestMs / 1000 },
  mode: 'isolated-ui-fixture', status: 'starting', decisions: [],
  limitations: ['Terminal and session transport are simulated; no live agents, tmux, or Home Assistant are exercised.',
    'Model observations are exploratory evidence, not a test-suite pass or verified bug report.'],
};
try { report.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { report.commit = 'unknown'; }
async function screenshot(name) {
  const data = await browser.screenshot();
  await writeFile(join(output, name), Buffer.from(data, 'base64'));
  return data;
}
try {
  fixture = await startFixture(resolve(values.bundle));
  report.bundleSha256 = fixture.bundleSha256;
  browser = await launchBrowser({ executable: values.chromium, origin: fixture.origin, viewport });
  const metadata = await ollamaRequest(values.ollama, '/api/show', { model: values.model }, Math.min(10000, remaining()), stop.signal);
  report.modelCapabilities = metadata.capabilities;
  if (!metadata.capabilities?.includes('vision')) throw new Error('Selected model does not report vision support');
  report.initialEvidence = await browser.evidence();
  await screenshot('initial.png');
  if (values.check) report.status = 'ready';
  else {
    let invalidCount = 0, unchangedRepeats = 0, lastAction = '';
    report.status = 'step_limit';
    for (let step = 1; step <= steps; step++) {
      if (stop.signal.aborted) { report.status = 'interrupted'; break; }
      if (Date.now() >= deadline) { report.status = 'time_limit'; break; }
      const before = `${String(step).padStart(3, '0')}-before.png`;
      const shot = await screenshot(before);
      const begin = Date.now();
      console.log(JSON.stringify({ step, status: 'thinking', model: values.model }));
      const decision = await nextAction({ base: values.ollama, model: values.model,
        thinking: metadata.capabilities.includes('thinking'), timeoutMs: Math.min(requestMs, remaining()), signal: stop.signal,
        goal: values.goal, viewport, step, steps, screenshot: shot,
        history: report.decisions.map(d => {
          const { reason, ...action } = d.action || {};
          return { action, error: d.error, screenChanged: d.screenChanged, feedback: d.feedback };
        }),
      });
      const entry = { step, before, ...decision, elapsedMs: Date.now() - begin };
      report.decisions.push(entry);
      if (decision.error) {
        invalidCount++;
        console.log(JSON.stringify({ step, error: decision.error }));
      } else if (stop.signal.aborted) report.status = 'interrupted';
      else if (Date.now() >= deadline) report.status = 'time_limit';
      else {
        invalidCount = 0;
        await performAction(browser, decision.action, viewport);
        await new Promise(resolve => setTimeout(resolve, 180));
        entry.after = `${String(step).padStart(3, '0')}-after.png`;
        const after = await screenshot(entry.after);
        entry.screenChanged = shot !== after;
        const { reason, ...parameters } = decision.action;
        const signature = JSON.stringify(parameters);
        unchangedRepeats = !entry.screenChanged && signature === lastAction ? unchangedRepeats + 1 : 0;
        lastAction = signature;
        if (unchangedRepeats >= 2) entry.feedback = 'Repeated identical actions left the screenshot unchanged. Re-read the CURRENT screenshot; choose a different action or finish if the goal is complete.';
        if (unchangedRepeats >= 5) report.status = 'stalled';
        entry.evidence = await browser.evidence();
        console.log(JSON.stringify({ step, action: decision.action, seconds: Math.round(entry.elapsedMs / 100) / 10 }));
        if (decision.action.action === 'done') report.status = 'model_finished';
      }
      await appendFile(join(output, 'actions.jsonl'), JSON.stringify(entry) + '\n');
      if (['time_limit', 'model_finished', 'interrupted', 'stalled'].includes(report.status)) break;
      if (invalidCount >= 3) { report.status = 'invalid_model_actions'; break; }
    }
  }
} catch (error) {
  runtimeError = error;
  report.status = stop.signal.aborted ? 'interrupted' : Date.now() >= deadline ? 'time_limit' : 'error'; report.error = error.message;
} finally {
  if (browser) {
    try { report.finalEvidence = await browser.evidence(); await screenshot('final.png'); }
    catch (error) { report.evidenceError = error.message; }
    report.browserEvents = browser.events;
    try { await browser.close(); } catch (error) { report.cleanupError = error.message; }
  }
  if (fixture) await fixture.close();
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  report.durationSeconds = Math.round((Date.now() - started) / 100) / 10;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const lines = ['# Agent Terminal exploratory run', '', `Status: ${report.status}`, `Model: ${report.model}`,
    `Commit: ${report.commit}`, `UI SHA-256: ${report.bundleSha256 || 'unavailable'}`,
    `Duration: ${report.durationSeconds}s`, '', `Goal: ${report.goal}`, '',
    ...report.limitations.map(x => '- ' + x), '', '## Decisions', '',
    ...report.decisions.flatMap(d => [`${d.step}. ${d.action?.action || 'invalid'}: ${d.action?.reason || d.error}`,
      `   [Before](${d.before})${d.after ? ` · [After](${d.after})` : ''}`]), '',
    ...(report.error ? ['Error: ' + report.error, ''] : []),
    'Raw decisions, timings, fixture state and browser errors are in report.json and actions.jsonl.', ''];
  await writeFile(join(output, 'report.md'), lines.join('\n'));
  console.log(JSON.stringify({ status: report.status, output, decisions: report.decisions.length, seconds: report.durationSeconds }));
}
if (runtimeError || report.status === 'invalid_model_actions') process.exitCode = 1;
