/* Microphone dictation. Audio and transcription travel through the add-on's
 * authenticated voice channel; neither a provider token nor a URL comes from
 * the page. Nothing is submitted to the terminal by this module. */
window.AgentVoicePCM = function (rate) {
  'use strict';
  var ratio = rate / 16000, used = 0, sum = 0;
  return function (samples) {
    var values = [];
    // Keep fractional sample boundaries across callbacks (including 44.1 kHz).
    for (var i = 0; i < samples.length; i++) {
      var remaining = 1;
      while (remaining > 1e-8) {
        var take = Math.min(remaining, ratio - used);
        sum += samples[i] * take; used += take; remaining -= take;
        if (used >= ratio - 1e-8) {
          var value = Math.max(-1, Math.min(1, sum / ratio));
          values.push(Math.round(value * (value < 0 ? 32768 : 32767)));
          sum = used = 0;
        }
      }
    }
    var bytes = new Uint8Array(values.length * 2), view = new DataView(bytes.buffer);
    values.forEach(function (value, i) { view.setInt16(i * 2, value, true); });
    return bytes;
  };
};

window.AgentVoice = function (options) {
  'use strict';
  var encoder = new TextEncoder(), state = 'idle', serial = 0, generation = 0;
  var socket = null, pending = new Map(), stream = null, context = null, processor = null, source = null;
  var capture = [], size = 0, recording = null, ticker = null, limit = 120, started = 0;
  function change(next, seconds) { state = next; options.onstate(next, seconds || 0); }
  function disconnect() {
    var old = socket; socket = null;
    pending.forEach(function (task) { clearTimeout(task.timer); task.reject(new Error('Voice prompt cancelled.')); });
    pending.clear();
    if (old) old.close();
  }
  function releaseMic() {
    clearInterval(ticker); ticker = null;
    if (processor) {
      processor.onaudioprocess = null;
      try { processor.disconnect(); } catch (e) {}
      processor = null;
    }
    if (source) { try { source.disconnect(); } catch (e) {} source = null; }
    if (stream) { stream.getTracks().forEach(function (track) { track.stop(); }); stream = null; }
    if (context) { context.close().catch(function () {}); context = null; }
  }
  function cancel() {
    generation++;
    releaseMic(); disconnect(); capture = []; size = 0; recording = null;
    change('idle');
  }
  function fail(error, run) {
    if (run !== generation) return;
    cancel();
    var message = error && error.message || 'Voice prompting failed. Try again.';
    if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
      message = 'Allow microphone access for Home Assistant in your browser or phone settings, then try again.';
    } else if (error && error.name === 'NotFoundError') message = 'No microphone was found on this device.';
    else if (error && error.name === 'NotReadableError') message = 'The microphone is busy or unavailable. Close other recording apps and try again.';
    options.onerror(message);
  }
  function connect(run) {
    return fetch(options.tokenUrl, { cache: 'no-store' }).then(function (r) { return r.json(); })
      .catch(function () { return { token: '' }; }).then(function (data) {
        if (run !== generation) throw new Error('Voice prompt cancelled.');
        return new Promise(function (resolve, reject) {
          var url = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + options.base + '/ws?arg=voice';
          var ws = new WebSocket(url, ['tty']), decoder = new TextDecoder(), buffer = '', ready = false;
          socket = ws; ws.binaryType = 'arraybuffer';
          var timer = setTimeout(function () { reject(new Error('The voice service did not answer. Reload the terminal page and try again.')); ws.close(); }, 15000);
          ws.onopen = function () {
            if (run !== generation || socket !== ws) { ws.close(); return; }
            ws.send(encoder.encode(JSON.stringify({ AuthToken: data.token || '', columns: 80, rows: 24 })));
          };
          ws.onmessage = function (event) {
            if (run !== generation || socket !== ws) return;
            var bytes = typeof event.data === 'string' ? encoder.encode(event.data) : new Uint8Array(event.data);
            if (bytes[0] !== 48) return;
            buffer += decoder.decode(bytes.subarray(1), { stream: true });
            var end;
            while ((end = buffer.indexOf('\n')) !== -1) {
              var line = buffer.slice(0, end), packet;
              buffer = buffer.slice(end + 1);
              try { packet = JSON.parse(line); } catch (e) { continue; }
              if (packet.type === 'ready') { ready = true; clearTimeout(timer); resolve(); }
              else if (pending.has(packet.request)) {
                var task = pending.get(packet.request); pending.delete(packet.request); clearTimeout(task.timer);
                if (packet.error) task.reject(new Error(packet.error)); else task.resolve(packet.result);
              }
            }
            if (buffer.length > 100000) ws.close();
          };
          ws.onclose = function () {
            clearTimeout(timer);
            var error = new Error('The voice connection was lost. Try recording again.');
            if (!ready) reject(error);
            if (socket === ws && run === generation) fail(error, run);
          };
          ws.onerror = function () {};
        });
      });
  }
  function request(method, fields) {
    return new Promise(function (resolve, reject) {
      if (!socket || socket.readyState !== WebSocket.OPEN) { reject(new Error('The voice connection was lost.')); return; }
      var id = ++serial;
      var timer = setTimeout(function () { pending.delete(id); reject(new Error('Speech-to-text timed out. Try a shorter recording.')); }, method === 'finish' ? 125000 : 15000);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      socket.send(encoder.encode('0' + JSON.stringify(Object.assign({ request: id, method: method }, fields)) + '\n'));
    });
  }
  function start() {
    if (state !== 'idle') return;
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      options.onerror('Microphone access needs HTTPS. Open Home Assistant through its secure address or use your keyboard’s dictation.'); return;
    }
    var Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) { options.onerror('This browser cannot record audio. Use your keyboard’s dictation or a supported browser.'); return; }
    var run = ++generation;
    change('starting'); capture = []; size = 0;
    // Request both microphone permission and AudioContext activation inside
    // the user's tap, before awaiting any network work (required by iOS).
    try { context = new Audio(); } catch (error) { fail(error, run); return; }
    var ctx = context;
    var audioReady = ctx.resume();
    var mic;
    try { mic = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false }); }
    catch (error) { fail(error, run); return; }
    mic = mic.then(function (value) {
      if (run !== generation) { value.getTracks().forEach(function (track) { track.stop(); }); throw new Error('Voice prompt cancelled.'); }
      stream = value;
      return value;
    });
    Promise.all([mic, audioReady, connect(run).then(function () { return request('begin'); })]).then(function (results) {
      if (run !== generation) return;
      recording = results[2].recording; limit = Math.min(120, results[2].maxSeconds || 120);
      var convert = window.AgentVoicePCM(ctx.sampleRate);
      // ScriptProcessor is supported in the phone webviews used by HA, as
      // well as desktop browsers, without a separately hosted worklet file.
      processor = ctx.createScriptProcessor(4096, 1, 1);
      source = ctx.createMediaStreamSource(stream);
      processor.onaudioprocess = function (event) {
        if (run !== generation || state !== 'recording') return;
        var bytes = convert(event.inputBuffer.getChannelData(0));
        var room = limit * 16000 * 2 - size;
        if (bytes.length > room) bytes = bytes.subarray(0, room);
        if (bytes.length) { capture.push(bytes); size += bytes.length; }
        if (size >= limit * 16000 * 2) stop();
      };
      stream.getTracks().forEach(function (track) { track.onended = function () { if (run === generation && state === 'recording') fail(new Error('Microphone access ended. Try again.'), run); }; });
      source.connect(processor); processor.connect(ctx.destination);
      started = Date.now(); change('recording');
      ticker = setInterval(function () {
        var seconds = Math.floor((Date.now() - started) / 1000);
        if (seconds >= limit) stop(); else change('recording', seconds);
      }, 1000);
    }).catch(function (error) { fail(error, run); });
  }
  function stop() {
    if (state !== 'recording') return;
    var run = generation;
    releaseMic(); change('transcribing');
    if (!size) { fail(new Error('No audio was recorded. Try again.'), run); return; }
    var bytes = new Uint8Array(size), at = 0;
    capture.forEach(function (part) { bytes.set(part, at); at += part.length; }); capture = [];
    var offset = 0;
    function next() {
      if (run !== generation) throw new Error('Voice prompt cancelled.');
      if (offset >= bytes.length) return request('finish', { recording: recording });
      var end = Math.min(offset + 65536, bytes.length), text = '';
      for (var i = offset; i < end; i += 16384) text += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 16384, end)));
      offset = end;
      return request('chunk', { recording: recording, data: btoa(text) }).then(next);
    }
    Promise.resolve().then(next).then(function (result) {
      if (run !== generation) return;
      if (!result || typeof result.text !== 'string' || !result.text.trim()) throw new Error('No speech was recognized. Try again.');
      cancel(); options.ontext(result.text);
    }).catch(function (error) { fail(error, run); });
  }
  return { start: start, stop: stop, cancel: cancel, state: function () { return state; } };
};
