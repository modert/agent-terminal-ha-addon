/* Task workspace: metadata is durable; terminals remain the execution surface. */
window.AgentTasks = function (options) {
  'use strict';
  var el = function (id) { return document.getElementById(id); };
  var drafts = {}, notes = {};
  var panel = el('tasks-view'), records = [], selected = null, busy = false, timer = null, epoch = 0;
  var labels = { open: 'Open', in_progress: 'In progress', needs_you: 'Needs you', review: 'Ready for review', done: 'Done', archived: 'Archived' };
  function node(tag, text, parent, cls) { var n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; if (parent) parent.appendChild(n); return n; }
  function button(text, parent, fn) { var b = node('button', text, parent, 'agent-button'); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function message(text) { el('tasks-message').textContent = text || ''; }
  function setBusy(value) { busy = value; ['task-save', 'task-note-save', 'task-inspect', 'task-prepare', 'tasks-new', 'tasks-close', 'tasks-reload'].forEach(function (id) { el(id).disabled = value; }); }
  function fail(error) { message(error.message || String(error)); }
  function request(method, fields) { return options.request(method, fields); }
  function choices(target, values, empty) {
    target.textContent = ''; if (empty) { var blank = node('option', empty, target); blank.value = ''; }
    values.forEach(function (v) { var o = node('option', v.name, target); o.value = v.id; });
  }
  function renderList() {
    var list = el('tasks-list'); list.textContent = '';
    var query = el('tasks-search').value.toLowerCase(), filter = el('tasks-filter').value;
    var visible = records.filter(function (t) { return (filter === 'all' || filter === 'active' ? filter === 'all' || !['done', 'archived'].includes(t.status) : t.status === filter) && (t.title + ' ' + t.caseName + ' ' + t.summary).toLowerCase().includes(query); });
    visible.sort(function (a, b) { return Number(b.status === 'needs_you') - Number(a.status === 'needs_you') || b.updatedAt - a.updatedAt; });
    if (!visible.length) node('p', 'No tasks here yet. Create a task or organize an existing session.', list, 'tasks-muted');
    visible.forEach(function (t) {
      var b = button('', list, function () { if (!busy) load(t.id); }); b.className = 'task-card';
      b.setAttribute('aria-current', String(selected && selected.id === t.id));
      node('span', (t.caseName || 'Standalone task') + ' · ' + labels[t.status], b, 'tasks-muted');
      node('strong', t.title, b); if (t.summary) node('span', t.summary.slice(0, 140), b);
      node('small', t.sessionCount + ' linked session' + (t.sessionCount === 1 ? '' : 's'), b, 'tasks-muted');
    });
  }
  function refresh() { return request('tasks.list').then(function (value) { records = value; renderList(); }); }
  function renderConversation(value) {
    var history = el('task-history'), nearBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 80;
    // Leave scroll position and text selection intact when no messages changed.
    var signature = JSON.stringify(value.conversations);
    if (history.dataset.signature === signature) return;
    history.dataset.signature = signature; history.textContent = '';
    value.conversations.forEach(function (c) {
      node('h3', c.session.name + (c.session.agent ? ' · ' + c.session.agent : ''), history);
      node('p', c.notice, history, 'tasks-muted');
      c.messages.forEach(function (m) {
        var article = node('article', undefined, history, 'task-message task-' + m.role);
        node('strong', m.role === 'user' ? 'You' : 'Assistant', article);
        node('div', m.text, article, 'task-message-text');
      });
    });
    if (nearBottom) history.scrollTop = history.scrollHeight;
  }
  function renderDetail(value) {
    panel.classList.add('task-selected'); el('task-heading').textContent = value.title; el('task-context').textContent = (value.caseName || 'Standalone task') + ' · ' + labels[value.status];
    selected = value; el('task-draft').value = drafts[value.id] || ''; el('task-note').value = notes[value.id] || ''; el('tasks-empty').hidden = true; el('task-detail').hidden = false; el('task-create').hidden = true;
    el('task-title').value = value.title; el('task-case').value = value.caseName; el('task-summary').value = value.summary; el('task-state').value = value.status;
    var noteList = el('task-notes'); noteList.textContent = '';
    value.notes.forEach(function (n) { var item = node('article', undefined, noteList, 'task-message'); node('small', new Date(n.at).toLocaleString(), item, 'tasks-muted'); node('div', n.text, item, 'task-message-text'); });
    var sessions = value.conversations.map(function (c) { return c.session; }).filter(function (s) { return s.agent; });
    var previous = el('task-session').value;
    choices(el('task-session'), sessions); if (sessions.some(function (s) { return s.id === previous; })) el('task-session').value = previous;
    choices(el('task-link'), options.records().filter(function (s) { return s.workspace === value.workspace && !value.sessions.includes(s.id); }).map(function (s) { return { id: s.id, name: s.name + ' · ' + s.agent }; }), 'Link another session…');
    renderConversation(value); renderList();
  }
  function load(id) {
    var current = ++epoch;
    message('Loading task…');
    return request('tasks.get', { task: id }).then(function (value) { if (current !== epoch || panel.hidden) return; renderDetail(value); message(''); }).catch(fail);
  }
  function mutate(method, fields) {
    if (busy || !selected) return;
    setBusy(true); message('Saving…');
    var id = selected.id;
    return request(method, Object.assign({ task: id, revision: selected.revision }, fields)).then(function () { return load(id); }).then(refresh).catch(fail).finally(function () { setBusy(false); });
  }
  function open() {
    options.closeSessions(); panel.hidden = false; options.cover(true); message(''); refresh().catch(fail); el('tasks-close').focus();
    clearInterval(timer);
    timer = setInterval(function () {
      if (panel.hidden || busy || !selected) return;
      var id = selected.id, current = epoch;
      request('tasks.get', { task: id }).then(function (value) {
        if (panel.hidden || current !== epoch || !selected || selected.id !== id) return;
        renderConversation(value);
        if (value.revision !== selected.revision) message('This task changed in another window. Reload task before editing.');
      }).catch(fail);
    }, 5000);
  }
  function close() { if (busy) return; panel.hidden = true; ++epoch; clearInterval(timer); options.cover(false); options.focus(); }
  el('task-draft').addEventListener('input', function () { if (selected) drafts[selected.id] = this.value; });
  el('task-note').addEventListener('input', function () { if (selected) notes[selected.id] = this.value; });
  el('tasks-inbox').addEventListener('click', function () { panel.classList.remove('task-selected'); });
  el('tasks-open').addEventListener('click', open);
  el('tasks-close').addEventListener('click', close);
  el('tasks-search').addEventListener('input', renderList); el('tasks-filter').addEventListener('change', renderList);
  el('tasks-reload').addEventListener('click', function () { if (!busy) { refresh().catch(fail); if (selected) load(selected.id); } });
  el('tasks-new').addEventListener('click', function () {
    if (busy) return; panel.classList.add('task-selected'); ++epoch; selected = null; el('task-detail').hidden = true; el('tasks-empty').hidden = true; el('task-create').hidden = false;
    choices(el('task-new-session'), options.records().map(function (s) { return { id: s.id, name: s.name + ' · ' + s.agent + ' · ' + s.workspace }; }), 'Create a new session');
    choices(el('task-new-provider'), options.config.agents); choices(el('task-new-workspace'), options.config.workspaces);
    el('task-new-title').focus(); message('');
  });
  el('task-create').addEventListener('submit', function (event) {
    event.preventDefault(); if (busy) return; setBusy(true); message('Creating task…');
    request('tasks.create', { title: el('task-new-title').value, caseName: el('task-new-case').value, session: el('task-new-session').value, agent: el('task-new-provider').value, workspace: el('task-new-workspace').value }).then(function (value) {
      el('task-new-title').value = ''; el('task-new-case').value = ''; return load(value.id);
    }).then(refresh).catch(fail).finally(function () { setBusy(false); });
  });
  el('task-save').addEventListener('click', function () { mutate('tasks.update', { title: el('task-title').value, caseName: el('task-case').value, summary: el('task-summary').value, status: el('task-state').value }); });
  el('task-note-save').addEventListener('click', function () {
    var body = el('task-note').value; if (!body.trim()) return;
    var promise = mutate('tasks.note', { text: body }); if (promise) promise.then(function () { if (selected && selected.notes.some(function (n) { return n.text === body.trim(); })) { el('task-note').value = ''; notes[selected.id] = ''; } });
  });
  el('task-link').addEventListener('change', function () { if (this.value) mutate('tasks.link', { session: this.value }); });
  function inspect(draft) {
    if (busy || !selected) return;
    var id = el('task-session').value;
    var record = options.records().find(function (s) { return s.id === id; }) || selected.conversations.map(function (c) { return c.session; }).find(function (s) { return s.id === id && s.agent; });
    if (!record) { message('Link an available session first.'); return; }
    try {
      if (options.inspect(record, draft) === false) return;
      close();
    } catch (error) { fail(error); }
  }
  el('task-inspect').addEventListener('click', function () { inspect(); });
  el('task-prepare').addEventListener('click', function () { var draft = el('task-draft').value; if (draft.trim()) inspect(draft); });
  panel.addEventListener('keydown', function (event) { if (event.key === 'Tab') {
      var items = Array.from(panel.querySelectorAll('button, input, select, textarea, [tabindex]')).filter(function (n) { return n.getClientRects().length && !n.disabled; });
      var first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } });
  return { open: open, close: close };
};
