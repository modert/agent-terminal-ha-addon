/* Upload channel. A file the page attaches travels through ttyd's
 * authenticated connection in base64 chunks, each acknowledged before the
 * next, and the add-on answers with the path it saved the file at. */
window.AgentUploads = function (options) {
  'use strict';
  var CHUNK = 65536;
  var encoder = new TextEncoder();
  var socket = null, opening = null, pending = new Map(), serial = 0, limit = 0;

  function lost(error) {
    pending.forEach(function (task) { clearTimeout(task.timer); task.reject(error); });
    pending.clear();
  }
  // The add-on starts a fresh receiver for each connection and says when it
  // is ready: anything sent before that would reach a terminal still in
  // line mode, which echoes it back and cuts long lines.
  function connect() {
    if (opening) return opening;
    opening = fetch(options.tokenUrl, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .catch(function () { return { token: '' }; })
      .then(function (data) {
        return new Promise(function (resolve, reject) {
          var url = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + options.base + '/ws?arg=uploads';
          var ws = new WebSocket(url, ['tty']), decoder = new TextDecoder(), buffer = '';
          var timer = setTimeout(function () { if (socket === ws) ws.close(); }, 15000);
          socket = ws; ws.binaryType = 'arraybuffer';
          ws.onopen = function () {
            ws.send(encoder.encode(JSON.stringify({ AuthToken: data.token || '', columns: 80, rows: 24 })));
          };
          ws.onmessage = function (event) {
            if (socket !== ws) return;
            var bytes = typeof event.data === 'string' ? encoder.encode(event.data) : new Uint8Array(event.data);
            if (bytes[0] !== 48) return;
            buffer += decoder.decode(bytes.subarray(1), { stream: true });
            var end;
            while ((end = buffer.indexOf('\n')) !== -1) {
              var line = buffer.slice(0, end), packet = null;
              buffer = buffer.slice(end + 1);
              try { packet = JSON.parse(line); } catch (e) { continue; }   // ttyd may report a process error as text
              if (packet.type === 'ready') { clearTimeout(timer); limit = packet.maxBytes || 0; resolve(); }
              else if (pending.has(packet.request)) {
                var task = pending.get(packet.request); pending.delete(packet.request); clearTimeout(task.timer);
                if (packet.error) task.reject(new Error(packet.error)); else task.resolve(packet.result);
              }
            }
            if (buffer.length > 65536) ws.close();
          };
          ws.onclose = function () {
            var error = new Error('the connection to the add-on was lost');
            clearTimeout(timer);
            reject(error);                        // no effect once ready
            if (socket !== ws) return;
            socket = null; opening = null;
            lost(error);
          };
          ws.onerror = function () {};
        });
      });
    var attempt = opening;
    attempt.catch(function () { if (opening === attempt) opening = null; });
    return attempt;
  }
  function request(method, fields) {
    return new Promise(function (resolve, reject) {
      if (!socket || socket.readyState !== WebSocket.OPEN) { reject(new Error('the connection to the add-on was lost')); return; }
      var id = ++serial, ws = socket;
      var timer = setTimeout(function () {
        pending.delete(id); reject(new Error('the add-on stopped answering'));
        if (socket === ws) close();
      }, 30000);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      ws.send(encoder.encode('0' + JSON.stringify(Object.assign({ request: id, method: method }, fields)) + '\n'));
    });
  }
  function base64(buffer) {
    var bytes = new Uint8Array(buffer), text = '';
    for (var i = 0; i < bytes.length; i += 32768) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return btoa(text);
  }
  // Resolves with { path, name, size }. progress(fraction) follows each chunk.
  function send(file, progress) {
    var id = null;
    return connect().then(function () {
      if (limit && file.size > limit) throw new Error('files can be at most ' + Math.round(limit / 1048576) + ' MB');
      return request('begin', { name: file.name || '', size: file.size });
    }).then(function (result) {
      var offset = 0;
      id = result.upload;
      function next() {
        if (progress) progress(file.size ? offset / file.size : 1);
        if (offset >= file.size) return request('finish', { upload: id });
        var end = Math.min(offset + CHUNK, file.size);
        return file.slice(offset, end).arrayBuffer().then(function (buffer) {
          return request('chunk', { upload: id, data: base64(buffer) });
        }).then(function () { offset = end; return next(); });
      }
      return next();
    }).catch(function (error) {
      if (id !== null && socket) request('cancel', { upload: id }).catch(function () {});
      throw error;
    });
  }
  // The receiver only lives while something is being sent.
  function close() {
    var ws = socket;
    socket = null; opening = null;
    lost(new Error('the upload was cancelled'));
    if (ws) ws.close();
  }
  return { send: send, close: close };
};
