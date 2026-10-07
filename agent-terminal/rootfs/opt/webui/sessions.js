/* Session picker and control channel. Each visible terminal owns its input;
 * this channel carries only structured metadata/lifecycle requests. */
window.AgentSessions = function (options) {
  'use strict';
  var el = function (id) { return document.getElementById(id); };
  var sheet = el('sessions-sheet'), list = el('sessions-list'), search = el('sessions-search');
  var form = el('sessions-form'), status = el('sessions-status');
  var records = [], socket = null, pending = new Map(), serial = 0, retry = null;
  var encoder = new TextEncoder(), decoder = new TextDecoder(), buffer = '';
  var mode = 'list', editing = null, expanded = null, busy = false, generation = 0, showUnused = false;
  var agents = options.config.agents, workspaces = options.config.workspaces;
  // Small local vector marks; labels carry the provider name as well as color.
  var icons = {
    claude: '<path d="M12 2v20M2 12h20M5 5l14 14M5 19L19 5M8 3l8 18M3 8l18 8M3 16l18-8M8 21l8-18"/>',
    codex: '<rect x="7" y="2.5" width="10" height="19" rx="5"/><rect x="7" y="2.5" width="10" height="19" rx="5" transform="rotate(60 12 12)"/><rect x="7" y="2.5" width="10" height="19" rx="5" transform="rotate(120 12 12)"/>',
    shell: '<path d="m5 6 6 6-6 6m8 0h6"/>',
    ollama: '<path d="M7 10V4a2 2 0 0 1 4 0v5h2V4a2 2 0 0 1 4 0v6a7 7 0 1 1-10 0Z"/><path d="M9 15h.01M15 15h.01M10 19h4"/>',
    custom: '<path d="M8 4H6v6l-2 2 2 2v6h2m8-16h2v6l2 2-2 2v6h-2"/>'
  };
  function mark(agent) {
    var icon = document.createElement('span');
    icon.className = 'provider-mark provider-' + (icons[agent] ? agent : 'custom');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + (icons[agent] || icons.custom) + '</svg>';
    return icon;
  }
  function displayName(record) { return record.name === 'Main' && record.id.indexOf('agent-') === 0 ? 'General session' : record.name; }
  function picking() { return !!(options.choosingPane && options.choosingPane()); }
  function position(id) { return options.position ? options.position(id) : id === options.current().id ? 'Current' : ''; }
  function label(items, id) { var item = items.find(function (i) { return i.id === id; }); return item ? item.name : id; }
  function message(text) { status.textContent = text || ''; }
  function fail(error) { message(error.message || String(error)); }
  function send(method, fields) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Session controls are disconnected. Reconnecting…'));
    return new Promise(function (resolve, reject) {
      var id = ++serial;
      var timer = setTimeout(function () { pending.delete(id); reject(new Error('No response. Reopen Sessions to check the result.')); }, method === 'health.test' ? 120000 : method === 'health.discover' ? 20000 : 10000);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      socket.send(encoder.encode('0' + JSON.stringify(Object.assign({ request: id, method: method }, fields)) + '\n'));
    });
  }
  function receive(packet) {
    if (packet.type === 'sessions') {
      records = packet.sessions; agents = packet.agents; workspaces = packet.workspaces;
      options.config.agents = agents; options.config.workspaces = workspaces;
      options.changed(records);
      if (options.healthChanged && packet.health) options.healthChanged(packet.health);
      if (mode === 'list' && !sheet.hidden) { message(''); refresh(); }
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
  function close(restoreFocus) {
    if (busy) return;
    if (picking()) { options.cancelPane(); return; }
    sheet.hidden = true; el('sessions-open').setAttribute('aria-expanded', 'false');
    if (restoreFocus !== false) options.focus();
  }
  function choose(record) {
    if (busy) return;
    var result = options.select(record);
    if (result !== false) close(result !== 'other');
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
    var other = options.other && options.other(), unused = 0;
    var filtered = records.filter(function (r) {
      if (picking() && (r.id === current || other && r.id === other.id)) return false;
      var unopened = r.id.indexOf('agent-') === 0 && r.name === 'Main' && !r.description && !r.running && !r.stopped && !position(r.id);
      if (unopened) { unused++; if (!showUnused && !query) return false; }
      return (displayName(r) + ' ' + (r.description || '') + ' ' + label(agents, r.agent) + ' ' + label(workspaces, r.workspace)).toLowerCase().includes(query);
    }).sort(function (a, b) {
      return Number(b.id === current) - Number(a.id === current) || Number(b.running) - Number(a.running) || a.name.localeCompare(b.name);
    });
    el('sessions-unused').hidden = !unused || !!query;
    el('sessions-unused').textContent = showUnused ? 'Hide unused sessions' : 'Show unused sessions (' + unused + ')';
    var groups = workspaces.slice().sort(function (a, b) {
      return Number(b.id === options.current().workspace) - Number(a.id === options.current().workspace) || a.name.localeCompare(b.name);
    });
    groups.forEach(function (workspace) {
      var members = filtered.filter(function (r) { return r.workspace === workspace.id; });
      if (!members.length) return;
      var group = document.createElement('section'); group.className = 'session-workspace'; group.dataset.workspace = workspace.id;
      var heading = document.createElement('h3'); heading.className = 'workspace-heading'; heading.title = workspace.directory;
      var folder = document.createElement('span'); folder.className = 'workspace-folder'; folder.setAttribute('aria-hidden', 'true');
      folder.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z"/></svg>';
      var title = document.createElement('span'); title.textContent = workspace.name;
      var count = document.createElement('span'); count.className = 'workspace-count'; count.textContent = String(members.length);
      heading.appendChild(folder); heading.appendChild(title); heading.appendChild(count); group.appendChild(heading);
      members.forEach(function (record) {
        var row = document.createElement('div'); row.className = 'session-row'; row.dataset.session = record.id;
        var place = position(record.id);
        if (place) row.className += ' session-visible';
        var main = action('', (record.stopped ? 'Start ' : picking() ? 'Open in right pane: ' : 'Switch to ') + displayName(record), function () {
          if (record.stopped) run('start', { session: record.id }, choose); else choose(record);
        });
        main.className = 'session-choice'; main.dataset.sessionAction = record.id + ':open';
        if (record.id === current) main.setAttribute('aria-current', 'true');
        main.appendChild(mark(record.agent));
        var copy = document.createElement('span'); copy.className = 'session-copy';
        var name = document.createElement('strong'); name.textContent = displayName(record); copy.appendChild(name);
        if (record.description) {
          var purpose = document.createElement('span'); purpose.className = 'session-purpose'; purpose.textContent = record.description; copy.appendChild(purpose);
        }
        var detail = document.createElement('span'); detail.className = 'session-meta';
        var provider = document.createElement('span'); provider.textContent = label(agents, record.agent); detail.appendChild(provider);
        var state = document.createElement('span'); state.className = 'session-state' + (record.running && !record.stopped ? ' is-running' : '');
        state.textContent = record.stopped ? 'Stopped' : record.running ? 'Running' : record.conversationId ? 'Ready to resume' : 'Ready to start'; detail.appendChild(state);
        copy.appendChild(detail); main.appendChild(copy);
        if (place || record.stopped || picking()) {
          var badge = document.createElement('span'); badge.className = 'session-place';
          badge.textContent = record.stopped ? 'Start' : place || 'Open →'; main.appendChild(badge);
        }
        row.appendChild(main);
        var more = action('•••', 'Actions for ' + displayName(record), function () { expanded = expanded === record.id ? null : record.id; render(); });
        more.dataset.sessionAction = record.id + ':actions'; more.setAttribute('aria-expanded', String(expanded === record.id));
        row.appendChild(more);
        if (expanded === record.id) {
          var actions = document.createElement('div'); actions.className = 'session-actions';
          if (record.stopped) actions.appendChild(action('Start', 'Start ' + record.name, function () {
            run('start', { session: record.id }, function (result) { choose(result); });
          }));
          if (options.canSplit() && !record.stopped && record.id !== current) actions.appendChild(action('Open beside', 'Open ' + record.name + ' beside this session', function () {
            if (options.beside(record) !== false) close(false);
          }));
          actions.appendChild(action('Edit details', 'Edit details for ' + displayName(record), function () { edit('rename', record); }));
          if (!record.stopped) actions.appendChild(action('Stop', 'Stop ' + record.name, function () { edit('stop', record); }));
          if (/^session-[a-f0-9]{32}$/.test(record.id)) {
            var remove = action('Delete', 'Delete ' + record.name, function () { edit('delete', record); });
            remove.classList.add('session-danger'); actions.appendChild(remove);
          }
          row.appendChild(actions);
        }
        group.appendChild(row);
      });
      list.appendChild(group);
    });
    if (!filtered.length) {
      var empty = document.createElement('p'); empty.className = 'sessions-empty';
      empty.textContent = !records.length ? 'Loading sessions…' : query ? 'No matching tasks. Try another name or purpose.' :
        picking() ? 'Create a session for this pane, or show unused sessions below.' : 'Create a named session to give your next task its own space.';
      list.appendChild(empty);
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
    if (busy) return;
    mode = next; editing = record; form.hidden = false; el('sessions-browse').hidden = true;
    var destructive = next === 'stop' || next === 'delete';
    el('sessions-title').textContent = next === 'create' ? (picking() ? 'New session in right pane' : 'New session') : next === 'rename' ? 'Edit session details' : next === 'delete' ? 'Delete session' : 'Stop session';
    el('sessions-subtitle').textContent = next === 'delete' ? 'Remove this temporary session.' : next === 'stop' ? 'This ends the running task.' : 'Give this conversation a clear job.';
    el('sessions-context').hidden = true;
    el('sessions-name-row').hidden = destructive;
    el('sessions-purpose-row').hidden = destructive;
    el('sessions-name').disabled = destructive;
    el('sessions-name').value = record ? record.name : '';
    el('sessions-purpose').value = record && record.description || '';
    el('sessions-provider-row').hidden = el('sessions-workspace-row').hidden = next !== 'create';
    var current = options.current();
    selectOptions(el('sessions-provider'), agents, current.agent);
    selectOptions(el('sessions-workspace'), workspaces, current.workspace);
    el('sessions-explanation').textContent = next === 'delete'
      ? 'Delete “' + record.name + '” from ' + label(workspaces, record.workspace) + ' · ' + label(agents, record.agent) + '? This ends its running task and removes it from Sessions in every browser. Terminal scrollback is lost. Workspace files and provider-saved conversations are kept. This cannot be undone.'
      : next === 'stop'
      ? 'Stop “' + record.name + '” and end its running task? ' +
        (record.agent === 'claude' || record.agent === 'codex' || record.agent === 'ollama' ? 'Starting it again resumes its saved conversation.' : 'Starting it again launches a fresh process.')
      : next === 'create' ? 'A separate conversation in this workspace. Sessions share its files and provider login.' : '';
    el('sessions-save').textContent = next === 'delete' ? 'Delete session' : next === 'stop' ? 'Stop session' : next === 'rename' ? 'Save details' : picking() ? 'Create in right pane' : 'Create session';
    el('sessions-save').classList.toggle('session-danger', next === 'delete');
    message(''); (destructive ? el('sessions-back') : el('sessions-name')).focus();
  }
  function browse() {
    mode = 'list'; form.hidden = true; el('sessions-browse').hidden = false;
    message(''); refresh(); search.focus();
  }
  function refresh() {
    if (sheet.hidden || mode !== 'list') return;
    var placing = picking();
    el('sessions-title').textContent = placing ? 'Add a second session' : 'Sessions';
    el('sessions-subtitle').textContent = placing ? 'Choose a task to open in the right pane.' : 'Pick a task to continue.';
    el('sessions-done').textContent = picking() ? 'Cancel' : 'Done';
    el('health-open').hidden = placing;
    el('sessions-context').hidden = !placing;
    if (placing) {
      var other = options.other && options.other(), left = records.find(function (r) { return r.id === (other ? other.id : options.current().id); });
      el('sessions-context').textContent = 'Left pane · ' + (left ? displayName(left) + ' · ' + label(agents, left.agent) : 'Your current session');
    }
    render();
  }
  function open() {
    if (busy) return;
    sheet.hidden = false; search.value = ''; expanded = null; showUnused = false;
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
    if (mode === 'create') run('create', { name: el('sessions-name').value, description: el('sessions-purpose').value, agent: el('sessions-provider').value, workspace: el('sessions-workspace').value }, choose);
    else if (mode === 'rename') run('rename', { session: editing.id, name: el('sessions-name').value, description: el('sessions-purpose').value }, browse);
    else if (mode === 'stop') run('stop', { session: editing.id }, browse);
    else if (mode === 'delete') run('delete', { session: editing.id }, function (result) {
      records = records.filter(function (record) { return record.id !== result.id; });
      expanded = null; options.changed(records); browse();
    });
  });
  search.addEventListener('input', render);
  el('sessions-unused').addEventListener('click', function () { showUnused = !showUnused; render(); });
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
      var next = at < 0 ? (event.key === 'ArrowDown' ? 0 : choices.length - 1) :
        (at + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length;
      event.preventDefault(); choices[next].focus();
    }
  });
  window.addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === 'KeyK') {
      event.preventDefault(); event.stopImmediatePropagation(); open(false);
    }
  }, true);
  return { connect: connect, open: open, close: close, refresh: refresh, request: send, records: function () { return records; } };
};
