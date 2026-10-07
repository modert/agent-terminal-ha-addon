/* Health settings and incident responses use the authenticated session
 * control stream. Review text is always rendered as text, never HTML. */
window.AgentHealth = function (options) {
  'use strict';
  var el = function (id) { return document.getElementById(id); };
  var sheet = el('health-sheet'), form = el('health-form'), status = el('health-status');
  var snapshot = null, busy = false, dirty = false, selected = '', linked = '';
  var discovery = { agents: [], notifyServices: [] };
  try { linked = new URLSearchParams(window.top.location.search).get('agent_health') || ''; } catch (e) {}
  if (!/^[a-f0-9]{32}$/.test(linked)) linked = '';
  function message(text) { status.textContent = text || ''; }
  function fail(error) { message(error.message || String(error)); }
  function request(method, fields) { return options.request(method, fields); }
  function field(id) { return el('health-' + id); }
  function choose(select, items, values) {
    select.textContent = '';
    items.forEach(function (item) {
      var option = document.createElement('option'); option.value = item.id || item;
      option.textContent = item.name || item; option.selected = values.indexOf(option.value) !== -1;
      select.appendChild(option);
    });
    values.filter(function (value) { return !items.some(function (item) { return (item.id || item) === value; }); }).forEach(function (value) {
      var option = document.createElement('option'); option.value = value; option.textContent = value + ' (saved)'; option.selected = true; select.appendChild(option);
    });
  }
  function reviewerFields() {
    field('ollama-fields').hidden = field('reviewer').value !== 'ollama';
    field('agent-row').hidden = field('reviewer').value !== 'homeassistant';
  }
  function loadSettings() {
    if (!snapshot || dirty) return;
    var c = snapshot.config;
    field('enabled').checked = c.enabled;
    ['reviewer', 'model', 'delayMinutes', 'repeatCount', 'cooldownMinutes', 'investigationAgent', 'ollamaUrl'].forEach(function (key) { field(key).value = c[key]; });
    field('criticalEntities').value = c.criticalEntities.join('\n');
    choose(field('agentId'), discovery.agents, c.agentId ? [c.agentId] : []);
    choose(field('notifyServices'), discovery.notifyServices, c.notifyServices);
    field('test').disabled = false;
    reviewerFields();
  }
  function action(label, fn) {
    var button = document.createElement('button'); button.type = 'button'; button.className = 'agent-button'; button.textContent = label;
    button.addEventListener('click', fn); return button;
  }
  function render() {
    if (!snapshot) return;
    var s = snapshot.status;
    el('health-summary').textContent = (!snapshot.config.enabled ? 'Monitoring is off.' : !s.checkedAt || !s.enabled ? 'Waiting for the monitor’s next check…' :
      'Last checked ' + new Date(s.checkedAt).toLocaleTimeString()) + (s.errors && s.errors.length ? ' · ' + s.errors.join(' · ') : '');
    var list = el('health-incidents'); list.textContent = '';
    var items = snapshot.incidents.filter(function (item) { return !item.dismissed || item.id === selected; });
    if (!items.length) { var empty = document.createElement('p'); empty.textContent = 'No incidents to review. New monitoring starts with the current log as its baseline.'; list.appendChild(empty); }
    items.forEach(function (item) {
      var card = document.createElement('article'); card.className = 'health-incident'; card.id = 'health-incident-' + item.id;
      if (item.id === selected) card.classList.add('health-selected');
      var title = document.createElement('h3'); title.textContent = item.title;
      var meta = document.createElement('p'); meta.className = 'health-meta';
      meta.textContent = (item.resolved ? item.kind === 'log' ? 'Quiet' : 'Recovered' : item.severity) + ' · ' + item.count + ' observations' +
        (item.snoozedUntil > Date.now() ? ' · Snoozed until ' + new Date(item.snoozedUntil).toLocaleTimeString() : '') + (item.dismissed ? ' · Dismissed' : '');
      var summary = document.createElement('p'); summary.textContent = item.review && item.review.summary || item.evidence;
      var details = document.createElement('details'), caption = document.createElement('summary'), evidence = document.createElement('pre');
      caption.textContent = 'Evidence'; evidence.textContent = item.evidence + (item.reviewError ? '\nReviewer: ' + item.reviewError : '');
      details.appendChild(caption); details.appendChild(evidence);
      var actions = document.createElement('div'); actions.className = 'health-actions';
      actions.appendChild(action('Investigate', function () {
        perform('health.investigate', { incident: item.id }, function (result) { close(); options.investigate(result); });
      }));
      if (!item.resolved && !item.dismissed) {
        actions.appendChild(action('Snooze 1h', function () { perform('health.snooze', { incident: item.id }, reload); }));
        actions.appendChild(action('Dismiss', function () { perform('health.dismiss', { incident: item.id }, reload); }));
      }
      card.appendChild(title); card.appendChild(meta); card.appendChild(summary); card.appendChild(details); card.appendChild(actions); list.appendChild(card);
    });
  }
  function update(value) { snapshot = value; if (!sheet.hidden) { loadSettings(); render(); } }
  function reload() { return request('health.get').then(update, fail); }
  function perform(method, fields, success) {
    if (busy) return;
    busy = true; message('Working…'); form.setAttribute('aria-busy', 'true');
    request(method, fields).then(function (value) {
      busy = false; message(''); form.setAttribute('aria-busy', 'false'); if (success) success(value);
    }, function (error) { busy = false; form.setAttribute('aria-busy', 'false'); fail(error); });
  }
  function open(id) {
    options.closeSessions(); selected = id || ''; sheet.hidden = false; message('');
    field('enabled').focus();
    reload().then(function () {
      if (selected) { var card = el('health-incident-' + selected); if (card) card.scrollIntoView({ block: 'nearest' }); }
    });
    request('health.discover').then(function (value) { discovery = value; loadSettings(); }, fail);
  }
  function close() { if (busy) return; sheet.hidden = true; options.focus(); }
  form.addEventListener('input', function () { dirty = true; field('test').disabled = true; });
  form.addEventListener('change', function () { dirty = true; field('test').disabled = true; reviewerFields(); });
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var c = { enabled: field('enabled').checked };
    ['reviewer', 'model', 'agentId', 'investigationAgent', 'ollamaUrl'].forEach(function (key) { c[key] = field(key).value.trim(); });
    ['delayMinutes', 'repeatCount', 'cooldownMinutes'].forEach(function (key) { c[key] = Number(field(key).value); });
    c.criticalEntities = field('criticalEntities').value.split(/[\s,]+/).filter(Boolean);
    c.notifyServices = Array.prototype.filter.call(field('notifyServices').options, function (o) { return o.selected; }).map(function (o) { return o.value; });
    perform('health.save', { config: c }, function (value) { dirty = false; update(value); message('Settings saved. Changes apply on the next check.'); });
  });
  el('health-done').addEventListener('click', close);
  field('test').addEventListener('click', function () {
    perform('health.test', {}, function (result) { message('Reviewer answered: ' + result.severity + ' · ' + result.summary); });
  });
  el('health-open').addEventListener('click', function () { open(); });
  sheet.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      var nodes = Array.prototype.filter.call(sheet.querySelectorAll('button, input, select, textarea, summary'), function (n) { return !n.disabled && n.offsetParent !== null; });
      var i = nodes.indexOf(document.activeElement);
      if (nodes.length && ((event.shiftKey && i <= 0) || (!event.shiftKey && i === nodes.length - 1))) { event.preventDefault(); nodes[event.shiftKey ? nodes.length - 1 : 0].focus(); }
    }
  });
  return { update: function (value) {
    update(value);
    if (linked) { var id = linked; linked = ''; open(id); }
  }, open: open };
};
