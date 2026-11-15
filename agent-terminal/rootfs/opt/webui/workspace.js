/* One workspace for conversations, work tracking, approvals and backend inspection. */
window.AgentWorkspace = function (options) {
  'use strict';
  var el = function (id) { return document.getElementById(id); };
  var panel = el('tasks-view'), tasks = [], selected = null, ref = null, history = null;
  var attachments = {}, uploading = false, voiceKey = null;
  var uploads = window.AgentUploads ? new window.AgentUploads({ base: options.base, tokenUrl: options.tokenUrl }) : null;
  var voice = window.AgentVoice ? new window.AgentVoice({ base: options.base, tokenUrl: options.tokenUrl,
    onstate: function (state) { el('work-voice').textContent = state === 'recording' ? 'Finish' : state === 'idle' ? 'Dictate' : 'Cancel'; el('work-send').disabled = state !== 'idle' || busy || uploading; },
    ontext: function (text) { if (voiceKey === key()) { el('work-compose').value += (el('work-compose').value ? ' ' : '') + text; rememberDraft(); } },
    onerror: function (error) { message(error); }
  }) : null;
  var epoch = 0, timer = null, busy = false, polling = false, listing = false, older = [], drafts = {}, sent = {};
  try { drafts = JSON.parse(localStorage.getItem('agent-workspace-drafts') || '{}'); } catch (_) {}
  function persistDrafts() { try { localStorage.setItem('agent-workspace-drafts', JSON.stringify(drafts)); } catch (_) {} }
  var states = { open: 'Open', in_progress: 'In progress', needs_you: 'Needs you', review: 'Review', done: 'Done', archived: 'Archived' };
  function node(tag, text, parent, cls) { var n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; if (parent) parent.appendChild(n); return n; }
  function button(text, parent, fn, cls) { var b = node('button', text, parent, cls || 'agent-button'); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function message(text) { el('work-notice').textContent = text || ''; }
  function fail(error) { message(error.message || String(error)); }
  function request(method, fields) { return options.request(method, fields); }
  function fields(extra) { return Object.assign({ task: selected.id, provider: ref && ref.provider, thread: ref && ref.id }, extra); }
  function key() { return selected && selected.id + ':' + (ref ? ref.provider + ':' + ref.id : 'terminal'); }
  function choices(target, values, first) { target.textContent = ''; if (first) { var p = node('option', first, target); p.value = ''; } values.forEach(function (v) { var o = node('option', v.name, target); o.value = v.id; }); }
  function project(task) { return task.project || (options.config.workspaces.find(function (w) { return w.id === task.workspace; }) || {}).directory || task.workspace; }
  function projectName(task) { var path = project(task); return path.split('/').filter(Boolean).pop() || path; }
  function runtime(task) { return task.runtime || null; }
  function runtimeLabel(status) {
    if (!status) return '';
    if (status.activeFlags && status.activeFlags.length || status.type === 'needs_you' || status.type === 'requires_action') return 'Needs you';
    if (['active', 'running'].includes(status.type)) return 'Working';
    if (['error', 'systemError'].includes(status.type)) return 'Error';
    return 'Ready';
  }
  function renderList() {
    var list = el('work-list'), query = el('work-search').value.toLowerCase(), filter = el('work-filter').value, scope = el('work-project').value;
    list.textContent = '';
    var visible = tasks.filter(function (t) {
      var state = runtimeLabel(runtime(t));
      return (!scope || project(t) === scope) && (t.title + ' ' + t.caseName + ' ' + t.summary + ' ' + project(t)).toLowerCase().includes(query) &&
        (filter === 'all' || filter === 'active' && !['done', 'archived'].includes(t.status) || filter === 'needs_you' && (state === 'Needs you' || t.status === filter) || filter === 'working' && state === 'Working' || t.status === filter);
    });
    visible.sort(function (a, b) { return Number(runtimeLabel(runtime(b)) === 'Needs you') - Number(runtimeLabel(runtime(a)) === 'Needs you') || (a.caseName || projectName(a)).localeCompare(b.caseName || projectName(b)) || b.updatedAt - a.updatedAt; });
    el('work-count').textContent = visible.length + ' tasks';
    if (!visible.length) node('p', query || scope || filter !== 'active' ? 'No work matches these filters.' : 'Your saved conversations appear here. Start a task to begin new work.', list, 'work-muted');
    var group = '';
    visible.forEach(function (task) {
      var label = task.caseName || projectName(task);
      if (label !== group) { node('h3', label, list, 'work-group'); group = label; }
      var b = button('', list, function () { if (!busy) openTask(task.id); }, 'work-card'); b.dataset.task = task.id;
      b.setAttribute('aria-current', String(selected && selected.id === task.id));
      node('strong', task.title, b);
      var providers = (task.threads || []).map(function (r) { return r.provider; }).filter(function (v, i, all) { return all.indexOf(v) === i; });
      node('small', (providers.join(' · ') || 'Terminal') + ' · ' + (runtimeLabel(runtime(task)) || states[task.status]), b, 'work-muted');
    });
  }
  async function refresh(force) {
    if (listing) return; listing = true;
    try {
      var result = await request('workspace.list', { force: !!force }); tasks = result.tasks;
      var previous = el('work-project').value, projects = Array.from(new Set(tasks.map(project))).sort();
      choices(el('work-project'), projects.map(function (p) { return { id: p, name: p }; }), 'All projects'); el('work-project').value = previous;
      renderList(); el('work-provider-errors').textContent = result.errors.map(function (e) { return e.provider + ': ' + e.message; }).join(' · ');
    } catch (error) { fail(error); } finally { listing = false; }
  }
  function appendText(text, parent) {
    // Render code fences without interpreting provider-generated HTML.
    String(text || '').split(/(```[\s\S]*?```)/g).forEach(function (part) {
      if (part.startsWith('```')) { var end = part.indexOf('\n'); node('pre', part.slice(end < 0 ? 3 : end + 1, -3), parent, 'work-code'); }
      else node('div', part, parent, 'work-prose');
    });
  }
  function renderItems() {
    var area = el('work-messages'), nearBottom = area.scrollHeight - area.clientHeight - area.scrollTop < 100;
    var items = older.concat(history && history.items || []).filter(function (v, i, all) { return all.findIndex(function (a) { return a.id === v.id; }) === i; });
    var signature = JSON.stringify(items);
    if (area.dataset.signature === signature) return;
    area.dataset.signature = signature; var scroll = area.scrollTop; area.textContent = '';
    if (!items.length) node('p', 'Start the conversation below. Messages and results will stay with this task.', area, 'work-empty');
    var results = el('work-results'); results.textContent = '';
    items.forEach(function (item) {
      if (item.role === 'activity' || item.role === 'result') {
        var detail = node('details', undefined, area, 'work-activity'); node('summary', (item.title || item.type) + (item.status ? ' · ' + item.status : ''), detail); appendText(item.text, detail);
        (item.files || []).forEach(function (f) { button(f.path, detail, function () { preview(f.path); }); if (f.diff) node('pre', f.diff, detail, 'work-code'); button(f.path, results, function () { preview(f.path); }); });
      } else {
        var article = node('article', undefined, area, 'work-message work-' + item.role); node('strong', item.role === 'user' ? 'You' : ref && ref.provider || 'Assistant', article, 'work-author'); appendText(item.text, article);
      }
    });
    if (!results.children.length) node('p', 'Files reported by the agent appear here. Open a file to preview or download it.', results, 'work-muted');
    if (nearBottom && !older.length) area.scrollTop = area.scrollHeight; else area.scrollTop = scroll;
  }
  function renderApprovals() {
    var area = el('work-approvals'), approvals = history && history.approvals || [];
    var signature = JSON.stringify(approvals); if (area.dataset.signature === signature) return; area.dataset.signature = signature; area.textContent = '';
    approvals.forEach(function (a) {
      var card = node('section', undefined, area, 'work-approval'); node('h3', a.questions && a.questions.length ? 'Your answer is needed' : 'Approval needed', card);
      if (a.reason) node('p', a.reason, card); if (a.command || a.detail) node('pre', a.command || a.detail, card, 'work-code');
      if (a.permissions) node('pre', JSON.stringify(a.permissions, null, 2), card, 'work-code');
      if (a.grantRoot) node('p', 'Requested access: ' + a.grantRoot, card);
      if (a.title) node('p', a.title, card);
      var answers = {};
      (a.questions || []).forEach(function (q) {
        var id = q.id || q.question, label = node('label', q.question || q.header, card), input;
        if (q.options && q.options.length) {
          input = node('select', undefined, label); choices(input, q.options.map(function (o) { return { id: o.label, name: o.label + (o.description ? ' — ' + o.description : '') }; }), 'Choose an answer');
          var custom = node('input', undefined, label); custom.placeholder = 'Or write your answer'; custom.addEventListener('input', function () { answers[id] = custom.value; });
          input.addEventListener('change', function () { answers[id] = input.value; });
        } else { input = node('textarea', undefined, label); input.addEventListener('input', function () { answers[id] = input.value; }); }
      });
      async function respond(answer) { try { await request('workspace.respond', fields({ requestId: a.id, answer: answer })); message(''); await poll(); } catch (error) { fail(error); } }
      if (a.questions && a.questions.length) button('Send answer', card, function () { respond({ answers: answers }); }, 'agent-button work-primary');
      else {
        if (a.method !== 'mcpServer/elicitation/request') button('Allow once', card, function () { respond({ decision: 'accept' }); }, 'agent-button work-primary');
        else node('p', 'Complete this external authorization using Inspect backend.', card);
        button('Decline', card, function () { respond({ decision: 'decline' }); });
      }
    });
  }
  async function poll(cursor) {
    if (!selected || !ref || polling) return; polling = true; var current = epoch, wanted = key();
    try {
      var result = await request('workspace.history', fields({ cursor: cursor || null }));
      if (current !== epoch || wanted !== key()) return;
      if (cursor) { older = result.items.concat(older); history.cursor = result.cursor; }
      else { var oldCursor = history && history.cursor; history = result; if (older.length) history.cursor = oldCursor; }
      el('work-older').hidden = !history.cursor;
      el('work-runtime').textContent = runtimeLabel(history.status) || 'Ready';
      if (history.error || history.turn && history.turn.error) message(history.error || history.turn.error);
      renderItems(); renderApprovals();
    } catch (error) { if (current === epoch) fail(error); } finally { polling = false; }
  }
  function setBusy(value) { busy = value; ['work-send', 'work-create-submit', 'work-new', 'work-save', 'work-note-save'].forEach(function (id) { el(id).disabled = value; }); }
  function rememberDraft() { if (key()) { drafts[key()] = el('work-compose').value; persistDrafts(); } }
  async function openTask(id, internal) {
    if (busy && !internal) return; if (voice) voice.cancel(); rememberDraft(); var current = ++epoch; message('Loading…');
    try {
      var task = await request('workspace.get', { task: id }); if (current !== epoch) return;
      selected = task; ref = (task.threads || [])[0] || null; older = []; history = null;
      panel.classList.add('work-selected'); el('work-welcome').hidden = true; el('work-new-form').hidden = true; el('work-conversation').hidden = false;
      el('work-title').textContent = task.title; el('work-title-edit').value = task.title; el('work-case').value = task.caseName; el('work-summary').value = task.summary; el('work-state').value = task.status;
      el('work-project-label').textContent = project(task); el('work-model').value = ''; el('work-runtime').textContent = '';
      choices(el('work-thread'), (task.threads || []).map(function (r, i) { return { id: r.provider + ':' + r.id, name: r.provider + (task.threads.length > 1 ? ' · conversation ' + (i + 1) : '') }; }));
      el('work-thread').hidden = !ref; el('work-composer').hidden = !ref; el('work-older').hidden = true;
      el('work-compose').value = drafts[key()] || ''; renderAttachments(); el('work-messages').textContent = ''; el('work-messages').dataset.signature = ''; el('work-approvals').textContent = ''; el('work-approvals').dataset.signature = '';
      renderDetails(); closeInspector(); renderList(); message('');
      if (ref) await poll(); else if (task.sessions.length) showTerminal(task.sessions[0]);
    } catch (error) { fail(error); }
  }
  function renderDetails() {
    var notes = el('work-notes'); notes.textContent = '';
    selected.notes.forEach(function (n) { var p = node('article', undefined, notes, 'work-note'); node('small', new Date(n.at).toLocaleString(), p, 'work-muted'); appendText(n.text, p); });
    var sessions = el('work-terminals'); sessions.textContent = '';
    selected.sessions.forEach(function (s) {
      var row = node('div', undefined, sessions, 'work-session'); node('span', s.name + ' · ' + s.agent, row);
      button('Inspect', row, function () { showTerminal(s); });
      button(s.stopped ? 'Start' : 'Stop', row, async function () {
        try { await request(s.stopped ? 'start' : 'stop', { session: s.id }); var updated = await request('workspace.get', { task: selected.id }); selected.sessions = updated.sessions; renderDetails(); if (!s.stopped) closeInspector(); } catch (e) { fail(e); }
      });
    });
  }
  function showTerminal(record) {
    el('work-inspector').hidden = false; var query = new URLSearchParams(); query.append('arg', record.agent); query.append('arg', record.workspace); query.append('arg', record.id); query.set('view', 'terminal'); query.set('embedded', '1');
    var url = location.pathname + '?' + query; if (el('work-terminal').getAttribute('src') !== url) el('work-terminal').setAttribute('src', url);
    el('work-inspector-label').textContent = record.name; el('work-inspector').scrollIntoView({ block: 'nearest' });
  }
  function closeInspector() { el('work-inspector').hidden = true; el('work-terminal').removeAttribute('src'); }
  async function inspect() {
    if (!selected) return;
    try { var record = ref ? await request('workspace.inspect', fields()) : selected.sessions[0]; if (record) showTerminal(record); } catch (error) { fail(error); }
  }
  async function preview(path) {
    try {
      var value = await request('workspace.file', fields({ path: path })), body = el('work-preview-body'); body.textContent = ''; el('work-preview').hidden = false; el('work-preview-title').textContent = path;
      if (value.mime) { var img = node('img', undefined, body); img.alt = path; img.src = 'data:' + value.mime + ';base64,' + value.data; }
      else node('pre', value.text, body, 'work-code');
      var blob = value.mime ? new Blob([Uint8Array.from(atob(value.data), function (c) { return c.charCodeAt(0); })], { type: value.mime }) : new Blob([value.text], { type: 'text/plain' });
      var link = node('a', 'Download', body, 'agent-button'); var url = URL.createObjectURL(blob); link.href = url; link.download = path.split('/').pop(); link.addEventListener('click', function () { setTimeout(function () { URL.revokeObjectURL(url); }, 10000); });
    } catch (error) { fail(error); }
  }
  async function send() {
    if (busy || uploading || voice && voice.state() !== 'idle' || !ref || !selected) return; var text = el('work-compose').value; if (!text.trim()) return;
    var currentKey = key(), currentEpoch = epoch, id = sent[currentKey] && sent[currentKey].text === text ? sent[currentKey].id : crypto.randomUUID();
    sent[currentKey] = { text: text, id: id }; setBusy(true); message('Sending…');
    try {
      await request('workspace.send', fields({ text: text, messageId: id, model: el('work-model').value.trim() || undefined, attachments: (attachments[currentKey] || []).map(function (a) { return a.path; }) }));
      if (epoch === currentEpoch) { el('work-compose').value = ''; drafts[currentKey] = ''; persistDrafts(); attachments[currentKey] = []; renderAttachments(); delete sent[currentKey]; message(''); await poll(); }
    } catch (error) { fail(error); } finally { setBusy(false); }
  }
  async function save(method, extra) {
    if (busy || !selected) return; setBusy(true);
    try { var result = await request(method, Object.assign({ task: selected.id, revision: selected.revision }, extra)); selected.revision = result.revision; selected.notes = result.notes; selected.status = result.status; selected.title = result.title; selected.caseName = result.caseName; selected.summary = result.summary;
      el('work-title').textContent = selected.title; renderDetails(); await refresh(); message('Saved.');
    } catch (error) { fail(error); } finally { setBusy(false); }
  }
  function open() {
    options.closeSessions(); panel.hidden = false; options.cover(true); el('tasks-close').focus(); refresh();
    clearInterval(timer); var ticks = 0; timer = setInterval(function () { if (panel.hidden) return; if (!busy) { poll(); if (++ticks % 8 === 0) refresh(); } }, 1500);
  }
  function close() { if (busy) return; rememberDraft(); if (voice) voice.cancel(); panel.hidden = true; ++epoch; clearInterval(timer); closeInspector(); options.cover(false); options.focus(); }
  function renderAttachments() { var area = el('work-attachments'); area.textContent = ''; (attachments[key()] || []).forEach(function (a, i) { button(a.name + ' ×', area, function () { attachments[key()].splice(i, 1); renderAttachments(); }); }); }
  async function attachFiles(files) {
    if (!ref || !uploads || uploading) return; var owner = key(); uploading = true; el('work-send').disabled = true;
    try { for (var file of Array.from(files).slice(0, 10)) { message('Uploading ' + file.name + '…'); var saved = await uploads.send(file); (attachments[owner] ||= []).push({ name: file.name, path: saved.path }); if (key() === owner) renderAttachments(); } message('Files attached.'); }
    catch (error) { fail(error); } finally { uploading = false; uploads.close(); el('work-send').disabled = busy; }
  }
  el('work-attach').addEventListener('click', function () { el('work-files').click(); });
  el('work-files').addEventListener('change', function () { attachFiles(this.files); this.value = ''; });
  panel.addEventListener('paste', function (event) { if (event.clipboardData && event.clipboardData.files.length && !event.clipboardData.getData('text/plain')) { event.preventDefault(); event.stopPropagation(); attachFiles(event.clipboardData.files); } });
  panel.addEventListener('dragover', function (event) { if (event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault(); });
  panel.addEventListener('drop', function (event) { if (event.dataTransfer && event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); attachFiles(event.dataTransfer.files); } });
  el('work-voice').addEventListener('click', function () { if (!voice || !ref) return; if (voice.state() === 'recording') voice.stop(); else if (voice.state() !== 'idle') voice.cancel(); else { voiceKey = key(); voice.start(); } });
  document.addEventListener('visibilitychange', function () { if (document.hidden && voice) voice.cancel(); });
  el('tasks-open').addEventListener('click', open); el('tasks-close').addEventListener('click', close);
  el('work-inbox').addEventListener('click', function () { panel.classList.remove('work-selected'); });
  el('work-refresh').addEventListener('click', function () { refresh(true); if (selected) openTask(selected.id); });
  el('work-search').addEventListener('input', renderList); el('work-filter').addEventListener('change', renderList); el('work-project').addEventListener('change', renderList);
  el('work-compose').addEventListener('input', rememberDraft);
  el('work-compose').addEventListener('keydown', function (event) { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); } });
  el('work-send').addEventListener('click', send);
  el('work-interrupt').addEventListener('click', async function () { if (!ref) return; try { await request('workspace.interrupt', fields()); message('Stop requested.'); await poll(); } catch (e) { fail(e); } });
  el('work-inspect').addEventListener('click', inspect); el('work-inspector-close').addEventListener('click', closeInspector);
  el('work-older').addEventListener('click', function () { if (history && history.cursor) poll(history.cursor); });
  el('work-thread').addEventListener('change', function () { rememberDraft(); ref = selected.threads.find(function (r) { return r.provider + ':' + r.id === el('work-thread').value; }); ++epoch; older = []; history = null; el('work-compose').value = drafts[key()] || ''; poll(); });
  el('work-new').addEventListener('click', function () {
    if (busy) return; rememberDraft(); ++epoch; selected = null; ref = null; closeInspector(); panel.classList.add('work-selected'); el('work-new-form').hidden = false; el('work-conversation').hidden = true; el('work-welcome').hidden = true;
    choices(el('work-new-provider'), options.config.agents); el('work-new-provider').value = 'codex'; choices(el('work-new-project'), options.config.workspaces); el('work-new-title').focus();
  });
  el('work-new-form').addEventListener('submit', async function (event) {
    event.preventDefault(); if (busy) return; setBusy(true); message('Creating…');
    try { var task = await request('workspace.create', { title: el('work-new-title').value, caseName: el('work-new-case').value, workspace: el('work-new-project').value, provider: el('work-new-provider').value });
      el('work-new-title').value = ''; await refresh(true); await openTask(task.id, true); message('');
    } catch (error) { fail(error); } finally { setBusy(false); }
  });
  el('work-add-conversation').addEventListener('click', async function () {
    if (!selected || busy) return; setBusy(true); var id = selected.id;
    try { var task = await request('workspace.addConversation', { task: id, provider: el('work-add-provider').value });
      await openTask(id, true); var latest = task.threads[task.threads.length - 1]; el('work-thread').value = latest.provider + ':' + latest.id; el('work-thread').dispatchEvent(new Event('change')); await refresh(true);
    } catch (error) { fail(error); } finally { setBusy(false); }
  });
  el('work-save').addEventListener('click', function () { save('tasks.update', { title: el('work-title-edit').value, caseName: el('work-case').value, summary: el('work-summary').value, status: el('work-state').value }); });
  el('work-note-save').addEventListener('click', async function () { if (!el('work-note').value.trim()) return; var value = el('work-note').value; await save('tasks.note', { text: value }); if (selected.notes.some(function (n) { return n.text === value.trim(); })) el('work-note').value = ''; });
  el('work-preview-close').addEventListener('click', function () { el('work-preview').hidden = true; });
  panel.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); if (!el('work-preview').hidden) el('work-preview').hidden = true; else close(); }
    if (event.key === 'Tab') { var all = Array.from(panel.querySelectorAll('button,input,textarea,select,a[href]')).filter(function (n) { return n.getClientRects().length && !n.disabled; }); var first = all[0], last = all[all.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
  });
  return { open: open, close: close, connected: function () { if (!panel.hidden && !listing) refresh(); } };
};
