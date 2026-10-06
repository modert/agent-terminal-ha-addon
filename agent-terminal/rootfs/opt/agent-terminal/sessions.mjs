// Named terminals and their lifecycle. The management stream travels through
// ttyd's authenticated Ingress connection; it never accepts commands or paths.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
  renameSync, unlinkSync, openSync, closeSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createWorkspaceStore } from './workspaces.mjs';
import { requestRemote } from './remote-client.mjs';

const ID = /^(?:session-[a-f0-9]{32}|agent-[a-z][a-z0-9_-]{0,39}-(?:claude|codex|shell|custom))$/;
const NAMED = /^session-[a-f0-9]{32}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function createSessionStore({ stateDir = process.env.AGENT_TERMINAL_STATE_DIR || '/data/agent-terminal',
  optionsPath = '/data/options.json', tmux = 'tmux', ...paths } = {}) {
  const workspaces = createWorkspaceStore({ stateDir, optionsPath, ...paths });
  const registry = join(stateDir, 'sessions');
  const locks = join(stateDir, 'session-locks');
  // Separate from names/stop state: older control connections must not erase
  // a newly saved conversation when they rename a session during a hot deploy.
  const conversations = join(stateDir, 'conversations');
  function agents() {
    const result = [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'ChatGPT' }, { id: 'shell', name: 'Shell' }];
    if (JSON.parse(readFileSync(optionsPath, 'utf8')).web_command) result.push({ id: 'custom', name: 'Custom' });
    return result;
  }
  function validateID(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid session ID.');
    return id;
  }
  function name(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error('Session name must be 1–80 printable characters.');
    }
    return value.trim();
  }
  function description(value = '') {
    if (typeof value !== 'string' || value.length > 160 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error('Purpose must be at most 160 printable characters.');
    }
    return value.trim();
  }
  function pair(agent, workspace, existing = false) {
    if (!(existing && agent === 'custom') && !agents().some(a => a.id === agent)) throw new Error('Unknown agent.');
    workspaces.get(workspace);
    return { agent, workspace };
  }
  function get(id) {
    validateID(id);
    let record;
    const file = join(registry, id + '.json');
    if (existsSync(file)) record = JSON.parse(readFileSync(file, 'utf8'));
    else if (!NAMED.test(id)) {
      const match = /^agent-(.+)-(claude|codex|shell|custom)$/.exec(id);
      record = { id, name: 'Main', workspace: match[1], agent: match[2], stopped: false };
    } else throw new Error('Unknown session.');
    if (record.id !== id || typeof record.stopped !== 'boolean') throw new Error('Invalid session record.');
    const selection = pair(record.agent, record.workspace, true);
    if (!NAMED.test(id) && id !== `agent-${selection.workspace}-${selection.agent}`) throw new Error('Invalid session record.');
    const saved = conversation(id);
    return { id, name: name(record.name), description: description(record.description), ...selection, stopped: record.stopped,
      ...(saved?.conversationId ? { conversationId: saved.conversationId } : {}) };
  }
  function conversation(id) {
    const file = join(conversations, validateID(id) + '.json');
    if (!existsSync(file)) return null;
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (!['claude', 'codex'].includes(saved.agent) || !UUID.test(saved.launchId) ||
        (saved.conversationId !== undefined && !UUID.test(saved.conversationId)) ||
        (saved.transcript !== undefined && (typeof saved.transcript !== 'string' ||
          !saved.transcript.startsWith('/') || /[\x00-\x1f]/.test(saved.transcript)))) {
      throw new Error('Invalid saved conversation.');
    }
    return saved;
  }
  function saveConversation(id, value) {
    mkdirSync(conversations, { recursive: true, mode: 0o700 });
    const file = join(conversations, id + '.json');
    const temporary = file + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
    return value;
  }
  function remember(id, agent, launchId, event) {
    if (!event || !['SessionStart', 'Stop'].includes(event.hook_event_name) ||
        typeof event.session_id !== 'string' || !UUID.test(event.session_id)) return false;
    return locked(id, () => {
      // Late hooks from a stopped/deleted task or an earlier launch cannot
      // resurrect it or redirect the next launch to a different conversation.
      const record = get(id), saved = conversation(id);
      if (record.stopped || record.agent !== agent || saved?.agent !== agent || saved.launchId !== launchId) return false;
      if (event.hook_event_name === 'Stop' && saved.conversationId !== event.session_id) return false;
      if (saved.conversationId && saved.conversationId !== event.session_id &&
          !['resume', 'clear'].includes(event.source)) return false;
      const transcript = typeof event.transcript_path === 'string' && event.transcript_path.startsWith('/') &&
        !/[\x00-\x1f]/.test(event.transcript_path) ? event.transcript_path : undefined;
      const same = saved.conversationId === event.session_id;
      saveConversation(id, { agent, launchId, conversationId: event.session_id,
        ...(transcript ? { transcript } : {}),
        hasTranscript: !!(transcript && existsSync(transcript)) || (same && saved.hasTranscript === true) });
      return true;
    });
  }
  function failed(id, launchId) {
    return locked(id, () => {
      const record = get(id);
      if (conversation(id)?.launchId !== launchId) return false;
      save({ ...record, stopped: true });
      return true;
    });
  }
  function save(record) {
    mkdirSync(registry, { recursive: true, mode: 0o700 });
    const file = join(registry, record.id + '.json');
    const temporary = file + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
    return record;
  }
  function locked(id, operation) {
    validateID(id);
    mkdirSync(locks, { recursive: true, mode: 0o700 });
    const fd = openSync(join(locks, id), 'a', 0o600);
    try {
      // flock inherits the same open file description; our fd retains the
      // lock until close, including across the tmux call. Process exit also
      // releases it, so a crash cannot strand a lock file.
      execFileSync('flock', ['-x', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 5000 });
      return operation();
    } finally { closeSync(fd); }
  }
  const has = id => spawnSync(tmux, ['has-session', '-t', '=' + id], { stdio: 'ignore' }).status === 0;
  function list() {
    const ids = workspaces.list().flatMap(w => agents().map(a => `agent-${w.id}-${a.id}`));
    if (existsSync(registry)) for (const file of readdirSync(registry).sort()) {
      if (file.endsWith('.json') && NAMED.test(file.slice(0, -5))) ids.push(file.slice(0, -5));
    }
    const live = spawnSync(tmux, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
    const running = new Set((live.stdout || '').trim().split('\n'));
    return ids.flatMap(id => {
      try { const record = get(id); return [{ ...record, running: running.has(id) }]; }
      catch (error) { console.error(`agent-sessions: skipping ${id}: ${error.message}`); return []; }
    });
  }
  function create(input) {
    const record = { id: 'session-' + randomUUID().replaceAll('-', ''),
      name: name(input.name), description: description(input.description), ...pair(input.agent, input.workspace), stopped: false };
    return locked(record.id, () => save(record));
  }
  function rename(id, value, purpose) {
    const label = name(value);
    const note = purpose === undefined ? undefined : description(purpose);
    return locked(id, () => {
      const record = get(id);
      return save({ ...record, name: label, description: note === undefined ? record.description : note });
    });
  }
  // Call while holding the session lock. Save before detaching clients so
  // automatic reconnect cannot create a replacement process, even on error.
  function stopLocked(id) {
    const record = save({ ...get(id), stopped: true });
    if (has(id)) {
      const result = spawnSync(tmux, ['kill-session', '-t', '=' + id], { encoding: 'utf8' });
      if (result.status !== 0 && has(id)) throw new Error('Could not stop session.');
    }
    return record;
  }
  const stop = id => locked(id, () => stopLocked(id));
  function remove(id) {
    return locked(id, () => {
      if (!NAMED.test(id)) throw new Error('Built-in sessions cannot be deleted. Use Stop instead.');
      const record = stopLocked(id);
      unlinkSync(join(registry, id + '.json'));
      const saved = join(conversations, id + '.json');
      if (existsSync(saved)) unlinkSync(saved);
      // Keep the lock file: reconnects and other processes may still hold its
      // descriptor. Missing named records cannot be started or recreated.
      return record;
    });
  }
  const start = id => locked(id, () => save({ ...get(id), stopped: false }));
  function ensure(agent, workspace, id, command, environment = []) {
    id ||= `agent-${workspace}-${agent}`;
    return locked(id, () => {
      const record = get(id);
      if (record.agent !== agent || record.workspace !== workspace) throw new Error('Session does not match agent and workspace.');
      if (record.stopped) throw new Error('Session stopped. Choose Start in the session switcher.');
      if (!has(id)) {
        const launchEnv = [...environment, `AGENT_TERMINAL_STATE_DIR=${stateDir}`, 'AGENT_TERMINAL_SESSION_ID=', 'AGENT_TERMINAL_LAUNCH_ID=',
          'AGENT_CONVERSATION_ID=', 'AGENT_CONVERSATION_TRANSCRIPT=', 'AGENT_CONVERSATION_SAVED=false'];
        if (agent === 'claude' || agent === 'codex') {
          const saved = conversation(id);
          if (saved && saved.agent !== agent) throw new Error('Saved conversation belongs to a different agent.');
          const launch = saveConversation(id, { ...saved, agent, launchId: randomUUID() });
          launchEnv.push(`AGENT_TERMINAL_SESSION_ID=${id}`, `AGENT_TERMINAL_LAUNCH_ID=${launch.launchId}`,
            `AGENT_CONVERSATION_ID=${launch.conversationId || ''}`,
            `AGENT_CONVERSATION_TRANSCRIPT=${launch.transcript || ''}`,
            `AGENT_CONVERSATION_SAVED=${launch.hasTranscript === true ? 'true' : 'false'}`);
        }
        execFileSync(tmux, ['new-session', '-d', '-s', id, '-c', workspaces.get(workspace).directory,
          ...launchEnv.flatMap(value => ['-e', value]), command], { stdio: ['ignore', 'ignore', 'pipe'] });
      }
      return id;
    });
  }
  const snapshot = () => ({ sessions: list(), agents: agents(), workspaces: workspaces.list() });
  function request(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid request.');
    if (typeof input.method === 'string' && input.method.startsWith('remote/')) return requestRemote(input.method.slice(7));
    switch (input.method) {
      case 'list': return snapshot();
      case 'create': return create(input);
      case 'rename': return rename(input.session, input.name, input.description);
      case 'stop': return stop(input.session);
      case 'start': return start(input.session);
      case 'delete': return remove(input.session);
      default: throw new Error('Unknown session operation.');
    }
  }
  return { get, list, create, rename, stop, start, remove, ensure, remember, failed, snapshot, request };
}

export function serve(store, input = process.stdin, output = process.stdout) {
  if (input.isTTY) input.setRawMode(true);
  input.setEncoding('utf8');
  let buffer = '', last = '', closed = false, inFlight = 0;
  const send = value => { if (!closed) output.write(JSON.stringify(value) + '\n'); };
  function publish() {
    const snapshot = store.snapshot();
    const json = JSON.stringify(snapshot);
    if (last !== json) { last = json; send({ type: 'sessions', ...snapshot }); }
  }
  input.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 8192) { input.destroy(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let request;
      try {
        request = JSON.parse(line);
        if (!Number.isSafeInteger(request?.request) || request.request < 0) throw new Error('Invalid request number.');
        if (inFlight >= 4) throw new Error('Controls are busy. Try again in a moment.');
        const result = store.request(request);
        if (result && typeof result.then === 'function') {
          inFlight++;
          result.then(
            value => { send({ request: request.request, result: value }); if (!closed) publish(); },
            error => send({ request: request.request, error: error.message }),
          ).finally(() => { inFlight--; });
        }
        else { send({ request: request.request, result }); publish(); }
      } catch (error) {
        send({ request: Number.isSafeInteger(request?.request) ? request.request : null, error: error.message });
      }
    }
  });
  const timer = setInterval(() => { try { publish(); } catch { /* retry next tick */ } }, 2000);
  const end = () => { closed = true; clearInterval(timer); };
  input.on('end', end);
  input.on('close', end);
  publish();
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = createSessionStore();
  const [operation, ...args] = process.argv.slice(2);
  try {
    if (operation === 'serve' && !args.length) serve(store);
    else if (operation === 'get' && args.length === 1) console.log(JSON.stringify(store.get(args[0])));
    else if (operation === 'ensure' && args.length >= 4) console.log(store.ensure(...args.slice(0, 4), args.slice(4)));
    else if (operation === 'failed' && args.length === 2) store.failed(...args);
    else throw new Error('Usage: sessions.mjs serve | get ID | ensure AGENT WORKSPACE ID COMMAND [ENV ...]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
