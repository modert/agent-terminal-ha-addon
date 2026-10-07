/* Native Codex Remote setup uses the existing authenticated control channel. */
window.AgentRemote = function (options) {
  'use strict';
  var el = function (id) { return document.getElementById(id); };
  var sheet = el('remote-sheet'), status = el('remote-status'), pairing = el('remote-pairing');
  var state = null, busy = false, timer = null, expires = 0, serial = 0;
  function clearPairing() {
    expires = 0; pairing.hidden = true; el('remote-code').value = ''; el('remote-expiry').textContent = '';
  }
  function render() {
    if (!state) return;
    var names = { disabled: 'Off', connecting: 'Connecting…', connected: 'Connected', errored: 'Connection failed' };
    el('remote-state').textContent = names[state.status] || 'Unavailable';
    el('remote-host').textContent = state.serverName || 'Agent Terminal on Home Assistant';
    status.textContent = state.error || '';
    el('remote-start').hidden = state.enabled;
    el('remote-stop').hidden = !state.enabled;
    el('remote-pair').hidden = !state.enabled;
    el('remote-pair').disabled = busy || state.status !== 'connected';
    el('remote-start').disabled = busy; el('remote-stop').disabled = busy;
    if (!state.enabled || state.status !== 'connected') clearPairing();
    if (expires) {
      var seconds = Math.max(0, Math.ceil(expires - Date.now() / 1000));
      if (!seconds) { clearPairing(); status.textContent = 'Pairing code expired. Generate a new one.'; }
      else el('remote-expiry').textContent = 'Expires in ' + Math.ceil(seconds / 60) + ' min';
    }
  }
  function refresh() {
    if (sheet.hidden || busy) return;
    var generation = serial;
    options.request('remote/status').then(function (value) {
      if (generation !== serial || sheet.hidden) return;
      state = value; render();
    }, function (error) { if (!sheet.hidden && generation === serial) status.textContent = error.message; });
  }
  function run(method) {
    if (busy) return;
    busy = true; var generation = ++serial; status.textContent = method === 'pair' ? 'Generating a pairing code…' : 'Updating Remote…';
    el('remote-start').disabled = el('remote-stop').disabled = el('remote-pair').disabled = true;
    options.request('remote/' + method).then(function (value) {
      busy = false;
      if (generation !== serial || sheet.hidden) { refresh(); return; }
      if (method === 'pair') {
        expires = value.expiresAt;
        el('remote-code').value = value.manualPairingCode;
        pairing.hidden = false;
      } else { state = value; clearPairing(); }
      render();
    }, function (error) { busy = false; if (generation !== serial || sheet.hidden) { refresh(); return; } render(); status.textContent = error.message; });
  }
  function close() {
    sheet.hidden = true; ++serial; clearInterval(timer); timer = null;
    clearPairing(); el('remote-open').focus();
  }
  el('remote-open').addEventListener('click', function () {
    if (!document.getElementById('sessions-sheet').hidden) document.getElementById('sessions-sheet').hidden = true;
    sheet.hidden = false; clearPairing(); state = null;
    el('remote-start').disabled = el('remote-stop').disabled = el('remote-pair').disabled = true;
    status.textContent = 'Checking Remote…'; ++serial; refresh();
    clearInterval(timer); timer = setInterval(refresh, 2000); el('remote-done').focus();
  });
  el('remote-done').addEventListener('click', function () { close(); options.browse(); });
  el('remote-start').addEventListener('click', function () { run('start'); });
  el('remote-stop').addEventListener('click', function () { run('stop'); });
  el('remote-pair').addEventListener('click', function () { run('pair'); });
  el('remote-copy').addEventListener('click', function () {
    var code = el('remote-code').value;
    if (!code) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(function () { status.textContent = 'Pairing code copied.'; }, function () {
        el('remote-code').focus(); el('remote-code').select(); status.textContent = 'Select and copy the pairing code.';
      });
    } else { el('remote-code').focus(); el('remote-code').select(); status.textContent = 'Select and copy the pairing code.'; }
  });
  sheet.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); options.browse(); }
    if (event.key === 'Tab') {
      var items = Array.prototype.filter.call(sheet.querySelectorAll('button, input'), function (n) { return !n.disabled && n.offsetParent !== null; });
      if (!items.length) return;
      var index = items.indexOf(document.activeElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (!event.shiftKey && index === items.length - 1) { event.preventDefault(); items[0].focus(); }
    }
  });
  return { refresh: refresh };
};
