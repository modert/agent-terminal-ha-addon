import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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
  const first = store.create({ name: 'Dashboard refresh', description: 'Make the wall tablet easier to read', agent: 'codex', workspace: 'homeassistant' });
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
  assert.equal(createSessionStore(paths).get(first.id).description, 'Make the wall tablet easier to read', 'name-only clients preserve the purpose');
  store.request({ method: 'rename', session: first.id, name: 'Review dashboard', description: 'Check the tablet layout' });
  assert.equal(createSessionStore(paths).get(first.id).description, 'Check the tablet layout');
  assert.equal(store.list().filter(s => s.running).length, 2);
});

test('stopping persists before reconnect; starting is explicit, including legacy sessions', t => {
  const { paths, store, pid } = fixture(t);
  const id = store.ensure('shell', 'homeassistant', '', 'exec sleep 120');
  assert.equal(id, 'agent-homeassistant-shell');
  const original = pid(id);
  assert.equal(store.get(id).description, '', 'legacy sessions do not need a metadata migration');
  store.rename(id, 'Maintenance', 'Inspect the automation logs');
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
  assert.equal(browser.get(id).description, 'Inspect the automation logs', 'stop, start and rename preserve purpose');
});

test('session operations reject paths, commands, mismatched providers and corrupt records', t => {
  const { root, store } = fixture(t);
  for (const id of ['../options', '$(id)', '=agent-homeassistant-shell', 'x:1', 'session-nope', '', null]) {
    assert.throws(() => store.get(id), /Invalid session/);
    assert.throws(() => store.stop(id), /Invalid session/);
    assert.throws(() => store.remove(id), /Invalid session/);
  }
  assert.throws(() => store.create({ name: 'x', agent: 'bash -c id', workspace: 'homeassistant' }), /Unknown agent/);
  assert.throws(() => store.create({ name: 'x', agent: 'codex', workspace: '../../data' }), /Invalid workspace/);
  for (const name of ['', '  ', 'line\nbreak', 'x'.repeat(81)]) {
    assert.throws(() => store.create({ name, agent: 'codex', workspace: 'homeassistant' }), /Session name/);
  }
  const record = store.create({ name: '<script>literal</script>', agent: 'codex', workspace: 'homeassistant' });
  for (const description of ['x'.repeat(161), 'line\nbreak', null, 123]) {
    assert.throws(() => store.create({ name: 'Purpose', description, agent: 'codex', workspace: 'homeassistant' }), /Purpose/);
    assert.throws(() => store.rename(record.id, 'Changed', description), /Purpose/);
    assert.equal(store.get(record.id).name, '<script>literal</script>', 'invalid details cannot partially rename a session');
  }
  assert.throws(() => store.ensure('shell', 'homeassistant', record.id, 'exec sleep 120'), /does not match/);
  assert.throws(() => store.request({ method: 'exec', command: 'id' }), /Unknown session operation/);
  const file = join(root, 'sessions', record.id + '.json');
  writeFileSync(file, '{broken');
  assert.equal(store.list().length, 3, 'a corrupt named session does not hide Main or Shell');
  assert.equal(readFileSync(file, 'utf8'), '{broken');
});

test('deleting an added session ends only its task and prevents stale clients from recreating it', t => {
  const { root, paths, store, pid, run } = fixture(t);
  const first = store.create({ name: 'Temporary', agent: 'codex', workspace: 'homeassistant' });
  const second = store.create({ name: 'Keep working', agent: 'codex', workspace: 'homeassistant' });
  const third = store.create({ name: 'Never opened', agent: 'shell', workspace: 'homeassistant' });
  store.ensure('codex', 'homeassistant', first.id, 'exec sleep 120');
  store.ensure('codex', 'homeassistant', second.id, 'exec sleep 120');
  const survivor = pid(second.id);
  const files = ['configuration.yaml', 'saved-conversation.json', 'uploaded-file.txt', 'options.json'];
  for (const file of files.slice(0, -1)) writeFileSync(join(root, file), 'Keep ' + file);
  const contents = files.map(file => readFileSync(join(root, file), 'utf8'));
  const stale = createSessionStore(paths);
  stale.get(first.id);
  assert.equal(store.request({ method: 'delete', session: first.id }).id, first.id);
  assert.equal(existsSync(join(root, 'sessions', first.id + '.json')), false);
  assert.equal(existsSync(join(root, 'session-locks', first.id)), true, 'keep the shared lock inode for waiting clients');
  assert.ok(!run('list-sessions', '-F', '#{session_name}').split('\n').includes(first.id));
  assert.equal(pid(second.id), survivor, 'deletion cannot end another task in the workspace');
  for (const browser of [stale, createSessionStore(paths)]) {
    assert.ok(!browser.list().some(s => s.id === first.id));
    assert.throws(() => browser.get(first.id), /Unknown session/);
    assert.throws(() => browser.ensure('codex', 'homeassistant', first.id, 'exec sleep 120'), /Unknown session/);
    assert.throws(() => browser.start(first.id), /Unknown session/);
    assert.throws(() => browser.rename(first.id, 'Stale edit'), /Unknown session/);
    assert.throws(() => browser.remove(first.id), /Unknown session/);
  }
  store.stop(second.id);
  store.remove(second.id);
  store.remove(third.id);
  assert.ok(store.list().every(s => !s.id.startsWith('session-')), 'stopped and unopened sessions can also be deleted');
  assert.deepEqual(files.map(file => readFileSync(join(root, file), 'utf8')), contents);
});

test('built-in sessions stay available even after renaming, and failed termination keeps the record', t => {
  const { root, paths, store, pid } = fixture(t);
  const builtin = store.ensure('shell', 'homeassistant', '', 'exec sleep 120');
  const original = pid(builtin);
  store.rename(builtin, 'My temporary name');
  assert.throws(() => store.remove(builtin), /Built-in sessions cannot be deleted/);
  assert.equal(pid(builtin), original);
  assert.equal(store.get(builtin).stopped, false);
  const record = store.create({ name: 'Cannot stop yet', agent: 'shell', workspace: 'homeassistant' });
  store.ensure('shell', 'homeassistant', record.id, 'exec sleep 120');
  const stubborn = join(root, 'stubborn-tmux');
  writeFileSync(stubborn, '#!/bin/sh\nif [ "$1" = kill-session ]; then exit 1; fi\nexec "' + paths.tmux + '" "$@"\n', { mode: 0o755 });
  assert.throws(() => createSessionStore({ ...paths, tmux: stubborn }).remove(record.id), /Could not stop session/);
  assert.equal(store.get(record.id).stopped, true, 'a failed deletion keeps the record and blocks automatic relaunch');
  assert.match(pid(record.id), /^\d+$/);
  store.remove(record.id);
  assert.throws(() => store.get(record.id), /Unknown session/);
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
  const id = packets.find(p => p.request === 1).result.id;
  data = '';
  input.write(JSON.stringify({ request: 3, method: 'delete', session: id }) + '\n');
  const deleted = data.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(deleted[0].result.id, id);
  assert.equal(deleted[1].type, 'sessions');
  assert.ok(!deleted[1].sessions.some(s => s.id === id), 'all clients receive a snapshot without the deleted session');
});

test('deletion serializes with launches and stale start requests across processes', async t => {
  const { root, paths, store, run } = fixture(t);
  // Keep the server alive so list-sessions can also detect an orphaned task.
  store.ensure('shell', 'homeassistant', '', 'exec sleep 120');
  const record = store.create({ name: 'Delete race', agent: 'shell', workspace: 'homeassistant' });
  store.ensure('shell', 'homeassistant', record.id, 'exec sleep 120');
  const worker = join(root, 'delete-worker.mjs');
  writeFileSync(worker, `import { createSessionStore } from ${JSON.stringify(new URL('../agent-terminal/rootfs/opt/agent-terminal/sessions.mjs', import.meta.url).href)};
    const store = createSessionStore(${JSON.stringify(paths)});
    try {
      if (process.argv[2] === 'delete') store.remove(${JSON.stringify(record.id)});
      else if (process.argv[2] === 'start') store.start(${JSON.stringify(record.id)});
      else store.ensure('shell', 'homeassistant', ${JSON.stringify(record.id)}, 'exec sleep 120');
    } catch (e) { if (!e.message.includes('Unknown session')) throw e; }`);
  async function launch(operation) {
    const child = spawn(process.execPath, [worker, operation], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', data => { error += data; });
    const [code] = await once(child, 'exit'); assert.equal(code, 0, error);
  }
  await Promise.all([launch('ensure'), launch('delete'), launch('start'), launch('ensure')]);
  assert.throws(() => createSessionStore(paths).get(record.id), /Unknown session/);
  assert.ok(!run('list-sessions', '-F', '#{session_name}').split('\n').includes(record.id));
});
