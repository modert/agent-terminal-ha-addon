import { randomUUID } from 'node:crypto';
export function fakeWorkProvider() {
  const rows = new Map(), calls = [];
  const id = '550e8400-e29b-41d4-a716-446655440040';
  function seed(id, title) { const row = { provider: 'codex', id, title, cwd: '/homeassistant', updatedAt: Date.now(), createdAt: Date.now(), status: { type: 'idle' }, items: [{ id: 'hello-' + id, role: 'assistant', text: 'Existing saved conversation', type: 'agentMessage' }], approvals: [] }; rows.set(id, row); return row; }
  seed(id, 'Existing saved work');
  return { calls, rows, provider: 'codex',
    async list() { return [...rows.values()].map(({ items, approvals, ...r }) => r); },
    async create(cwd) { const row = seed(randomUUID(), 'New conversation'); row.cwd = cwd; return row; },
    async history(id, cursor) { const row = rows.get(id); if (!row) throw Error('Unknown conversation'); return { ...row, items: cursor ? [{ id: 'older', role: 'user', text: 'An older message', type: 'userMessage' }] : row.items, cursor: cursor ? null : 'older', approvals: row.approvals }; },
    async send(id, text, messageId) { calls.push({ method: 'send', id, text, messageId }); const row = rows.get(id); row.items.push({ id: messageId, role: 'user', text, type: 'userMessage' }); row.status = { type: 'active', activeFlags: ['waitingOnApproval'] }; row.approvals = [{ id: 'approval-1', threadId: id, method: 'item/commandExecution/requestApproval', command: 'echo fixture', reason: 'Test permission request' }]; return { accepted: true }; },
    async respond(id, requestId, answer) { calls.push({ method: 'respond', id, requestId, answer }); const row = rows.get(id); row.approvals = []; row.status = { type: 'idle' }; row.items.push({ id: randomUUID(), role: 'assistant', text: 'Completed after your approval.', type: 'agentMessage' }); return true; },
    async interrupt(id) { calls.push({ method: 'interrupt', id }); return true; },
    async inspect(id) { return { provider: 'codex', id, endpoint: '/tmp/test.sock' }; },
    async close() {},
  };
}
