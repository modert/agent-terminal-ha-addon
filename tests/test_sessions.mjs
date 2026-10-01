import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createSessionStore, serve } from '../agent-terminal/rootfs/opt/agent-terminal/sessions.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'named-sessions-'));
  const optionsPath = join(root, 'options.json');
  writeFileSync(optionsPath, JSON.stringify({ agent: 'codex' }));
  const socket = join(root, 'tmux.sock'), tmux = join(root, 'tmux');
  // An isolated server: these tests must never touch a real agent process.
  writeFileSync(tmux, '#!/bin/sh\nexec /usr/bin/tmux -S "' + socket + '" -f /dev/null "$@"\n', { mode: 0o755 });
  const paths = { stateDir: root, homeDirectory: root, optionsPath, tmux };
  const store = createSessionStore(paths);
  t.after(() => { spawnSync(tmux, ['kill-server']); rmSync(root, { recursive: true, force: true }); });
  const run = (...args) => execFileSync(tmux, args, { encoding: 'utf8' }).trim();
  const pid = id => run('list-panes', '-t', '=' + id, '-F', '#{pane_pid}');
  return { root, paths, store, run, pid };
}

test('same provider sessions have independent processes, reattach, and preserve names', t => {
  const { paths, store, pid } = fixture(t);
  const first = store.create({ name: 'Dashboard refresh', agent: 'codex', workspace: 'homeassistant' });
  const second = store.create({ name: 'Attic fan', agent: 'codex', workspace: 'homeassistant' });
  assert.notEqual(first.id, second.id);
  store.ensure('codex', 'homeassistant', first.id, 'exec sleep 120');
  store.ensure('codex', 'homeassistant', second.id, 'exec sleep 120');
  const original = pid(first.id);
  assert.notEqual(original, pid(second.id));
  store.ensure('codex', 'homeassistant', first.id, 'exit 1');
  assert.equal(pid(first.id), original, 'reattach never executes a replacement command');
  store.rename(first.id, 'Review dashboard');
  assert.equal(createSessionStore(paths).get(first.id).name, 'Review dashboard');
  assert.equal(store.list().filter(s => s.running).length, 2);
});

test('stopping persists before reconnect; starting is explicit, including legacy sessions', t => {
  const { paths, store, pid } = fixture(t);
  const id = store.ensure('shell', 'homeassistant', '', 'exec sleep 120');
  assert.equal(id, 'agent-homeassistant-shell');
  const original = pid(id);
  store.stop(id);
  const browser = createSessionStore(paths);
  assert.equal(browser.get(id).stopped, true);
  assert.throws(() => browser.ensure('shell', 'homeassistant', '', 'exec sleep 120'), /Session stopped/);
  assert.equal(browser.list().find(s => s.id === id).running, false);
  browser.rename(id, 'Maintenance');
  assert.equal(browser.get(id).stopped, true, 'renaming cannot restart a stopped agent');
  browser.start(id);
  browser.ensure('shell', 'homeassistant', '', 'exec sleep 120');
  assert.notEqual(pid(id), original);
  assert.equal(browser.get(id).name, 'Maintenance');
});

test('session operations reject paths, commands, mismatched providers and corrupt records', t => {
  const { root, store } = fixture(t);
  for (const id of ['../options', '$(id)', '=agent-homeassistant-shell', 'x:1', 'session-nope', '', null]) {
    assert.throws(() => store.get(id), /Invalid session/);
    assert.throws(() => store.stop(id), /Invalid session/);
  }
  assert.throws(() => store.create({ name: 'x', agent: 'bash -c id', workspace: 'homeassistant' }), /Unknown agent/);
  assert.throws(() => store.create({ name: 'x', agent: 'codex', workspace: '../../data' }), /Invalid workspace/);
  for (const name of ['', '  ', 'line\nbreak', 'x'.repeat(81)]) {
    assert.throws(() => store.create({ name, agent: 'codex', workspace: 'homeassistant' }), /Session name/);
  }
  const record = store.create({ name: '<script>literal</script>', agent: 'codex', workspace: 'homeassistant' });
  assert.throws(() => store.ensure('shell', 'homeassistant', record.id, 'exec sleep 120'), /does not match/);
  assert.throws(() => store.request({ method: 'exec', command: 'id' }), /Unknown session operation/);
  const file = join(root, 'sessions', record.id + '.json');
  writeFileSync(file, '{broken');
  assert.equal(store.list().length, 3, 'a corrupt named session does not hide Main or Shell');
  assert.equal(readFileSync(file, 'utf8'), '{broken');
});

test('concurrent launch and stop serialize across processes', async t => {
  const { root, paths, store, pid } = fixture(t);
  const record = store.create({ name: 'Race', agent: 'shell', workspace: 'homeassistant' });
  const worker = join(root, 'worker.mjs');
  writeFileSync(worker, `import { createSessionStore } from ${JSON.stringify(new URL('../agent-terminal/rootfs/opt/agent-terminal/sessions.mjs', import.meta.url).href)};
    const store = createSessionStore(${JSON.stringify(paths)});
    if (process.argv[2] === 'stop') store.stop(${JSON.stringify(record.id)});
    else { try { store.ensure('shell', 'homeassistant', ${JSON.stringify(record.id)}, 'exec sleep 120'); }
      catch (e) { if (!e.message.includes('Session stopped')) throw e; } }`);
  async function run(operation) {
    const child = spawn(process.execPath, [worker, operation], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', data => { error += data; });
    const [code] = await once(child, 'exit'); assert.equal(code, 0, error);
  }
  await Promise.all([run('ensure'), run('ensure')]);
  assert.match(pid(record.id), /^\d+$/);
  await Promise.all([run('ensure'), run('stop'), run('ensure')]);
  assert.equal(store.get(record.id).stopped, true);
  assert.equal(store.list().find(s => s.id === record.id).running, false);
});

test('management stream handles fragmented requests and reports operations without executing commands', t => {
  const { store } = fixture(t);
  const input = new PassThrough(), output = new PassThrough();
  t.after(() => input.destroy());
  let data = ''; output.on('data', bytes => { data += bytes; });
  serve(store, input, output);
  input.write('{"request":1,"method":"cre');
  input.write('ate","name":"Two","agent":"codex","workspace":"homeassistant"}\n');
  input.write('{"request":2,"method":"exec","command":"id"}\n');
  input.write('not json\n');
  const packets = data.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(packets[0].type, 'sessions');
  assert.equal(packets.find(p => p.request === 1).result.name, 'Two');
  assert.match(packets.find(p => p.request === 2).error, /Unknown session operation/);
  assert.ok(packets.find(p => p.request === null).error);
  assert.equal(store.list().filter(s => s.id.startsWith('session-')).length, 1);
});
