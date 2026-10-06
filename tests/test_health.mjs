import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, validateConfig, createHealthStore, observe, eligible, parseLog,
  parseReview, redact, reviewIncident, createMonitor, notification, discover, watchActions, createHA } from '../agent-terminal/rootfs/opt/agent-terminal/health.mjs';
import { createSessionStore, serve } from '../agent-terminal/rootfs/opt/agent-terminal/sessions.mjs';
import { writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

const empty = () => ({ incidents: [], seen: [], baseline: false });
const log = (minute, message = 'Request failed for device 42', level = 'ERROR') => `2026-10-05 12:${String(minute).padStart(2, '0')}:00.000 ${level} (MainThread) [homeassistant.components.example] ${message}\n`;
const config = extra => ({ ...DEFAULTS, enabled: true, delayMinutes: 1, ...extra });
function fixture(t, extra = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'agent-health-test-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  let time = 1000000;
  const store = createHealthStore({ stateDir, now: () => time, ...extra });
  store.request({ method: 'health.save', config: config() });
  return { store, stateDir, now: () => time, advance: ms => { time += ms; } };
}

test('settings validate routes, devices, model selection, thresholds and explicit enablement', () => {
  assert.equal(validateConfig({}).enabled, false);
  assert.equal(validateConfig(config({ reviewer: 'ollama', model: 'example:4b', ollamaUrl: 'http://local.test:11434/' })).ollamaUrl, 'http://local.test:11434');
  for (const c of [{ enabled: 'true' }, { reviewer: 'shell' }, { ollamaUrl: 'file:///etc/passwd' }, { ollamaUrl: 'http://user:pass@host/' },
    { ollamaUrl: 'http://host/path' }, { repeatCount: 1 }, { criticalEntities: ['../../file'] },
    { notifyServices: ['notify.arbitrary_script'] }, { investigationAgent: 'custom' },
    { enabled: true, reviewer: 'ollama', ollamaUrl: 'http://local.test', model: 'example:cloud' },
    { enabled: true, reviewer: 'ollama', ollamaUrl: 'http://local.test', model: 'example:4b-cloud' }]) assert.throws(() => validateConfig(c));
});

test('log cursors ignore old errors, count only new entries, and group varying device IDs', () => {
  let state = observe(empty(), { log: log(0), states: [] }, config(), 1000000);
  assert.equal(state.incidents.length, 0);
  state = observe(state, { log: log(0) + log(1), states: [] }, config(), 1060000);
  assert.equal(state.incidents[0].count, 1);
  state = observe(state, { log: log(0) + log(1), states: [] }, config(), 1120000);
  assert.equal(state.incidents[0].count, 1);
  state = observe(state, { log: log(0) + log(1) + log(2, 'Request failed for device 99') + log(3), states: [] }, config(), 1180000);
  assert.equal(state.incidents.length, 1);
  assert.equal(state.incidents[0].count, 3);
  assert.equal(eligible(state.incidents[0], config(), 1180000), true);
});

test('a large unchanged log cannot replay errors that fell out of the bounded cursor', () => {
  const text = Array.from({ length: 4200 }, (_, i) => log(1, 'Failure #' + i)).join('');
  let state = observe(empty(), { log: text, states: [] }, config(), 1000000);
  state = observe(state, { log: text, states: [] }, config(), 1060000);
  assert.equal(state.incidents.length, 0);
  assert.equal(state.seen.length, 4000);
});

test('important entities respect delay, survive source failures and recover from live states', () => {
  const c = config({ criticalEntities: ['climate.main'] });
  let state = observe(empty(), { log: '', states: [{ entity_id: 'climate.main', state: 'unavailable' }] }, c, 1000000);
  assert.equal(eligible(state.incidents[0], c, 1000000), false);
  state = observe(state, { log: null, states: null }, c, 1060000);
  assert.equal(state.incidents[0].resolved, undefined, 'failure to read states is not recovery');
  assert.equal(eligible(state.incidents[0], c, 1060000), true);
  state = observe(state, { log: '', states: [{ entity_id: 'climate.main', state: 'heat' }] }, c, 1120000);
  assert.equal(state.incidents[0].resolved, 1120000);
  state = observe(state, { log: '', states: [{ entity_id: 'climate.main', state: 'unavailable' }] }, c, 1180000);
  assert.equal(state.incidents.length, 2, 'a recurrence owns a fresh incident and acknowledgement');
});

test('tracebacks and common secrets are redacted before persistence or review', () => {
  const entries = parseLog(log(1, 'token="sample secret" Bearer sample-token') + 'Traceback (most recent call last):\n  file.py\nValueError: password=another-secret\n');
  assert.equal(entries.length, 1);
  assert.match(entries[0].message, /ValueError/);
  assert.doesNotMatch(entries[0].message, /sample secret|sample-token|another-secret/);
  assert.doesNotMatch(redact('https://user:pass@example.test/?access_token=sample'), /user:pass|sample/);
  assert.equal(parseLog('\x1b[31m' + log(1) + '\x1b[0m')[0].level, 'ERROR');
});

test('log reads use a bounded Supervisor journal tail while states use the Core API', async () => {
  const requests = [];
  const ha = createHA({ token: 'example', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response(url.includes('/core/logs?') ? log(1) : '[]');
  } });
  assert.equal(await ha('/core/logs'), log(1));
  assert.deepEqual(await ha('/states'), []);
  assert.equal(requests[0].url, 'http://supervisor/core/logs?lines=1000&no_colors');
  assert.equal(requests[1].url, 'http://supervisor/core/api/states');
  assert.equal(requests[0].options.redirect, 'error');
  await assert.rejects(createHA({ fetchImpl: async () => new Response('too large') })('/core/logs', undefined, { limit: 2 }), /exceeds/);
});

test('review output validates severity, confidence and bounded plain text', () => {
  assert.equal(parseReview('```json\n{"severity":"major","confidence":0.9,"summary":"Failure","nextStep":"Inspect"}\n```').severity, 'major');
  for (const text of ['not json', '{"severity":"toString","confidence":1,"summary":"x","nextStep":"x"}', '{"severity":"major","confidence":2,"summary":"x","nextStep":"x"}']) assert.throws(() => parseReview(text));
});

test('local reviews use JSON schema, disable supported thinking and never give the model tools', async () => {
  const calls = [];
  const result = await reviewIncident({ evidence: 'api_key=test-secret', kind: 'log', title: 'Example', count: 3 }, config({ reviewer: 'ollama', model: 'example', ollamaUrl: 'http://local.test' }), {
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify(url.endsWith('/api/show') ? { capabilities: ['completion', 'thinking'] } : { message: { content: '{"severity":"major","confidence":0.9,"summary":"Persistent failure","nextStep":"Inspect logs"}' } }), { headers: { 'Content-Type': 'application/json' } });
    }
  });
  assert.equal(result.severity, 'major');
  assert.equal(calls[1].body.think, false);
  assert.equal(calls[1].body.stream, false);
  assert.equal(calls[1].body.tools, undefined);
  assert.doesNotMatch(JSON.stringify(calls[1].body.messages), /test-secret/);
  assert.equal(calls[1].redirect, 'error');
});

test('an Ollama cloud-backed model is refused before any incident is sent', async () => {
  const calls = [];
  await assert.rejects(reviewIncident({ evidence: 'incident' }, config({ reviewer: 'ollama', model: 'renamed', ollamaUrl: 'http://local.test' }), {
    fetchImpl: async url => { calls.push(url); return new Response(JSON.stringify({ remote_host: 'https://ollama.com' })); },
  }), /locally hosted/);
  assert.deepEqual(calls, ['http://local.test/api/show']);
});

test('HA reviewer selection rechecks control permissions and discovery excludes control agents', async () => {
  const agents = [
    { entity_id: 'conversation.readonly', state: 'unknown', attributes: { supported_features: 0, friendly_name: 'Review' } },
    { entity_id: 'conversation.control', state: 'unknown', attributes: { supported_features: 1 } },
  ];
  const result = await discover(async path => path === '/states' ? agents : [{ domain: 'notify', services: { mobile_app_test_device: {}, custom: {} } }]);
  assert.deepEqual(result.agents.map(a => a.id), ['conversation.readonly']);
  assert.deepEqual(result.notifyServices, ['notify.mobile_app_test_device']);
  let calls = 0;
  await assert.rejects(reviewIncident({ evidence: 'incident' }, config({ reviewer: 'homeassistant', agentId: 'conversation.control' }), { ha: async () => { calls++; return agents[1]; } }), /Turn off/);
  assert.equal(calls, 1);
});

test('disabled monitoring makes no HA or model requests', async t => {
  const { store, now } = fixture(t);
  store.request({ method: 'health.save', config: { ...DEFAULTS } });
  await createMonitor({ store, now, ha: () => { throw new Error('must not run'); } }).tick();
  assert.equal(store.snapshot().status.enabled, false);
});

test('known major incidents still alert if AI downgrades them, and recovery clears their tag', async t => {
  const { store, now, advance } = fixture(t);
  store.request({ method: 'health.save', config: config({ criticalEntities: ['climate.main'], notifyServices: ['notify.mobile_app_test_device'] }) });
  let state = 'unavailable', reviews = 0;
  const sent = [];
  const monitor = createMonitor({ store, now, ha: async path => path === '/core/logs' ? '' : [{ entity_id: 'climate.main', state }],
    reviewer: async () => { reviews++; return { severity: 'info', confidence: 0.1, summary: 'Probably fine', nextStep: 'Inspect' }; },
    notify: async (_service, item) => sent.push(notification(item, store.config(), 'test_agent_terminal')) });
  await monitor.tick(); assert.equal(sent.length, 0);
  advance(60000); await monitor.tick(); assert.equal(sent.length, 1);
  advance(60000); await monitor.tick(); assert.equal(sent.length, 1, 'cooldown prevents duplicates');
  assert.equal(reviews, 1);
  state = 'heat'; advance(60000); await monitor.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].message, 'clear_notification');
  assert.equal(sent[1].data.tag, sent[0].data.tag);
});

test('review and device failures do not suppress rule alerts or duplicate delivered devices', async t => {
  const { store, now, advance } = fixture(t);
  store.request({ method: 'health.save', config: config({ criticalEntities: ['climate.main'], notifyServices: ['notify.mobile_app_first', 'notify.mobile_app_second'] }) });
  const sent = [], monitor = createMonitor({ store, now,
    ha: async path => path === '/core/logs' ? '' : [{ entity_id: 'climate.main', state: 'unavailable' }],
    reviewer: async () => { throw new Error('review timeout'); },
    notify: async service => { sent.push(service); if (service.endsWith('second') && sent.length === 2) throw new Error('offline'); },
  });
  await monitor.tick(); advance(60000); await monitor.tick();
  assert.equal(store.snapshot().incidents[0].reviewError, 'review timeout');
  advance(60000); await monitor.tick();
  assert.deepEqual(sent, ['notify.mobile_app_first', 'notify.mobile_app_second', 'notify.mobile_app_second']);
});

test('changing settings or disabling while a review runs prevents stale notifications', async t => {
  const { store, now, advance } = fixture(t);
  store.request({ method: 'health.save', config: config({ criticalEntities: ['climate.main'], notifyServices: ['notify.mobile_app_test_device'] }) });
  const monitor = createMonitor({ store, now, ha: async path => path === '/core/logs' ? '' : [{ entity_id: 'climate.main', state: 'unavailable' }],
    reviewer: async () => { store.request({ method: 'health.save', config: { ...store.config(), enabled: false } }); return { severity: 'major', confidence: 1, summary: 'Major', nextStep: 'Inspect' }; },
    notify: () => { throw new Error('must not notify'); },
  });
  await monitor.tick(); advance(60000); await monitor.tick();
  assert.equal(store.snapshot().incidents[0].notifiedAt, 0);
});

test('snooze and dismiss persist independently of daemon writes and investigation reuses one named task', t => {
  const f = fixture(t);
  const optionsPath = join(f.stateDir, 'options.json'); writeFileSync(optionsPath, '{}');
  const sessions = createSessionStore({ stateDir: f.stateDir, optionsPath, homeDirectory: f.stateDir });
  const store = createHealthStore({ stateDir: f.stateDir, sessions, now: f.now });
  const state = observe(observe(empty(), { log: '', states: [] }, config(), f.now()), { log: log(1, 'database disk is full'), states: [] }, config(), f.now());
  store.saveObservations(state);
  const id = state.incidents[0].id;
  store.act(id, 'snooze'); store.saveObservations(state);
  assert.equal(store.incident(id).snoozedUntil, f.now() + 3600000);
  const first = store.investigate(id), second = store.investigate(id);
  assert.equal(first.session.id, second.session.id);
  assert.equal(first.session.agent, 'codex');
  assert.match(first.prompt, /read-only checks/);
  sessions.request({ method: 'stop', session: first.session.id });
  assert.equal(store.investigate(id).session.stopped, false);
  store.act(id, 'dismiss'); store.saveObservations(state);
  assert.equal(store.incident(id).dismissed, true);
  assert.throws(() => store.act('../file', 'dismiss'), /Invalid incident/);
});

test('damaged monitoring data leaves session controls usable', t => {
  const { store, stateDir } = fixture(t);
  const optionsPath = join(stateDir, 'options.json'); writeFileSync(optionsPath, '{}');
  const sessions = createSessionStore({ stateDir, optionsPath, homeDirectory: stateDir });
  writeFileSync(join(store.root, 'observations.json'), '{');
  assert.equal(sessions.snapshot().health.config.enabled, false);
  assert.match(sessions.snapshot().health.status.errors[0], /Could not read health data/);
  const record = sessions.create({ name: 'Other task', agent: 'codex', workspace: 'homeassistant' });
  assert.equal(sessions.rename(record.id, 'Still available').name, 'Still available');
});

test('a slow reviewer does not block session controls or write after disconnect', async t => {
  const input = new EventEmitter(); input.setEncoding = () => {};
  const messages = []; let finish;
  const store = { snapshot: () => ({ sessions: [], health: {} }),
    request: request => request.method === 'health.test' ? new Promise(resolve => { finish = resolve; }) : { name: 'Ready' } };
  serve(store, input, { write: text => messages.push(JSON.parse(text)) });
  t.after(() => input.emit('close'));
  input.emit('data', '{"request":1,"method":"health.test"}\n{"request":2,"method":"rename"}\n');
  assert.equal(messages.find(m => m.request === 2).result.name, 'Ready');
  assert.equal(messages.find(m => m.request === 1), undefined);
  finish({ severity: 'major' }); await new Promise(setImmediate);
  assert.equal(messages.find(m => m.request === 1).result.severity, 'major');
  input.emit('data', '{"request":3,"method":"health.test"}\n');
  input.emit('close'); const count = messages.length;
  finish({ severity: 'major' }); await new Promise(setImmediate);
  assert.equal(messages.length, count);
});

test('disabling during delivery prevents sends to subsequent devices', async t => {
  const { store, now, advance } = fixture(t);
  store.request({ method: 'health.save', config: config({ criticalEntities: ['climate.main'], notifyServices: ['notify.mobile_app_first', 'notify.mobile_app_second'] }) });
  const deliveries = [];
  const monitor = createMonitor({ store, now, ha: async path => path === '/core/logs' ? '' : [{ entity_id: 'climate.main', state: 'unavailable' }],
    notify: async service => {
      deliveries.push(service);
      store.request({ method: 'health.save', config: { ...store.config(), enabled: false } });
    },
  });
  await monitor.tick(); advance(60000); await monitor.tick();
  assert.deepEqual(deliveries, ['notify.mobile_app_first']);
});

test('reenabling establishes a fresh baseline instead of alerting on disabled-period logs', async t => {
  const { store, now, advance } = fixture(t);
  let text = log(0);
  const monitor = createMonitor({ store, now, ha: async path => path === '/core/logs' ? text : [], notify: () => assert.fail('no alerts') });
  await monitor.tick();
  store.request({ method: 'health.save', config: { ...store.config(), enabled: false } });
  text += log(1, 'database disk is full'); advance(60000); await monitor.tick();
  store.request({ method: 'health.save', config: { ...store.config(), enabled: true } });
  advance(60000); await monitor.tick();
  assert.equal(store.snapshot().incidents.length, 0);
});

test('notification action subscription accepts only current incident actions and closes on stop', t => {
  const f = fixture(t), state = observe(empty(), { log: '', states: [{ entity_id: 'climate.main', state: 'unavailable' }] }, config({ criticalEntities: ['climate.main'] }), f.now());
  f.store.saveObservations(state); const id = state.incidents[0].id;
  let ws;
  class Socket extends EventTarget {
    sent = []; closed = false;
    constructor() { super(); ws = this; }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.closed = true; this.dispatchEvent(new Event('close')); }
    packet(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  }
  const stop = watchActions({ token: 'test', store: f.store, WebSocketImpl: Socket }); t.after(stop);
  ws.packet({ type: 'auth_required' }); ws.packet({ type: 'auth_ok' });
  assert.equal(ws.sent[1].event_type, 'mobile_app_notification_action');
  ws.packet({ type: 'event', id: 1, event: { data: { action: 'AGENT_HEALTH_SNOOZE_' + id } } });
  assert.ok(f.store.incident(id).snoozedUntil);
  ws.packet({ type: 'event', id: 99, event: { data: { action: 'AGENT_HEALTH_DISMISS_' + id } } });
  assert.equal(f.store.incident(id).dismissed, undefined);
  stop(); assert.equal(ws.closed, true);
});
