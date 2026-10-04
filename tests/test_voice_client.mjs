import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../agent-terminal/rootfs/opt/webui/voice.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, settings = {}) {
  const requests = [], states = [], texts = [], errors = [], sockets = [];
  let ctx, finish;
  const track = { stopped: 0, stop() { this.stopped++; } };
  const stream = { getTracks: () => [track] };
  class Audio {
    sampleRate = 48000;
    destination = {};
    constructor() { ctx = this; }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return this.processor = { connect() {}, disconnect() {} }; }
  }
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor(url) { assert.equal(new URL(url).searchParams.get('arg'), 'voice'); sockets.push(this); queueMicrotask(() => this.onopen()); }
    send(data) {
      const text = new TextDecoder().decode(data);
      if (text[0] === '{') { queueMicrotask(() => this.packet({ type: 'ready' })); return; }
      const request = JSON.parse(text.slice(1)); requests.push(request);
      let result = true;
      if (request.method === 'begin') result = { recording: '1', sampleRate: 16000, maxSeconds: 120 };
      else if (request.method === 'finish') {
        finish = () => this.packet({ request: request.request, result: { text: 'Review the kitchen dashboard.' } });
        if (!settings.holdFinish) queueMicrotask(finish);
        return;
      }
      queueMicrotask(() => this.packet(settings.beginError && request.method === 'begin'
        ? { request: request.request, error: 'Choose a speech-to-text provider.' } : { request: request.request, result }));
    }
    packet(value) { this.onmessage?.({ data: '0' + JSON.stringify(value) + '\n' }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const window = { isSecureContext: settings.secure !== false, AudioContext: Audio };
  vm.runInNewContext(source, { window, navigator: { mediaDevices: { getUserMedia: settings.mic || (() => Promise.resolve(stream)) } },
    location: new URL('https://ha.test/api/hassio_ingress/example/'), WebSocket: Socket,
    TextEncoder, TextDecoder, Uint8Array, DataView, btoa, Date,
    fetch: async () => ({ json: async () => ({ token: 'ingress-token' }) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const client = new window.AgentVoice({ base: '/api/hassio_ingress/example', tokenUrl: '/token',
    onstate: state => states.push(state), ontext: text => texts.push(text), onerror: error => errors.push(error) });
  t.after(() => client.cancel());
  return { client, window, requests, states, texts, errors, sockets, track, stream,
    context: () => ctx, finish: () => finish(),
    feed: () => ctx.processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.5) } }),
  };
}

test('PCM resampling preserves duration across chunk boundaries and clips safely', t => {
  const f = fixture(t);
  for (const rate of [16000, 44100, 48000]) {
    const convert = f.window.AgentVoicePCM(rate), result = [];
    for (let at = 0; at < rate; at += 1024) result.push(Buffer.from(convert(new Float32Array(Math.min(1024, rate - at)).fill(0.5))));
    const bytes = Buffer.concat(result);
    assert.equal(bytes.length, 32000, rate + ' Hz produces exactly one second of PCM');
    assert.equal(bytes.readInt16LE(), 16384);
  }
  const limits = Buffer.from(f.window.AgentVoicePCM(16000)(new Float32Array([-2, 0, 2])));
  assert.deepEqual([limits.readInt16LE(0), limits.readInt16LE(2), limits.readInt16LE(4)], [-32768, 0, 32767]);
});

test('voice capture releases the microphone before transcription and returns a draft', async t => {
  const f = fixture(t); f.client.start(); await tick();
  assert.equal(f.client.state(), 'recording'); f.feed(); f.client.stop();
  assert.equal(f.track.stopped, 1); assert.equal(f.context().closed, true);
  assert.equal(f.client.state(), 'transcribing'); await tick();
  assert.equal(f.client.state(), 'idle');
  assert.deepEqual(f.texts, ['Review the kitchen dashboard.']);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.requests.map(r => r.method), ['begin', 'chunk', 'finish']);
  const bytes = Buffer.from(f.requests[1].data, 'base64');
  assert.equal(bytes.length, 2730); assert.equal(bytes.readInt16LE(), 16384);
  assert.equal(f.sockets[0].readyState, 3);
});

test('cancelling transcription ignores late results and frees the microphone', async t => {
  const f = fixture(t, { holdFinish: true }); f.client.start(); await tick(); f.feed(); f.client.stop(); await tick();
  f.client.cancel(); f.finish(); await tick();
  assert.deepEqual(f.texts, []); assert.deepEqual(f.errors, []);
  assert.equal(f.track.stopped, 1); assert.equal(f.client.state(), 'idle');
});

test('late microphone permission after cancellation stops the granted stream', async t => {
  let permit;
  const f = fixture(t, { mic: () => new Promise(resolve => { permit = resolve; }) });
  f.client.start(); await tick(); f.client.cancel(); permit(f.stream); await tick();
  assert.equal(f.track.stopped, 1); assert.equal(f.client.state(), 'idle');
  assert.deepEqual(f.texts, []); assert.deepEqual(f.errors, []);
});

test('denied microphone, insecure pages and unavailable speech providers give actionable errors', async t => {
  const denied = fixture(t, { mic: async () => { const error = new Error('denied'); error.name = 'NotAllowedError'; throw error; } });
  denied.client.start(); await tick();
  assert.match(denied.errors[0], /Allow microphone access/); assert.equal(denied.context().closed, true);
  const insecure = fixture(t, { secure: false }); insecure.client.start();
  assert.match(insecure.errors[0], /HTTPS/); assert.equal(insecure.context(), undefined);
  const missing = fixture(t, { beginError: true }); missing.client.start(); await tick();
  assert.match(missing.errors[0], /speech-to-text provider/); assert.equal(missing.track.stopped, 1);
  assert.equal(missing.client.state(), 'idle');
});
