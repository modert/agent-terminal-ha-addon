import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createVoiceStore, preferredSpeech, transcribeSpeech, serve } from '../agent-terminal/rootfs/opt/agent-terminal/voice.mjs';

const provider = { engine: 'stt.whisper', language: 'en' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const audio = Buffer.from([0, 0, 255, 127, 0, 128, 0, 0]);
const start = store => store.request({ method: 'begin' });
const chunk = (store, id, data = audio) => store.request({ method: 'chunk', recording: id, data: data.toString('base64') });

test('dictation preserves PCM bytes and returns only text using the configured provider', async () => {
  const calls = [];
  const store = createVoiceStore({ token: 'server-only', getProvider: async token => {
    assert.equal(token, 'server-only'); return provider;
  }, transcribe: async (selection, bytes, options) => {
    calls.push({ selection, bytes, options }); return { text: 'Review the kitchen dashboard.' };
  } });
  const { recording } = await start(store);
  assert.deepEqual(chunk(store, recording), { received: 8 });
  chunk(store, recording, audio);
  assert.deepEqual(await store.request({ method: 'finish', recording, url: 'https://untrusted.example', command: 'whoami' }),
    { text: 'Review the kitchen dashboard.' });
  assert.deepEqual(calls[0].selection, provider);
  assert.deepEqual(calls[0].bytes, Buffer.concat([audio, audio]));
  assert.equal(calls[0].options.token, 'server-only');
  assert.throws(() => chunk(store, recording), /ended/);
  assert.throws(() => store.request({ method: 'execute' }), /Unknown voice operation/);
});

test('oversized, malformed and empty recordings never reach speech-to-text', async () => {
  let transcriptions = 0;
  const store = createVoiceStore({ maxBytes: 8, getProvider: async () => provider,
    transcribe: async () => { transcriptions++; } });
  for (const data of ['not base64', 'AA==', Buffer.alloc(10).toString('base64'), '']) {
    const { recording } = await start(store);
    assert.throws(() => store.request({ method: 'chunk', recording, data }), /audio|recording/);
    await assert.rejects(store.request({ method: 'finish', recording }), /ended/);
  }
  const { recording } = await start(store);
  await assert.rejects(start(store), /already/);
  await assert.rejects(store.request({ method: 'finish', recording }), /No audio/);
  assert.equal(transcriptions, 0);
});

test('cancel, disconnect and deadlines abort transcription and reject late results', async () => {
  let complete, aborted;
  const store = createVoiceStore({ getProvider: async () => provider,
    transcribe: (_provider, _bytes, { signal }) => { aborted = signal; return new Promise(resolve => { complete = resolve; }); } });
  const { recording } = await start(store); chunk(store, recording);
  const result = store.request({ method: 'finish', recording });
  store.abortAll();
  assert.equal(aborted.aborted, true);
  complete({ text: 'This must not reach another draft' });
  await assert.rejects(result, /cancelled/);
  const second = await start(store);
  assert.equal(store.request({ method: 'cancel', recording: second.recording }), true);
  assert.throws(() => chunk(store, second.recording), /ended/);
  const expiring = createVoiceStore({ getProvider: async () => provider, idleMs: 5 });
  const stale = await start(expiring); await delay(10);
  assert.throws(() => chunk(expiring, stale.recording), /ended/);
});

test('speech HTTP requests use fixed Home Assistant routes and sanitize transcript controls', async () => {
  let request;
  const result = await transcribeSpeech(provider, audio, { token: 'only-server', fetchImpl: async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ result: 'success', text: ' hello\x1b\x00 world ' }) };
  } });
  assert.equal(request.url, 'http://supervisor/core/api/stt/stt.whisper');
  assert.equal(request.options.headers.Authorization, 'Bearer only-server');
  assert.match(request.options.headers['X-Speech-Content'], /sample_rate=16000; bit_rate=16; channel=1; language=en/);
  assert.deepEqual(request.options.body, audio);
  assert.deepEqual(result, { text: 'hello world' });
  for (const response of [
    { ok: false, status: 404 }, { ok: false, status: 415 }, { ok: false, status: 500 },
    { ok: true, json: async () => ({ result: 'error', text: '' }) },
  ]) await assert.rejects(transcribeSpeech(provider, audio, { fetchImpl: async () => response }));
});

test('provider discovery selects only the preferred assistant and authenticates server-side', async () => {
  let ws;
  class Socket extends EventTarget {
    sent = [];
    constructor(url) { super(); assert.equal(url, 'ws://supervisor/core/websocket'); ws = this; }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.closed = true; }
    message(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  }
  const promise = preferredSpeech('private-token', { WebSocketImpl: Socket });
  ws.message({ type: 'auth_required' }); ws.message({ type: 'auth_ok' });
  assert.deepEqual(ws.sent, [{ type: 'auth', access_token: 'private-token' }, { id: 1, type: 'assist_pipeline/pipeline/list' }]);
  ws.message({ type: 'result', id: 1, success: true, result: { preferred_pipeline: 'local', pipelines: [
    { id: 'cloud', stt_engine: 'stt.cloud', stt_language: 'en' },
    { id: 'local', stt_engine: 'stt.whisper', stt_language: 'en' },
  ] } });
  assert.deepEqual(await promise, provider); assert.equal(ws.closed, true);
  const missing = preferredSpeech('private-token', { WebSocketImpl: Socket });
  ws.message({ type: 'result', id: 1, success: true, result: { preferred_pipeline: 'missing', pipelines: [{ id: 'cloud', stt_engine: 'stt.cloud', stt_language: 'en' }] } });
  await assert.rejects(missing, /Choose a speech-to-text provider/);
});

test('voice PTY protocol reassembles fragments and cancels in-flight work on disconnect', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let transcript, signal, data = '';
  output.on('data', bytes => { data += bytes; });
  const store = createVoiceStore({ getProvider: async () => provider,
    transcribe: (_p, _b, options) => { signal = options.signal; return new Promise(resolve => { transcript = resolve; }); } });
  serve(store, input, output);
  input.write('{"request":1,"method":"be'); input.write('gin"}\n'); await tick();
  input.write(JSON.stringify({ request: 2, method: 'chunk', recording: '1', data: audio.toString('base64') }) + '\n'); await tick();
  input.write('{"request":3,"method":"finish","recording":"1"}\n'); await tick();
  input.end(); await tick();
  assert.equal(signal.aborted, true);
  transcript({ text: 'discard me' }); await tick();
  const packets = data.trim().split('\n').map(JSON.parse);
  assert.equal(packets[0].type, 'ready');
  assert.equal(packets.find(p => p.request === 1).result.recording, '1');
  assert.equal(packets.some(p => p.request === 3), false, 'a closed channel never receives a late transcript');
  const oversized = new PassThrough(); serve(store, oversized, new PassThrough());
  oversized.write('x'.repeat(100001) + '\n'); assert.equal(oversized.destroyed, true);
  let starts = 0;
  const flooded = new PassThrough();
  serve(createVoiceStore({ getProvider: async () => { starts++; return provider; } }), flooded, new PassThrough());
  flooded.write(Array.from({ length: 5 }, (_, request) => JSON.stringify({ request, method: 'begin' }) + '\n').join(''));
  await tick(); assert.equal(flooded.destroyed, true); assert.equal(starts, 0, 'queued requests cannot restart work after disconnect');
});
