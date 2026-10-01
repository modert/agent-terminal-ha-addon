/* Session picker and control channel. Each visible terminal owns its input;
 * this channel carries only structured metadata/lifecycle requests. */
window.AgentSessions = function (options) {
  'use strict';
  var el = function (id) { return document.getElementById(id); };
  var sheet = el('sessions-sheet'), list = el('sessions-list'), search = el('sessions-search');
  var form = el('sessions-form'), status = el('sessions-status');
  var records = [], socket = null, pending = new Map(), serial = 0, retry = null;
  var encoder = new TextEncoder(), decoder = new TextDecoder(), buffer = '';
  var mode = 'list', editing = null, beside = false, expanded = null, busy = false, generation = 0;
  var agents = options.config.agents, workspaces = options.config.workspaces;
  function label(items, id) { var item = items.find(function (i) { return i.id === id; }); return item ? item.name : id; }
  function message(text) { status.textContent = text || ''; }
  function fail(error) { message(error.message || String(error)); }
  function send(method, fields) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Session controls are disconnected. Reconnecting…'));
    return new Promise(function (resolve, reject) {
      var id = ++serial;
      var timer = setTimeout(function () { pending.delete(id); reject(new Error('No response. Reopen Sessions to check the result.')); }, 10000);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      socket.send(encoder.encode('0' + JSON.stringify(Object.assign({ request: id, method: method }, fields)) + '\n'));
    });
  }
  function receive(packet) {
    if (packet.type === 'sessions') {
      records = packet.sessions; agents = packet.agents; workspaces = packet.workspaces;
      options.config.agents = agents; options.config.workspaces = workspaces;
      options.changed(records);
      if (mode === 'list' && !sheet.hidden) { message(''); render(); }
    } else if (pending.has(packet.request)) {
      var task = pending.get(packet.request); pending.delete(packet.request); clearTimeout(task.timer);
      if (packet.error) task.reject(new Error(packet.error)); else task.resolve(packet.result);
    }
  }
  function connect(token) {
    if (socket && socket.readyState < 2) return;
    clearTimeout(retry); retry = null;
    var current = ++generation;
    decoder = new TextDecoder(); buffer = '';
    var url = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + options.base + '/ws?arg=sessions';
    var ws = new WebSocket(url, ['tty']); socket = ws; ws.binaryType = 'arraybuffer';
    ws.onopen = function () {
      if (socket !== ws) return;
      ws.send(encoder.encode(JSON.stringify({ AuthToken: token, columns: 80, rows: 24 })));
    };
    ws.onmessage = function (event) {
      if (socket !== ws) return;
      var bytes = typeof event.data === 'string' ? encoder.encode(event.data) : new Uint8Array(event.data);
      if (bytes[0] !== 48) return;
      buffer += decoder.decode(bytes.subarray(1), { stream: true });
      if (buffer.length > 1048576) { ws.close(); return; }
      var end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        var line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { receive(JSON.parse(line)); } catch (e) { /* ttyd may report a process error as text */ }
      }
    };
    ws.onclose = function () {
      if (socket !== ws) return;
      socket = null;
      pending.forEach(function (task) { clearTimeout(task.timer); task.reject(new Error('Connection lost. Reopen Sessions to check the result.')); });
      pending.clear();
      if (!sheet.hidden) message('Session controls disconnected. Reconnecting…');
      retry = setTimeout(function () {
        fetch(options.tokenUrl, { cache: 'no-store' }).then(function (r) { return r.json(); })
          .then(function (data) { if (current === generation) connect(data.token || ''); })
          .catch(function () { if (current === generation) connect(''); });
      }, 1500);
    };
    ws.onerror = function () {};
  }
  function close() {
    if (busy) return;
    sheet.hidden = true; el('sessions-open').setAttribute('aria-expanded', 'false');
    options.focus();
  }
  function choose(record) {
    if (beside) options.beside(record); else options.select(record);
    close();
  }
  function action(text, title, fn) {
    var button = document.createElement('button');
    button.type = 'button'; button.className = 'agent-button'; button.textContent = text;
    button.setAttribute('aria-label', title); button.addEventListener('click', fn);
    return button;
  }
  function render() {
    var focused = document.activeElement && document.activeElement.dataset.sessionAction;
    list.textContent = '';
    var query = search.value.trim().toLowerCase(), current = options.current().id;
    var filtered = records.filter(function (r) {
      return (r.name + ' ' + label(agents, r.agent) + ' ' + label(workspaces, r.workspace)).toLowerCase().includes(query);
    }).sort(function (a, b) {
      return Number(b.id === current) - Number(a.id === current) || Number(b.running) - Number(a.running) || a.name.localeCompare(b.name);
    });
    filtered.forEach(function (record) {
      var row = document.createElement('div'); row.className = 'session-row';
      var main = action('', 'Open ' + record.name, function () { choose(record); });
      main.className = 'session-choice'; main.dataset.sessionAction = record.id + ':open';
      if (record.id === current) main.setAttribute('aria-current', 'true');
      var name = document.createElement('strong'); name.textContent = record.name;
      var detail = document.createElement('span');
      detail.textContent = label(agents, record.agent) + ' · ' + label(workspaces, record.workspace) + ' · ' +
        (record.stopped ? 'Stopped' : record.running ? 'Running' : 'Ready');
      main.appendChild(name); main.appendChild(detail); row.appendChild(main);
      var more = action('•••', 'Actions for ' + record.name, function () { expanded = expanded === record.id ? null : record.id; render(); });
      more.dataset.sessionAction = record.id + ':actions'; more.setAttribute('aria-expanded', String(expanded === record.id));
      row.appendChild(more);
      if (expanded === record.id) {
        var actions = document.createElement('div'); actions.className = 'session-actions';
        if (record.stopped) actions.appendChild(action('Start', 'Start ' + record.name, function () {
          run('start', { session: record.id }, function (result) { choose(result); });
        }));
        if (options.canSplit() && !record.stopped && record.id !== current) actions.appendChild(action('Open beside', 'Open ' + record.name + ' beside this session', function () {
          options.beside(record); close();
        }));
        actions.appendChild(action('Rename', 'Rename ' + record.name, function () { edit('rename', record); }));
        if (!record.stopped) actions.appendChild(action('Stop', 'Stop ' + record.name, function () { edit('stop', record); }));
        row.appendChild(actions);
      }
      list.appendChild(row);
    });
    if (!filtered.length) {
      var empty = document.createElement('p'); empty.textContent = records.length ? 'No matching sessions.' : 'Loading sessions…'; list.appendChild(empty);
    }
    if (focused) Array.prototype.some.call(list.querySelectorAll('[data-session-action]'), function (button) {
      if (button.dataset.sessionAction !== focused) return false;
      button.focus(); return true;
    });
  }
  function selectOptions(select, items, value) {
    select.textContent = '';
    items.forEach(function (item) { var option = document.createElement('option'); option.value = item.id; option.textContent = item.name; select.appendChild(option); });
    select.value = value;
  }
  function edit(next, record) {
    mode = next; editing = record; form.hidden = false; el('sessions-browse').hidden = true;
    el('sessions-title').textContent = next === 'create' ? (beside ? 'New session beside' : 'New session') : next === 'rename' ? 'Rename session' : 'Stop session';
    el('sessions-name-row').hidden = next === 'stop';
    el('sessions-name').disabled = next === 'stop';
    el('sessions-name').value = record ? record.name : '';
    el('sessions-provider-row').hidden = el('sessions-workspace-row').hidden = next !== 'create';
    var current = options.current();
    selectOptions(el('sessions-provider'), agents, current.agent);
    selectOptions(el('sessions-workspace'), workspaces, current.workspace);
    el('sessions-explanation').textContent = next === 'stop'
      ? 'Stop “' + record.name + '” and end its running task? Starting it again launches a fresh process.'
      : next === 'create' ? 'A separate conversation in this workspace. Sessions share its files and provider login.' : '';
    el('sessions-save').textContent = next === 'stop' ? 'Stop session' : next === 'rename' ? 'Save name' : 'Create session';
    message(''); (next === 'stop' ? el('sessions-back') : el('sessions-name')).focus();
  }
  function browse() {
    mode = 'list'; form.hidden = true; el('sessions-browse').hidden = false;
    el('sessions-title').textContent = beside ? 'Open a session beside' : 'Sessions';
    message(''); render(); search.focus();
  }
  function open(openBeside) {
    beside = !!openBeside; sheet.hidden = false; search.value = ''; expanded = null;
    el('sessions-open').setAttribute('aria-expanded', 'true'); browse();
    if (socket && socket.readyState === WebSocket.OPEN) send('list').then(function (snapshot) { receive(Object.assign({ type: 'sessions' }, snapshot)); }, fail);
  }
  function run(method, fields, done) {
    if (busy) return;
    busy = true; form.setAttribute('aria-busy', 'true');
    el('sessions-save').disabled = true; message('Saving…');
    send(method, fields).then(function (result) {
      busy = false; message(''); done(result);
    }, function (error) { busy = false; fail(error); }).finally(function () {
      form.setAttribute('aria-busy', 'false'); el('sessions-save').disabled = false;
    });
  }
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (mode === 'create') run('create', { name: el('sessions-name').value, agent: el('sessions-provider').value, workspace: el('sessions-workspace').value }, choose);
    else if (mode === 'rename') run('rename', { session: editing.id, name: el('sessions-name').value }, browse);
    else if (mode === 'stop') run('stop', { session: editing.id }, browse);
  });
  search.addEventListener('input', render);
  el('sessions-new').addEventListener('click', function () { edit('create'); });
  el('sessions-back').addEventListener('click', function () { if (!busy) browse(); });
  el('sessions-done').addEventListener('click', close);
  el('sessions-open').addEventListener('click', function () { open(false); });
  sheet.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      var focusable = Array.prototype.filter.call(sheet.querySelectorAll('button, input, select'), function (n) { return !n.disabled && n.offsetParent !== null; });
      var index = focusable.indexOf(document.activeElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); focusable[focusable.length - 1].focus(); }
      else if (!event.shiftKey && index === focusable.length - 1) { event.preventDefault(); focusable[0].focus(); }
    }
    if (mode === 'list' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      var choices = Array.prototype.slice.call(list.querySelectorAll('.session-choice'));
      if (!choices.length) return;
      var at = choices.indexOf(document.activeElement);
      event.preventDefault(); choices[(at + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length].focus();
    }
  });
  window.addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === 'KeyK') {
      event.preventDefault(); event.stopImmediatePropagation(); open(false);
    }
  }, true);
  return { connect: connect, open: open, records: function () { return records; } };
};
