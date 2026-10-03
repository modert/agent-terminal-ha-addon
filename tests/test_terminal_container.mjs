// Real ttyd -> agent-session -> tmux integration. Only provider executables
// are stubbed: tests never sign in, make model requests, or contact live HA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

test('real web sessions preserve processes, workspace cwd, and provider environments', {
  skip: process.env.AGENT_TERMINAL_TEST_CONTAINER !== '1', timeout: 45000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'terminal-session-test-'));
  const options = readFileSync('/data/options.json');
  const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
  const tmux = (...args) => run('tmux', args);
  function panePid(session) {
    // display-message's target-pane lookup can resolve only the session and
    // leave pane formats empty. Enumerate panes and match the exact session.
    const pane = tmux('list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}')
      .split('\n').map(line => line.split('\t')).find(([name]) => name === session);
    assert.ok(pane, 'missing pane for ' + session);
    assert.match(pane[1], /^\d+$/, 'missing process ID for ' + session);
    return pane[1];
  }
  const sockets = [];
  let service;
  t.after(() => {
    sockets.forEach(socket => socket.close());
    service?.kill();
    spawnSync('tmux', ['kill-server']);
    writeFileSync('/data/options.json', options);
    rmSync(root, { recursive: true, force: true });
  });
  for (const agent of ['claude', 'codex', 'trusted-custom']) {
    writeFileSync(join(root, agent), '#!/usr/bin/env bash\nprintf "TEST-AGENT:%s:%s:%s:%s:%s\\n" "${0##*/}" "$AGENT_WORKSPACE" "$PWD" "$CODEX_HOME" "$CLAUDE_CONFIG_DIR"\nexec bash -l\n', { mode: 0o755 });
  }
  writeFileSync('/data/options.json', JSON.stringify({ ...JSON.parse(options), web_command: join(root, 'trusted-custom') }));
  run('agent-workspace', ['create', 'web-test', 'Web test', join(root, 'task folder')]);
  let logs = '';
  service = spawn('bash', ['/etc/services.d/ttyd/run'], { env: { ...process.env, PATH: root + ':' + process.env.PATH } });
  service.stdout.on('data', data => { logs += data; });
  service.stderr.on('data', data => { logs += data; });
  async function until(check, message) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await check()) return;
      await delay(50);
    }
    assert.fail(message + '\n' + logs);
  }
  await until(async () => { try { return (await fetch('http://127.0.0.1:8099/token')).ok; } catch { return false; } }, 'ttyd did not start');
  let html = await (await fetch('http://127.0.0.1:8099/')).text();
  assert.match(html, /"id":"web-test"/);
  assert.equal(html.includes(join(root, 'trusted-custom')), false, 'custom command must not enter HTML');
  run('agent-workspace', ['create', 'second-test', 'Second test', join(root, 'second')]);
  html = await (await fetch('http://127.0.0.1:8099/')).text();
  assert.match(html, /"id":"second-test"/, 'ttyd must serve updated workspaces without restarting');

  async function connect(agent, workspace = 'homeassistant', session) {
    const query = new URLSearchParams();
    if (agent) {
      query.append('arg', agent);
      if (agent !== 'sessions' && agent !== 'uploads') query.append('arg', workspace);
      if (session) query.append('arg', session);
    }
    const socket = new WebSocket('ws://127.0.0.1:8099/ws?' + query, ['tty']);
    sockets.push(socket); socket.binaryType = 'arraybuffer';
    let screen = '';
    socket.addEventListener('message', event => {
      const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
      if (text[0] === '0') screen += text.slice(1);
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener('error', reject, { once: true });
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ AuthToken: '', columns: 180, rows: 30 })); resolve();
      }, { once: true });
    });
    return { socket, screen: () => screen };
  }
  const claude = await connect('claude', 'web-test');
  await until(() => claude.screen().includes('TEST-AGENT:claude:web-test:'), 'Claude session did not start');
  const target = '=agent-web-test-claude';
  const pid = panePid('agent-web-test-claude');
  // Check cwd from inside the actual login shell, after /etc/profile executes.
  claude.socket.send('0printf "%s" "$PWD" > ' + join(root, 'cwd') + '\r');
  await until(() => existsSync(join(root, 'cwd')), 'shell did not receive input');
  assert.equal(readFileSync(join(root, 'cwd'), 'utf8'), join(root, 'task folder'));
  assert.equal(tmux('show-environment', '-t', target, 'CODEX_HOME'), 'CODEX_HOME=/data/codex');
  assert.equal(tmux('show-environment', '-t', target, 'CLAUDE_CONFIG_DIR'), 'CLAUDE_CONFIG_DIR=/data/claude/.claude');
  assert.equal(tmux('show-environment', '-t', target, 'AGENT'), 'AGENT=claude');
  claude.socket.close();
  const codex = await connect('codex', 'web-test');
  await until(() => codex.screen().includes('TEST-AGENT:codex:web-test:'), 'Codex session did not start');
  assert.notEqual(panePid('agent-web-test-codex'), pid);
  assert.equal(tmux('show-environment', '-t', '=agent-web-test-codex', 'AGENT'), 'AGENT=codex');
  const again = await connect('claude', 'web-test');
  await until(() => again.screen().includes('TEST-AGENT:claude:web-test:'), 'Claude did not reattach');
  assert.equal(panePid('agent-web-test-claude'), pid, 'reattaching must preserve the live process');
  run('agent-session', ['--agent', 'claude', '--workspace', 'web-test']);
  assert.equal(panePid('agent-web-test-claude'), pid, 'SSH command must attach the same session');
  const second = await connect('claude', 'second-test');
  await until(() => second.screen().includes('TEST-AGENT:claude:second-test:'), 'second workspace did not start');
  assert.notEqual(panePid('agent-second-test-claude'), pid);
  const shell = await connect('shell', 'web-test');
  await until(() => spawnSync('tmux', ['has-session', '-t', '=agent-web-test-shell']).status === 0, 'shell did not start');
  const custom = await connect();
  await until(() => custom.screen().includes('TEST-AGENT:trusted-custom:homeassistant:'), 'configured default custom command did not start');

  // Exercise the word-editing commands against real Bash readline, through
  // ttyd's PTY and tmux. The text is consumed by read, never run as a command.
  for (const [name, input, expected] of [
    ['word-backspace', 'alpha beta\x1b\x7f', 'alpha '],
    ['word-boundary', 'alpha foo/bar\x1b\x7f', 'alpha foo/'],
    ['word-delete', 'alpha beta gamma\x01\x1bf\x1bd', 'alpha gamma'],
    ['word-left-right', 'alpha beta gamma\x1bbX\x01\x1bfY', 'alphaY beta Xgamma'],
  ]) {
    const output = join(root, name);
    shell.socket.send('0printf \'%s%s\' \'editing-ready-\' \'' + name +
      '\'; IFS= read -r -e WORD_TEST; printf \'%s\' "$WORD_TEST" > ' + output + '\r');
    await until(() => shell.screen().includes('editing-ready-' + name), 'word editor did not open');
    shell.socket.send('0' + input + '\r');
    await until(() => existsSync(output), 'word editor did not receive input');
    assert.equal(readFileSync(output, 'utf8'), expected, name);
  }

  // The actual ttyd PTY carries a raw JSON control stream, independently of
  // terminal input. Metadata updates must not enter either provider's stdin.
  const control = await connect('sessions');
  await until(() => control.screen().includes('"type":"sessions"'), 'session control stream did not start');
  let request = 0;
  async function manage(method, fields = {}) {
    const id = ++request;
    control.socket.send('0' + JSON.stringify({ request: id, method, ...fields }) + '\n');
    let reply;
    await until(() => {
      reply = control.screen().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
        .find(packet => packet.request === id && !packet.method);
      return reply;
    }, 'management request did not complete: ' + method);
    assert.equal(reply.error, undefined);
    return reply.result;
  }
  const namedA = await manage('create', { name: 'Dashboard refresh', description: 'Simplify the tablet overview', agent: 'codex', workspace: 'web-test' });
  const namedB = await manage('create', { name: 'Attic fan', agent: 'codex', workspace: 'web-test' });
  const namedView = await connect('codex', 'web-test', namedA.id);
  const secondView = await connect('codex', 'web-test', namedB.id);
  await until(() => namedView.screen().includes('TEST-AGENT:codex:web-test:') && secondView.screen().includes('TEST-AGENT:codex:web-test:'), 'named sessions did not start');
  const namedPid = panePid(namedA.id);
  assert.notEqual(namedPid, panePid(namedB.id));
  namedView.socket.close();
  const reattached = await connect('codex', 'web-test', namedA.id);
  await until(() => reattached.screen().includes('TEST-AGENT:codex:web-test:'), 'named session did not reattach');
  assert.equal(panePid(namedA.id), namedPid);
  run('agent-session', ['--session', namedA.id]);
  assert.equal(panePid(namedA.id), namedPid, 'SSH must resolve the stored provider and workspace');
  await manage('rename', { session: namedA.id, name: 'Review dashboard', description: 'Check layout and spacing' });
  assert.equal((await manage('list')).sessions.find(s => s.id === namedA.id).name, 'Review dashboard');
  assert.equal((await manage('list')).sessions.find(s => s.id === namedA.id).description, 'Check layout and spacing');
  await manage('stop', { session: namedA.id });
  assert.notEqual(spawnSync('agent-session', ['--web', 'codex', 'web-test', namedA.id]).status, 0);
  assert.notEqual(spawnSync('tmux', ['has-session', '-t', '=' + namedA.id]).status, 0, 'reconnect must not restart a stopped session');
  assert.equal(spawnSync('tmux', ['has-session', '-t', '=' + namedB.id]).status, 0, 'stop must leave the other named session running');
  await manage('start', { session: namedA.id });
  const started = await connect('codex', 'web-test', namedA.id);
  await until(() => started.screen().includes('TEST-AGENT:codex:web-test:'), 'explicit start did not work');
  assert.notEqual(panePid(namedA.id), namedPid);
  assert.equal((await manage('list')).sessions.find(s => s.id === namedA.id).description, 'Check layout and spacing');

  // Files travel on their own connection through a real ttyd PTY, in lines
  // far longer than a cooked terminal accepts; the reply is the saved path.
  const receiver = await connect('uploads');
  await until(() => receiver.screen().includes('"type":"ready"'), 'upload receiver did not start');
  const upload = Buffer.from(Array.from({ length: 200000 }, (_, i) => (i * 7) % 256));
  let uploadRequest = 0;
  async function attach(method, fields = {}) {
    const id = ++uploadRequest;
    receiver.socket.send('0' + JSON.stringify({ request: id, method, ...fields }) + '\n');
    let reply;
    await until(() => (reply = receiver.screen().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
      .find(packet => packet.request === id)), 'upload request did not complete: ' + method);
    assert.equal(reply.error, undefined);
    return reply.result;
  }
  const { upload: uploadId } = await attach('begin', { name: 'ttyd check.bin', size: upload.length });
  for (let offset = 0; offset < upload.length; offset += 65536) {
    await attach('chunk', { upload: uploadId, data: upload.subarray(offset, offset + 65536).toString('base64') });
  }
  const saved = await attach('finish', { upload: uploadId });
  assert.match(saved.path, /^\/data\/agent-terminal\/uploads\/\d{4}-\d{2}-\d{2}\/\d{6}-[0-9a-f]{6}-ttyd-check\.bin$/);
  assert.deepEqual(readFileSync(saved.path), upload, 'bytes arrive unchanged through the PTY');
  assert.equal(receiver.screen().includes(upload.subarray(0, 48).toString('base64')), false, 'the PTY must not echo input back');
  rmSync(saved.path);

  const before = tmux('list-sessions', '-F', '#{session_name}');
  for (const args of [['--web', 'bash -c id'], ['--web', 'shell', '../../data'], ['--web', 'shell', 'unknown'], ['--web', 'shell', 'homeassistant', 'extra'],
    ['--web', 'sessions', 'homeassistant'], ['--web', 'uploads', 'homeassistant'], ['--web', 'shell', 'web-test', namedA.id]]) {
    assert.notEqual(spawnSync('agent-session', args).status, 0, 'invalid web selection was accepted');
  }
  assert.equal(tmux('list-sessions', '-F', '#{session_name}'), before, 'invalid requests must not create sessions');
  assert.equal(shell.socket.readyState, WebSocket.OPEN);
});
