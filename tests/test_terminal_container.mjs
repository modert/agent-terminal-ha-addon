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

  async function connect(agent, workspace = 'homeassistant') {
    const query = new URLSearchParams();
    if (agent) { query.append('arg', agent); query.append('arg', workspace); }
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
  const pid = tmux('display-message', '-p', '-t', target, '#{pane_pid}');
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
  assert.notEqual(tmux('display-message', '-p', '-t', '=agent-web-test-codex', '#{pane_pid}'), pid);
  assert.equal(tmux('show-environment', '-t', '=agent-web-test-codex', 'AGENT'), 'AGENT=codex');
  const again = await connect('claude', 'web-test');
  await until(() => again.screen().includes('TEST-AGENT:claude:web-test:'), 'Claude did not reattach');
  assert.equal(tmux('display-message', '-p', '-t', target, '#{pane_pid}'), pid, 'reattaching must preserve the live process');
  const second = await connect('claude', 'second-test');
  await until(() => second.screen().includes('TEST-AGENT:claude:second-test:'), 'second workspace did not start');
  assert.notEqual(tmux('display-message', '-p', '-t', '=agent-second-test-claude', '#{pane_pid}'), pid);
  const shell = await connect('shell', 'web-test');
  await until(() => spawnSync('tmux', ['has-session', '-t', '=agent-web-test-shell']).status === 0, 'shell did not start');
  const custom = await connect();
  await until(() => custom.screen().includes('TEST-AGENT:trusted-custom:homeassistant:'), 'configured default custom command did not start');

  const before = tmux('list-sessions', '-F', '#{session_name}');
  for (const args of [['--web', 'bash -c id'], ['--web', 'shell', '../../data'], ['--web', 'shell', 'unknown'], ['--web', 'shell', 'homeassistant', 'extra']]) {
    assert.notEqual(spawnSync('agent-session', args).status, 0, 'invalid web selection was accepted');
  }
  assert.equal(tmux('list-sessions', '-F', '#{session_name}'), before, 'invalid requests must not create sessions');
  assert.equal(shell.socket.readyState, WebSocket.OPEN);
});
