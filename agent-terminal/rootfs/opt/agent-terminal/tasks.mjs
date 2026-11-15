// Durable work records are separate from terminal lifecycle and provider files.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const TASK_STATES = ['open', 'in_progress', 'needs_you', 'review', 'done', 'archived'];
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b-\x1f\x7f]/.test(value) || required && !value.trim()) throw new Error('Invalid task text.');
  return value.trim();
}
export function readConversation(saved) {
  if (!saved?.transcript || !['claude', 'codex', 'ollama'].includes(saved.agent)) return { messages: [], notice: 'Open the terminal to view this provider’s conversation.' };
  let fd;
  try {
    fd = openSync(saved.transcript, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Not a transcript');
    const size = Math.min(stat.size, 256 * 1024), data = Buffer.alloc(size);
    readSync(fd, data, 0, size, stat.size - size);
    const lines = data.toString('utf8').split('\n');
    if (stat.size > size) lines.shift();
    const messages = [];
    for (const line of lines) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      let message;
      if (saved.agent === 'claude' && ['user', 'assistant'].includes(row.type) && !row.isMeta) message = row.message;
      if (saved.agent !== 'claude' && row.type === 'response_item' && row.payload?.type === 'message') message = row.payload;
      if (!message || message.channel === 'analysis' || !['user', 'assistant'].includes(message.role)) continue;
      const content = typeof message.content === 'string' ? message.content : (message.content || []).filter(p => ['text', 'input_text', 'output_text'].includes(p.type)).map(p => p.text || '').join('\n');
      if (content.trim()) messages.push({ role: message.role, text: content.slice(0, 3000), at: row.timestamp || null });
    }
    // Only user/assistant text; never reasoning, tool calls, or raw terminal output.
    const recent = []; let bytes = 0;
    for (const message of messages.slice(-60).reverse()) { bytes += Buffer.byteLength(message.text); if (bytes > 12000) break; recent.unshift(message); }
    return { messages: recent, notice: 'Recent saved messages. Live output, approvals, attachments, and earlier history are available in the terminal.' };
  } catch { return { messages: [], notice: 'No saved messages available yet. Open the terminal to begin or inspect the conversation.' }; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function createTaskStore({ stateDir, sessions, conversation }) {
  const directory = join(stateDir, 'tasks'), path = join(directory, 'records.json');
  function read() {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw new Error('Task records could not be read.'); }
  }
  function get(id) { const task = read().find(t => t.id === id); if (!task) throw new Error('Unknown task.'); return task; }
  function change(operation) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const fd = openSync(join(directory, 'lock'), 'a', 0o600);
    try {
      execFileSync('flock', ['-x', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 5000 });
      const records = read(), before = JSON.stringify(records), result = operation(records);
      if (JSON.stringify(records) === before) return result;
      const temp = path + '.' + randomUUID() + '.tmp';
      writeFileSync(temp, JSON.stringify(records) + '\n', { mode: 0o600 }); renameSync(temp, path);
      return result;
    } finally { closeSync(fd); }
  }
  function existingTasks() {
    // The task view is also an entry point to work started in the terminal.
    // Reconcile under the same lock as edits/creation so concurrent browsers
    // cannot import the same session twice. All statuses count as linked,
    // including archived tasks, and imported metadata is never refreshed over
    // edits the user has made in Tasks.
    return change(records => {
      const linked = new Set(records.flatMap(task => task.sessions));
      for (const session of sessions.list()) {
        if (records.length >= 1000) break;
        if (linked.has(session.id)) continue;
        if (!session.id.startsWith('session-') && session.name === 'Main' &&
            !session.description && !session.running && !session.conversationId && !session.stopped) continue;
        records.push({ id: randomUUID(),
          title: session.name === 'Main' ? `General session · ${session.agent}` : session.name,
          caseName: '', summary: session.description || '', workspace: session.workspace,
          status: 'open', sessions: [session.id], notes: [], revision: 1,
          createdAt: Date.now(), updatedAt: Date.now() });
        linked.add(session.id);
      }
      return records;
    });
  }
  function reconcileThreads(threads, workspaces) {
    return change(records => {
      const registered = sessions.list();
      for (const row of threads) {
        if (!row || !['codex', 'claude', 'ollama'].includes(row.provider) || typeof row.id !== 'string') continue;
        let task = records.find(t => (t.threads || []).some(r => r.id === row.id && r.provider === row.provider));
        if (task) continue;
        task = records.find(t => t.sessions.some(id => registered.some(s => s.id === id && s.agent === row.provider && s.conversationId === row.id)));
        const ref = { provider: row.provider, id: row.id, cwd: row.cwd };
        if (task) {
          task.threads ||= []; task.threads.push(ref); task.project ||= row.cwd;
          if (task.revision === 1 && task.title.startsWith('General session')) task.title = text(row.title.slice(0, 80) || 'Conversation', 80, true);
          task.revision++;
        } else if (records.length < 1000) {
          records.push({ id: randomUUID(), title: text((row.title || 'Conversation').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80), 80, true),
            caseName: '', summary: '', project: row.cwd, workspace: workspaces.find(w => w.directory === row.cwd)?.id || 'homeassistant',
            status: row.archived ? 'archived' : 'open', threads: [ref], sessions: [], notes: [], revision: 1,
            createdAt: row.createdAt || Date.now(), updatedAt: row.updatedAt || Date.now() });
        }
      }
      return records;
    });
  }
  function newConversation(row, input) {
    return change(records => {
      if (records.length >= 1000) throw new Error('Task limit reached (1000).');
      const task = { id: randomUUID(), ...validateNew(input), project: row.cwd, workspace: input.workspace,
        status: 'open', threads: [{ provider: row.provider, id: row.id, cwd: row.cwd }], sessions: [], notes: [], revision: 1, createdAt: Date.now(), updatedAt: Date.now() };
      records.push(task); return task;
    });
  }
  function linkThread(taskId, row) { return change(records => {
    const task = records.find(t => t.id === taskId); if (!task) throw new Error('Unknown task.');
    task.threads ||= []; if (!task.threads.some(r => r.id === row.id && r.provider === row.provider)) task.threads.push({ provider: row.provider, id: row.id, cwd: row.cwd });
    task.revision++; task.updatedAt = Date.now(); return task;
  }); }
  function validateNew(input) { return { title: text(input.title, 80, true), caseName: text(input.caseName || '', 80), summary: text(input.summary || '', 2000) }; }
  function linkSession(taskId, sessionId) { return change(records => { const task = records.find(t => t.id === taskId); if (!task) throw new Error('Unknown task.'); sessions.get(sessionId); if (!task.sessions.includes(sessionId)) { task.sessions.push(sessionId); task.revision++; } return task; }); }
  function request(input) {
    if (input.method === 'tasks.list') return existingTasks().map(({ notes, sessions: linked, ...task }) => ({ ...task, summary: task.summary.slice(0, 160), sessionCount: linked.length, noteCount: notes.length }));
    if (input.method === 'tasks.get') {
      const task = get(input.task);
      return { ...task, notes: task.notes.slice(-20), conversations: task.sessions.map(id => {
        try { const session = sessions.get(id); return { session, ...readConversation(conversation(id)) }; }
        catch { return { session: { id, name: 'Session removed' }, messages: [], notice: 'Task notes are preserved. Link another session to continue.' }; }
      }) };
    }
    return change(records => {
      if (input.method === 'tasks.create') {
        if (records.length >= 1000) throw new Error('Task limit reached (1000).');
        const title = text(input.title, 80, true), caseName = text(input.caseName || '', 80), summary = text(input.summary || '', 2000);
        // Validate all task fields before creating a terminal registration.
        const session = input.session ? sessions.get(input.session) : sessions.create({ name: title, agent: input.agent, workspace: input.workspace });
        const task = { id: randomUUID(), title, caseName, summary, workspace: session.workspace, status: 'open', sessions: [session.id], notes: [], revision: 1, createdAt: Date.now(), updatedAt: Date.now() };
        records.push(task); return task;
      }
      const task = records.find(t => t.id === input.task);
      if (!task) throw new Error('Unknown task.');
      if (input.revision !== task.revision) throw new Error('This task changed in another window. Reload it before saving.');
      if (input.method === 'tasks.update') {
        const title = text(input.title, 80, true), caseName = text(input.caseName || '', 80), summary = text(input.summary || '', 2000);
        if (!TASK_STATES.includes(input.status)) throw new Error('Invalid task status.');
        Object.assign(task, { title, caseName, summary, status: input.status });
      } else if (input.method === 'tasks.note') {
        const body = text(input.text, 4000, true);
        if (task.notes.length >= 100) throw new Error('Note limit reached (100).');
        task.notes.push({ id: randomUUID(), text: body, at: Date.now() });
      } else if (input.method === 'tasks.link') {
        const session = sessions.get(input.session);
        if (session.workspace !== task.workspace) throw new Error('Choose a session from this task’s workspace.');
        if (!task.sessions.includes(session.id)) {
          if (task.sessions.length >= 20) throw new Error('Session limit reached (20).');
          task.sessions.push(session.id);
        }
      } else throw new Error('Unknown task operation.');
      task.revision++; task.updatedAt = Date.now(); return task;
    });
  }
  return { request, get, reconcileThreads, newConversation, validateNew, linkSession, linkThread };
}
