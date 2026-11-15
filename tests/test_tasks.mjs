import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionStore } from '../agent-terminal/rootfs/opt/agent-terminal/sessions.mjs';
import { readConversation } from '../agent-terminal/rootfs/opt/agent-terminal/tasks.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'task-store-')), optionsPath = join(root, 'options.json');
  writeFileSync(optionsPath, '{"agent":"codex"}');
  const paths = { stateDir: root, optionsPath, homeDirectory: root, tmux: '/nonexistent-task-test-tmux' };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, paths, store: createSessionStore(paths) };
}
test('tasks persist independently, link conversations, and reject stale edits', t => {
  const { root, paths, store } = fixture(t);
  let task = store.request({ method: 'tasks.create', title: 'Investigate camera', caseName: 'Reliability', agent: 'codex', workspace: 'homeassistant' });
  assert.equal(task.status, 'open'); assert.equal(store.get(task.sessions[0]).name, task.title);
  const session = store.create({ name: 'Second opinion', agent: 'claude', workspace: 'homeassistant' });
  task = store.request({ method: 'tasks.link', task: task.id, revision: task.revision, session: session.id });
  assert.equal(task.sessions.length, 2);
  const old = task.revision;
  task = store.request({ method: 'tasks.note', task: task.id, revision: old, text: 'Checked configuration.' });
  assert.throws(() => store.request({ method: 'tasks.note', task: task.id, revision: old, text: 'Stale edit' }), /another window/);
  const restarted = createSessionStore(paths);
  assert.equal(restarted.request({ method: 'tasks.get', task: task.id }).notes[0].text, 'Checked configuration.');
  task = restarted.request({ method: 'tasks.update', task: task.id, revision: task.revision, title: task.title, summary: 'Ready to inspect', caseName: task.caseName, status: 'archived' });
  assert.equal(restarted.get(session.id).stopped, false, 'archiving does not terminate work');
  rmSync(join(root, 'sessions', session.id + '.json'));
  assert.equal(restarted.request({ method: 'tasks.get', task: task.id }).conversations[1].session.name, 'Session removed');
  assert.equal(restarted.request({ method: 'tasks.list' })[0].noteCount, 1);
});
test('invalid operations cannot alter records or create unwanted sessions', t => {
  const { root, store } = fixture(t);
  assert.throws(() => store.request({ method: 'tasks.create', title: '', agent: 'codex', workspace: 'homeassistant' }), /Invalid/);
  const task = store.request({ method: 'tasks.create', title: 'Task', session: 'agent-homeassistant-claude' });
  const before = readFileSync(join(root, 'tasks', 'records.json'), 'utf8');
  for (const input of [
    { method: 'tasks.update', title: 'Changed', status: 'invented' },
    { method: 'tasks.note', text: 'x'.repeat(4001) },
    { method: 'tasks.link', session: '../../private' },
    { method: 'tasks.execute', command: 'exit' },
  ]) assert.throws(() => store.request({ ...input, task: task.id, revision: task.revision }));
  assert.equal(readFileSync(join(root, 'tasks', 'records.json'), 'utf8'), before);
});
test('conversation reader returns bounded public messages and tolerates partial records', t => {
  const { root } = fixture(t), transcript = join(root, 'conversation.jsonl');
  const rows = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<script>untrusted</script>' }] } },
    { type: 'response_item', payload: { type: 'reasoning', content: [{ type: 'text', text: 'private reasoning' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Result' }] } },
  ];
  writeFileSync(transcript, rows.map(r => JSON.stringify(r)).join('\n') + '\n{"partial":');
  assert.deepEqual(readConversation({ agent: 'codex', transcript }).messages.map(m => m.text), ['<script>untrusted</script>', 'Result']);
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'Visible answer' }, { type: 'tool_use', input: 'private tool data' }] } }) + '\n');
  assert.deepEqual(readConversation({ agent: 'claude', transcript }).messages.map(m => m.text), ['Visible answer']);
  writeFileSync(transcript, Array(100).fill(JSON.stringify(rows[2]).replace('Result', 'X'.repeat(6000))).join('\n'));
  assert.ok(JSON.stringify(readConversation({ agent: 'codex', transcript })).length < 16000);
  assert.equal(readConversation({ agent: 'grok', transcript }).messages.length, 0);
});

test('opening Tasks imports existing work once and keeps user organization intact', t => {
  const { root, paths, store } = fixture(t);
  const named = store.create({ name: 'Existing investigation', description: 'Keep its purpose', agent: 'codex', workspace: 'homeassistant' });
  const stopped = store.create({ name: 'Paused investigation', agent: 'claude', workspace: 'homeassistant' });
  // Seed a stopped registration without invoking a tmux process.
  writeFileSync(join(root, 'sessions', stopped.id + '.json'), JSON.stringify({ ...stopped, stopped: true }));
  store.rename('agent-homeassistant-claude', 'Existing general work');
  const sessionBefore = readFileSync(join(root, 'sessions', named.id + '.json'), 'utf8');
  const tasks = store.request({ method: 'tasks.list' });
  assert.equal(tasks.length, 3, 'unused defaults are not imported');
  const imported = tasks.find(task => task.title === named.name);
  assert.equal(imported.summary, named.description);
  assert.deepEqual(store.request({ method: 'tasks.get', task: imported.id }).sessions, [named.id]);
  assert.equal(readFileSync(join(root, 'sessions', named.id + '.json'), 'utf8'), sessionBefore, 'import never changes terminal records');
  assert.equal(store.get(stopped.id).stopped, true);
  const archived = store.request({ method: 'tasks.update', task: imported.id, revision: imported.revision,
    title: 'Organized title', caseName: 'Existing case', summary: 'Edited summary', status: 'archived' });
  const before = readFileSync(join(root, 'tasks', 'records.json'), 'utf8');
  assert.equal(createSessionStore(paths).request({ method: 'tasks.list' }).length, 3);
  assert.equal(readFileSync(join(root, 'tasks', 'records.json'), 'utf8'), before, 'reload does not rewrite or duplicate imports');
  assert.equal(store.request({ method: 'tasks.get', task: archived.id }).status, 'archived');
  store.create({ name: 'Work started later in terminal', agent: 'grok', workspace: 'homeassistant' });
  assert.equal(store.request({ method: 'tasks.list' }).length, 4, 'later terminal work also appears');
});
