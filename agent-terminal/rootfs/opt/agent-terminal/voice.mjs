// Dictation uses the preferred Home Assistant speech-to-text provider. This
// authenticated ttyd control stream accepts PCM audio, never a URL or command.
// Audio stays in memory and only the transcription is returned to the browser.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SAMPLE_RATE = 16000;
export const MAX_SECONDS = 120;
export const MAX_BYTES = SAMPLE_RATE * 2 * MAX_SECONDS;
const MAX_CHUNK = 65536;
const MAX_LINE = 100000;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SETUP = 'Choose a speech-to-text provider for your preferred voice assistant in Home Assistant Settings → Voice assistants.';

export function preferredSpeech(token, { signal, WebSocketImpl = WebSocket } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl('ws://supervisor/core/websocket');
    let settled = false;
    const done = (error, provider) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      socket.close();
      if (error) reject(error); else resolve(provider);
    };
    const aborted = () => done(new Error('Voice prompt cancelled.'));
    const timer = setTimeout(() => done(new Error('Home Assistant did not answer. Try again.')), 10000);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    socket.addEventListener('error', () => done(new Error('Could not reach Home Assistant.')));
    socket.addEventListener('close', () => done(new Error('Home Assistant disconnected.')));
    socket.addEventListener('message', event => {
      if (settled) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'auth_required') socket.send(JSON.stringify({ type: 'auth', access_token: token }));
        else if (message.type === 'auth_invalid') done(new Error('The add-on could not authenticate with Home Assistant.'));
        else if (message.type === 'auth_ok') socket.send(JSON.stringify({ id: 1, type: 'assist_pipeline/pipeline/list' }));
        else if (message.type === 'result' && message.id === 1) {
          const result = message.result;
          const pipeline = result?.pipelines?.find(p => p.id === result.preferred_pipeline);
          // Never silently fall back to another (possibly cloud) provider.
          if (!message.success || !pipeline?.stt_engine || !pipeline.stt_language) throw new Error(SETUP);
          if (!/^[a-zA-Z0-9_.-]+$/.test(pipeline.stt_engine) || !/^[a-zA-Z0-9_-]+$/.test(pipeline.stt_language)) throw new Error(SETUP);
          done(null, { engine: pipeline.stt_engine, language: pipeline.stt_language });
        }
      } catch (error) { done(new Error(error.message === SETUP ? SETUP : 'Could not read Home Assistant voice settings.')); }
    });
  });
}

export async function transcribeSpeech(provider, bytes, { token, signal, fetchImpl = fetch } = {}) {
  const response = await fetchImpl('http://supervisor/core/api/stt/' + encodeURIComponent(provider.engine), {
    method: 'POST', signal,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/octet-stream',
      'X-Speech-Content': 'format=wav; codec=pcm; sample_rate=16000; bit_rate=16; channel=1; language=' + provider.language,
    },
    // The STT API consumes raw PCM, as does Assist's binary audio stream.
    body: bytes,
  });
  if (response.status === 404) throw new Error('The configured speech-to-text provider is unavailable. ' + SETUP);
  if (response.status === 415) throw new Error('The speech provider must support 16 kHz, 16-bit mono PCM audio.');
  if (!response.ok) throw new Error('Speech-to-text failed. Check the voice provider in Home Assistant and try again.');
  const result = await response.json();
  if (result.result !== 'success' || typeof result.text !== 'string' || !result.text.trim()) {
    throw new Error('No speech was recognized. Try speaking again.');
  }
  const text = result.text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
  if (!text || text.length > 32000) throw new Error('The transcription could not be used. Try a shorter recording.');
  return { text };
}

export function createVoiceStore({ token, getProvider = preferredSpeech, transcribe = transcribeSpeech,
  maxBytes = MAX_BYTES, idleMs = (MAX_SECONDS + 30) * 1000, transcriptionMs = 120000 } = {}) {
  let current = null, serial = 0;
  function clear(record) {
    clearTimeout(record.timer); record.abort.abort(); record.chunks = [];
    if (current === record) current = null;
  }
  function deadline(record, ms) {
    clearTimeout(record.timer);
    record.timer = setTimeout(() => clear(record), ms);
    record.timer.unref?.();
  }
  function find(id, state) {
    if (!current || current.id !== id || (state && current.state !== state)) throw new Error('This recording has ended. Start a new voice prompt.');
    return current;
  }
  async function begin() {
    if (current) throw new Error('A voice prompt is already in progress.');
    const record = { id: String(++serial), chunks: [], size: 0, state: 'starting', abort: new AbortController() };
    current = record; deadline(record, idleMs);
    try {
      record.provider = await getProvider(token, { signal: record.abort.signal });
      if (current !== record || record.abort.signal.aborted) throw new Error('Voice prompt cancelled.');
      record.state = 'recording';
      return { recording: record.id, sampleRate: SAMPLE_RATE, maxSeconds: Math.min(MAX_SECONDS, maxBytes / 2 / SAMPLE_RATE) };
    } catch (error) { clear(record); throw error; }
  }
  function chunk(id, data) {
    const record = find(id, 'recording');
    if (typeof data !== 'string' || data.length > MAX_LINE || !BASE64.test(data)) {
      clear(record); throw new Error('Invalid audio data.');
    }
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length % 2 || bytes.length > MAX_CHUNK || record.size + bytes.length > maxBytes) {
      clear(record); throw new Error('The recording is too long or its audio is incomplete.');
    }
    record.chunks.push(bytes); record.size += bytes.length;
    return { received: record.size };
  }
  async function finish(id) {
    const record = find(id, 'recording');
    if (!record.size) { clear(record); throw new Error('No audio was recorded. Try again.'); }
    record.state = 'transcribing'; deadline(record, transcriptionMs);
    const bytes = Buffer.concat(record.chunks, record.size); record.chunks = [];
    try {
      const result = await transcribe(record.provider, bytes, { token, signal: record.abort.signal });
      if (current !== record || record.abort.signal.aborted) throw new Error('Voice prompt cancelled or timed out.');
      return result;
    } catch (error) {
      if (record.abort.signal.aborted) throw new Error('Voice prompt cancelled or timed out. Try a shorter recording.');
      throw error;
    } finally { clear(record); }
  }
  function cancel(id) { clear(find(id)); return true; }
  const abortAll = () => { if (current) clear(current); };
  function request(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid request.');
    switch (input.method) {
      case 'begin': return begin();
      case 'chunk': return chunk(input.recording, input.data);
      case 'finish': return finish(input.recording);
      case 'cancel': return cancel(input.recording);
      default: throw new Error('Unknown voice operation.');
    }
  }
  return { request, abortAll };
}

export function serve(store, input = process.stdin, output = process.stdout) {
  if (input.isTTY) input.setRawMode(true);
  input.setEncoding('utf8');
  let buffer = '', closed = false, inFlight = 0;
  const send = value => { if (!closed) output.write(JSON.stringify(value) + '\n'); };
  const end = () => { closed = true; store.abortAll(); };
  input.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (line.length > MAX_LINE || inFlight >= 4) { end(); input.destroy(); return; }
      let request;
      try {
        request = JSON.parse(line);
        if (!Number.isSafeInteger(request?.request) || request.request < 0) throw new Error('Invalid request number.');
        inFlight++;
        Promise.resolve().then(() => { if (!closed) return store.request(request); }).then(
          result => send({ request: request.request, result }),
          error => send({ request: request.request, error: error.message }),
        ).finally(() => { inFlight--; });
      } catch (error) { send({ request: null, error: error.message }); }
    }
    if (buffer.length > MAX_LINE) { end(); input.destroy(); }
  });
  input.on('end', end); input.on('close', end); input.on('error', end);
  send({ type: 'ready', maxSeconds: MAX_SECONDS });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let token = process.env.SUPERVISOR_TOKEN;
  if (!token) { try { token = readFileSync('/run/s6/container_environment/SUPERVISOR_TOKEN', 'utf8').trim(); } catch {} }
  if (!token || process.argv[2] !== 'serve' || process.argv.length !== 3) {
    console.error('Voice prompting requires the Home Assistant add-on.'); process.exitCode = 1;
  } else serve(createVoiceStore({ token }));
}
