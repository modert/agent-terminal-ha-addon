import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
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

test('each named task remembers its exact conversation across stops, restarts and renames', t => {
  const { paths, store, run, root } = fixture(t);
  const a = store.create({ name: 'First task', agent: 'codex', workspace: 'homeassistant' });
  const b = store.create({ name: 'Second task', agent: 'codex', workspace: 'homeassistant' });
  const aID = '01990000-0000-7000-8000-000000000001', bID = '01990000-0000-7000-8000-000000000002';
  const env = (id, key) => run('show-environment', '-t', '=' + id, key).slice(key.length + 1);
  const event = session_id => ({ hook_event_name: 'SessionStart', source: 'startup', session_id });
  for (const [record, conversationId] of [[a, aID], [b, bID]]) {
    store.ensure('codex', 'homeassistant', record.id, 'exec sleep 120');
    assert.equal(env(record.id, 'AGENT_CONVERSATION_ID'), '');
    assert.equal(env(record.id, 'AGENT_TERMINAL_SESSION_ID'), record.id);
    assert.equal(store.remember(record.id, 'codex', env(record.id, 'AGENT_TERMINAL_LAUNCH_ID'), event(conversationId)), true);
  }
  const firstLaunch = env(a.id, 'AGENT_TERMINAL_LAUNCH_ID');
  store.rename(a.id, 'Renamed task');
  store.stop(a.id);
  const restarted = createSessionStore(paths);
  assert.equal(restarted.get(a.id).conversationId, aID);
  assert.equal(restarted.get(b.id).conversationId, bID);
  restarted.start(a.id);
  restarted.ensure('codex', 'homeassistant', a.id, 'exec sleep 120');
  assert.equal(env(a.id, 'AGENT_CONVERSATION_ID'), aID);
  assert.notEqual(env(a.id, 'AGENT_TERMINAL_LAUNCH_ID'), firstLaunch);
  assert.equal(restarted.remember(a.id, 'codex', firstLaunch, { ...event(bID), source: 'resume' }), false, 'late callback cannot redirect a new launch');
  assert.equal(restarted.get(a.id).conversationId, aID);
  const resumeFile = join(root, 'conversations', a.id + '.json');
  // Simulate a pre-upgrade control connection writing only the old fields.
  writeFileSync(join(root, 'sessions', a.id + '.json'), JSON.stringify({ ...a, name: 'Old client rename' }));
  assert.equal(restarted.get(a.id).conversationId, aID);
  restarted.remove(a.id);
  assert.equal(existsSync(resumeFile), false);
  assert.throws(() => restarted.remember(a.id, 'codex', firstLaunch, event(aID)), /Unknown session/);
  assert.equal(restarted.get(b.id).conversationId, bID);
});

test('conversation hooks validate launch ownership, track explicit conversation switches and stop failures', t => {
  const { store, run, root, paths } = fixture(t);
  const id = 'agent-homeassistant-claude';
  store.ensure('claude', 'homeassistant', id, 'exec sleep 120');
  const token = run('show-environment', '-t', '=' + id, 'AGENT_TERMINAL_LAUNCH_ID').split('=')[1];
  const a = '550e8400-e29b-41d4-a716-446655440000', b = '550e8400-e29b-41d4-a716-446655440001';
  const transcript = join(root, a + '.jsonl');
  const event = { hook_event_name: 'SessionStart', source: 'startup', session_id: a, transcript_path: transcript };
  assert.equal(store.remember(id, 'codex', token, event), false);
  assert.equal(store.remember(id, 'claude', 'wrong-launch', event), false);
  assert.equal(store.remember(id, 'claude', token, { ...event, session_id: '../../data' }), false);
  assert.equal(store.remember(id, 'claude', token, event), true);
  assert.equal(store.remember(id, 'claude', token, { ...event, session_id: b }), false, 'an unrelated nested startup cannot claim the terminal');
  writeFileSync(transcript, 'saved history');
  assert.equal(store.remember(id, 'claude', token, { ...event, hook_event_name: 'Stop' }), true);
  assert.equal(JSON.parse(readFileSync(join(root, 'conversations', id + '.json'))).hasTranscript, true);
  assert.equal(store.remember(id, 'claude', token, { ...event, source: 'clear', session_id: b, transcript_path: null }), true);
  assert.equal(createSessionStore(paths).get(id).conversationId, b);
  assert.equal(store.remember(id, 'claude', token, { ...event, hook_event_name: 'Stop' }), false);
  assert.equal(store.failed(id, 'stale-launch'), false);
  assert.equal(store.get(id).stopped, false);
  assert.equal(store.failed(id, token), true);
  assert.equal(store.get(id).stopped, true);
  assert.equal(store.remember(id, 'claude', token, event), false, 'stopped sessions stay stopped');
  assert.throws(() => store.ensure('claude', 'homeassistant', id, 'exec sleep 120'), /Session stopped/);
  assert.throws(() => store.request({ method: 'remember', session: id, conversationId: a }), /Unknown session operation/, 'the browser cannot forge hook callbacks');
});

test('Ollama sessions persist exact conversations independently of ChatGPT', t => {
  const { store, run, paths, root } = fixture(t);
  const local = store.create({ name: 'Local task', agent: 'ollama', workspace: 'homeassistant' });
  store.ensure('ollama', 'homeassistant', local.id, 'exec sleep 120');
  const token = run('show-environment', '-t', '=' + local.id, 'AGENT_TERMINAL_LAUNCH_ID').split('=')[1];
  const conversation = '550e8400-e29b-41d4-a716-446655440010';
  assert.equal(store.remember(local.id, 'codex', token, { hook_event_name: 'SessionStart', source: 'startup', session_id: conversation }), false);
  const hook = new URL('../agent-terminal/rootfs/opt/agent-terminal/session-hook.mjs', import.meta.url).pathname;
  execFileSync(process.execPath, [hook, 'codex'], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: conversation }),
    env: { ...process.env, AGENT: 'ollama', AGENT_TERMINAL_STATE_DIR: root, AGENT_TERMINAL_SESSION_ID: local.id, AGENT_TERMINAL_LAUNCH_ID: token },
  });
  assert.equal(store.get(local.id).conversationId, conversation);
  store.stop(local.id); store.start(local.id);
  const reopened = createSessionStore(paths);
  reopened.ensure('ollama', 'homeassistant', local.id, 'exec sleep 120');
  assert.equal(run('show-environment', '-t', '=' + local.id, 'AGENT_CONVERSATION_ID'), 'AGENT_CONVERSATION_ID=' + conversation);
  assert.equal(reopened.get('agent-homeassistant-ollama').agent, 'ollama');
});

test('an Antigravity session follows the conversation its hook names', t => {
  const { store, run, paths, root } = fixture(t);
  const task = store.create({ name: 'Google task', agent: 'antigravity', workspace: 'homeassistant' });
  store.ensure('antigravity', 'homeassistant', task.id, 'exec sleep 120');
  const launchToken = id => run('show-environment', '-t', '=' + id, 'AGENT_TERMINAL_LAUNCH_ID').split('=')[1];
  const token = launchToken(task.id);
  const hook = new URL('../agent-terminal/rootfs/opt/agent-terminal/session-hook.mjs', import.meta.url).pathname;
  // The payload Antigravity 1.3.3 sends, with its camelCase names.
  const report = (event, payload, session = task.id, launch = token) => execFileSync(process.execPath, [hook, 'antigravity', event], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, AGENT_TERMINAL_STATE_DIR: root, AGENT_TERMINAL_SESSION_ID: session, AGENT_TERMINAL_LAUNCH_ID: launch },
  });
  const a = '1623a59b-b6c3-4f18-b109-0ba48b324606', b = '3299a7c9-d689-42ee-9def-e9016286efc2';
  const transcript = join(root, 'transcript_full.jsonl');
  const saved = () => JSON.parse(readFileSync(join(root, 'conversations', task.id + '.json')));
  assert.equal(report('PreInvocation', { conversationId: a, transcriptPath: transcript, invocationNum: 0, modelName: 'auto' }), '{}\n',
    'Antigravity reads the output as the hook\'s answer');
  assert.equal(store.get(task.id).conversationId, a);
  writeFileSync(transcript, 'saved history');
  report('Stop', { conversationId: a, transcriptPath: transcript, terminationReason: 'NO_TOOL_CALL', fullyIdle: true });
  assert.equal(saved().hasTranscript, true);
  // /clear, /resume, or a saved conversation that no longer exists.
  report('PreInvocation', { conversationId: b, transcriptPath: transcript });
  assert.equal(store.get(task.id).conversationId, b);
  report('Stop', { conversationId: a, transcriptPath: transcript });
  assert.equal(report('PreInvocation', { conversationId: '../../data' }), '{}\n');
  report('PreInvocation', { conversationId: a }, task.id, 'wrong-launch');
  assert.equal(store.get(task.id).conversationId, b);
  // agy started by hand inside another provider's terminal, or in no session.
  const other = 'agent-homeassistant-claude';
  store.ensure('claude', 'homeassistant', other, 'exec sleep 120');
  report('PreInvocation', { conversationId: a }, other, launchToken(other));
  assert.equal(store.get(other).conversationId, undefined);
  assert.equal(report('Stop', { conversationId: a }, '', ''), '{}\n');
  store.stop(task.id); store.start(task.id);
  createSessionStore(paths).ensure('antigravity', 'homeassistant', task.id, 'exec sleep 120');
  assert.equal(run('show-environment', '-t', '=' + task.id, 'AGENT_CONVERSATION_ID'), 'AGENT_CONVERSATION_ID=' + b);
});

// The CLI is not pinned, so this is what notices a release that changes its
// hooks or its resume flag. It uses an API key against a local stand-in for
// the Gemini API: no account, and no request to a real model.
test('the real Antigravity CLI names its conversation to the hook and reopens it by ID', {
  skip: spawnSync('agy', ['--version']).status !== 0 && 'agy is not installed, or cannot run on this processor', timeout: 240000,
}, async t => {
  const { store, run, root } = fixture(t);
  const home = join(root, 'home'), data = join(root, 'antigravity'), work = join(root, 'work');
  mkdirSync(home); mkdirSync(work);
  const adapter = new URL('../agent-terminal/rootfs/opt/agents/antigravity.sh', import.meta.url).pathname;
  const hook = new URL('../agent-terminal/rootfs/opt/agent-terminal/session-hook.mjs', import.meta.url).pathname;
  execFileSync('bash', ['-euo', 'pipefail', '-c', '. "$1"; AGENT_DATA="$2"; ANTIGRAVITY_HOME="$3"; agent_init', 'bash', adapter, data, home]);
  const hooks = join(data, '.gemini/config/hooks.json');
  writeFileSync(hooks, readFileSync(hooks, 'utf8').replaceAll('/opt/agent-terminal/session-hook.mjs', hook));
  mkdirSync(join(data, '.gemini/antigravity-cli'));
  writeFileSync(join(data, '.gemini/antigravity-cli/settings.json'), JSON.stringify({ modelProvider: 'gemini', enableTelemetry: false }));
  const reply = { candidates: [{ content: { role: 'model', parts: [{ text: 'Hello.' }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } };
  const model = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.url.includes('streamGenerateContent')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: ' + JSON.stringify(reply) + '\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(request.method === 'GET' ? { models: [] } : reply));
      }
    });
  }).listen(0, '127.0.0.1');
  await once(model, 'listening');
  t.after(() => model.close());

  const task = store.create({ name: 'Google task', agent: 'antigravity', workspace: 'homeassistant' });
  store.ensure('antigravity', 'homeassistant', task.id, 'exec sleep 300');
  const token = run('show-environment', '-t', '=' + task.id, 'AGENT_TERMINAL_LAUNCH_ID').split('=')[1];
  const agy = async (...args) => {
    const { stdout } = await promisify(execFile)('agy', [...args, '--print', 'Say hello', '--print-timeout', '100s', '--output-format', 'json'], {
      cwd: work, timeout: 110000,
      env: { PATH: process.env.PATH, HOME: home, AGY_CLI_DISABLE_AUTO_UPDATE: 'true', GEMINI_API_KEY: 'test-key',
        GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:' + model.address().port,
        AGENT_TERMINAL_STATE_DIR: root, AGENT_TERMINAL_SESSION_ID: task.id, AGENT_TERMINAL_LAUNCH_ID: token },
    });
    return JSON.parse(stdout.trim().split('\n').at(-1));
  };
  const first = await agy();
  assert.equal(first.status, 'SUCCESS');
  assert.match(first.conversation_id, /^[a-f0-9-]{36}$/);
  assert.equal(store.get(task.id).conversationId, first.conversation_id, 'the hook saved the conversation the CLI created');
  assert.equal(JSON.parse(readFileSync(join(root, 'conversations', task.id + '.json'))).hasTranscript, true);
  const again = await agy('--conversation', first.conversation_id);
  assert.equal(again.conversation_id, first.conversation_id, 'the launcher\'s flag reopens that conversation');
  assert.equal(again.num_turns, 2);
  const replaced = await agy('--conversation', '00000000-0000-4000-8000-000000000000');
  assert.notEqual(replaced.conversation_id, first.conversation_id, 'a conversation that is gone starts a new one');
  assert.equal(store.get(task.id).conversationId, replaced.conversation_id, 'and the session follows it');
});


test('the real Grok CLI records and resumes only its named terminal conversation', {
  skip: spawnSync('grok', ['--version']).status !== 0 && 'Grok CLI not installed', timeout: 180000,
}, async t => {
  const { store, run, root } = fixture(t);
  const home = join(root, 'home'), data = join(root, 'grok'), work = join(root, 'work');
  mkdirSync(home); mkdirSync(work);
  const adapter = new URL('../agent-terminal/rootfs/opt/agents/grok.sh', import.meta.url).pathname;
  const hook = new URL('../agent-terminal/rootfs/opt/agent-terminal/session-hook.mjs', import.meta.url).pathname;
  execFileSync('bash', ['-euo', 'pipefail', '-c', '. "$1"; AGENT_DATA="$2"; GROK_DEFAULT_HOME="$3"; agent_init', 'bash', adapter, data, home]);
  const hooks = join(data, 'hooks/agent-terminal.json');
  writeFileSync(hooks, readFileSync(hooks, 'utf8').replaceAll('/opt/agent-terminal/session-hook.mjs', hook));
  const requests = [];
  const model = createServer((request, response) => {
    let text = ''; request.on('data', chunk => { text += chunk; });
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET') { response.end(JSON.stringify({ data: [{ id: 'local-test' }] })); return; }
      const body = JSON.parse(text || '{}'); requests.push(body);
      const reply = { id: 'test-completion', object: 'chat.completion', created: 1, model: 'local-test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } };
      if (body.stream) {
        response.setHeader('content-type', 'text/event-stream');
        response.end('data: ' + JSON.stringify({ ...reply, object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      } else response.end(JSON.stringify(reply));
    });
  }).listen(0, '127.0.0.1');
  await once(model, 'listening'); t.after(() => model.close());
  const url = 'http://127.0.0.1:' + model.address().port + '/v1';
  writeFileSync(join(data, 'config.toml'), '[cli]\nauto_update=false\n[features]\ntelemetry=false\nfeedback=false\ncodebase_indexing=false\n' +
    '[models]\ndefault="local-test"\nsession_summary="local-test"\n[model.local-test]\nmodel="local-test"\nbase_url=' + JSON.stringify(url) + '\napi_key="test-key"\ncontext_window=10000\n');
  const task = store.create({ name: 'Grok task', agent: 'grok', workspace: 'homeassistant' });
  store.ensure('grok', 'homeassistant', task.id, 'exec sleep 300');
  const launch = run('show-environment', '-t', '=' + task.id, 'AGENT_TERMINAL_LAUNCH_ID').split('=')[1];
  const env = { PATH: process.env.PATH, HOME: home, GROK_HOME: data, GROK_DISABLE_AUTOUPDATER: '1',
    XAI_API_KEY: 'test-key', GROK_CLI_CHAT_PROXY_BASE_URL: url, GROK_MODELS_BASE_URL: url,
    GROK_TELEMETRY_ENABLED: '0', GROK_FEEDBACK_ENABLED: '0',
    AGENT_TERMINAL_STATE_DIR: root, AGENT_TERMINAL_SESSION_ID: task.id, AGENT_TERMINAL_LAUNCH_ID: launch };
  const grok = async (...args) => {
    const { stdout } = await promisify(execFile)('grok', [...args, '--model', 'local-test', '--no-subagents', '--disable-web-search',
      '--max-turns', '1', '-p', 'Say hello', '--output-format', 'json'], { cwd: work, env, timeout: 60000 });
    return JSON.parse(stdout);
  };
  const first = await grok();
  assert.equal(first.text, 'Hello.');
  assert.equal(store.get(task.id).conversationId, first.sessionId, 'global hook recorded the actual ID');
  const saved = JSON.parse(readFileSync(join(root, 'conversations', task.id + '.json'), 'utf8'));
  assert.equal(saved.hasTranscript, true);
  const resumed = await grok('--resume', first.sessionId);
  assert.equal(resumed.sessionId, first.sessionId);
  assert.equal(store.get(task.id).conversationId, first.sessionId);
  assert.ok(requests.some(body => body.messages?.filter(m => m.role === 'user').length >= 2), 'resume sends previous messages');

  const child = join(root, 'child'); mkdirSync(child);
  writeFileSync(join(child, 'summary.json'), JSON.stringify({ session_kind: 'subagent' }));
  const report = (sessionId, transcriptPath, token = launch) => execFileSync(process.execPath, [hook, 'grok', 'SessionStart'], {
    input: JSON.stringify({ hookEventName: 'session_start', sessionId, transcriptPath, source: 'new' }),
    env: { ...env, AGENT_TERMINAL_LAUNCH_ID: token }, encoding: 'utf8',
  });
  const switched = '550e8400-e29b-41d4-a716-446655440000';
  assert.equal(report(switched, join(child, 'updates.jsonl')), '', 'hook output cannot alter Grok behavior');
  assert.equal(store.get(task.id).conversationId, first.sessionId, 'subagents cannot redirect the terminal');
  report(switched, saved.transcript, '00000000-0000-4000-8000-000000000000');
  assert.equal(store.get(task.id).conversationId, first.sessionId, 'stale launches cannot redirect the terminal');
  report(switched, saved.transcript);
  assert.equal(store.get(task.id).conversationId, switched, '/new or /load follows the selected top-level conversation');
  const reopened = createSessionStore({ stateDir: root, optionsPath: join(root, 'options.json'), homeDirectory: root, tmux: join(root, 'tmux') });
  reopened.stop(task.id); reopened.start(task.id);
  reopened.ensure('grok', 'homeassistant', task.id, 'exec sleep 120');
  assert.equal(run('show-environment', '-t', '=' + task.id, 'AGENT_CONVERSATION_ID'), 'AGENT_CONVERSATION_ID=' + switched,
    'a restarted store launches the saved conversation');
});

test('provider launchers resume only their assigned conversation and preserve argument boundaries', t => {
  const root = mkdtempSync(join(tmpdir(), 'resume-adapters-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'args');
  for (const agent of ['codex', 'claude']) {
    writeFileSync(join(root, agent), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE_ARGS"\n', { mode: 0o755 });
    const adapter = new URL('../agent-terminal/rootfs/opt/agents/' + agent + '.sh', import.meta.url).pathname;
    const invoke = extra => {
      execFileSync('bash', ['-c', '. "$1"; agent_run', 'bash', adapter], {
        env: { PATH: root + ':' + process.env.PATH, CAPTURE_ARGS: output, ...extra },
      });
      return readFileSync(output, 'utf8').trim().split('\n');
    };
    const id = '550e8400-e29b-41d4-a716-446655440000';
    if (agent === 'codex') {
      assert.deepEqual(invoke({}), ['--no-daemon']);
      assert.deepEqual(invoke({ AGENT_CONVERSATION_ID: id }), ['--no-daemon', 'resume', id]);
    } else {
      const settings = ['--settings', '/opt/agent-terminal/claude-session-hooks.json'];
      assert.deepEqual(invoke({}), settings);
      assert.deepEqual(invoke({ AGENT_CONVERSATION_ID: id }), [...settings, '--resume', id]);
      const transcript = join(root, 'empty conversation.jsonl');
      assert.deepEqual(invoke({ AGENT_CONVERSATION_ID: id, AGENT_CONVERSATION_TRANSCRIPT: transcript }), [...settings, '--session-id', id]);
      assert.deepEqual(invoke({ AGENT_CONVERSATION_ID: id, AGENT_CONVERSATION_TRANSCRIPT: transcript, AGENT_CONVERSATION_SAVED: 'true' }), [...settings, '--resume', id], 'a previously saved transcript must not silently reset');
      writeFileSync(transcript, 'history');
      assert.deepEqual(invoke({ AGENT_CONVERSATION_ID: id, AGENT_CONVERSATION_TRANSCRIPT: transcript }), [...settings, '--resume', id]);
    }
  }
});

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
  assert.equal(store.list().length, 6, 'a corrupt named session does not hide the built-in providers');
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

test('async controls preserve request numbers, bound pending work, and ignore results after disconnect', async t => {
  const input = new PassThrough(), output = new PassThrough();
  t.after(() => input.destroy());
  const waiting = new Map(), packets = [];
  output.on('data', bytes => packets.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const store = { snapshot: () => ({ sessions: [] }), request: input =>
    new Promise((resolve, reject) => waiting.set(input.request, { resolve, reject })) };
  serve(store, input, output);
  for (let request = 1; request <= 5; request++) input.write(JSON.stringify({ request, method: 'remote/status' }) + '\n');
  assert.equal(waiting.size, 4);
  assert.match(packets.find(p => p.request === 5).error, /busy/);
  waiting.get(2).resolve({ enabled: true, status: 'connected' });
  waiting.get(1).reject(new Error('Remote disconnected.'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(packets.find(p => p.request === 2).result.status, 'connected');
  assert.match(packets.find(p => p.request === 1).error, /disconnected/);
  input.destroy();
  await new Promise(resolve => setImmediate(resolve));
  const count = packets.length;
  waiting.get(3).resolve({ manualPairingCode: 'private-code' });
  waiting.get(4).reject(new Error('closed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(packets.length, count);
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
