import test from 'node:test';
const controlRoot = process.env.AGENT_TERMINAL_TEST_CONTAINER === '1' ? new URL('file:///opt/agent-terminal/') : new URL('../agent-terminal/rootfs/opt/agent-terminal/', import.meta.url);
const { createWorkService } = await import(new URL('work-service.mjs', controlRoot));
const { createCodexProvider, createClaudeProvider, codexItem } = await import(new URL('work-providers.mjs', controlRoot));
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';


import { fakeWorkProvider } from './helpers/workspace-provider.mjs';
const id = '550e8400-e29b-41d4-a716-446655440040';
const other = '550e8400-e29b-41d4-a716-446655440041';
function root(t) { const path = mkdtempSync(join(tmpdir(), 'workspace-test-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }

test('workspace sends once, isolates conversations and validates attachments and previews', async t => {
  const path = root(t), provider = fakeWorkProvider();
  const service = createWorkService({ stateDir: path, runtime: path, providers: { codex: provider }, workspaces: { get() { return { directory: path }; } } });
  const row = await service.request({ method: 'create', provider: 'codex', workspace: 'test' });
  const message = { method: 'send', provider: 'codex', thread: row.id, messageId: other, text: 'Work on this' };
  await Promise.all([service.request(message), service.request(message)]);
  assert.equal(provider.calls.filter(c => c.method === 'send').length, 1);
  assert.equal(provider.calls[0].id, row.id);
  await assert.rejects(service.request({ ...message, messageId: 'invalid' }), /identifier/);
  await assert.rejects(service.request({ ...message, messageId: id, attachments: ['/etc/passwd'] }));
  const file = join(path, 'result.txt'); writeFileSync(file, 'result');
  assert.equal((await service.request({ method: 'file', provider: 'codex', thread: row.id, path: file })).text, 'result');
  symlinkSync('/etc/passwd', join(path, 'escape'));
  await assert.rejects(service.request({ method: 'file', provider: 'codex', thread: row.id, path: 'escape' }), /within/);
  await service.close();
});

test('native requests are bound to their conversation and approvals are never implicit', async t => {
  const path = root(t), calls = [], responses = []; let callbacks;
  const rpc = { closed: false, dispose() {}, respond(id, value) { responses.push({ id, value }); }, async call(method, params) {
    calls.push({ method, params });
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/start') return { turn: { id: other } };
    if (method === 'thread/list') return { data: [], nextCursor: null };
    return {};
  } };
  const provider = createCodexProvider({ runtime: path, home: path, sharedSocket: null, connect: async (_, options) => { callbacks = options; return rpc; } });
  await provider.list();
  callbacks.onRequest({ id: 'request', method: 'item/commandExecution/requestApproval', params: { threadId: id, command: 'echo test' } });
  assert.equal(responses.length, 0);
  await assert.rejects(provider.respond(other, 'request', { decision: 'accept' }), /expired/);
  await assert.rejects(provider.send(id, 'message', other), /pending/);
  await provider.respond(id, 'request', { decision: 'decline' });
  assert.deepEqual(responses, [{ id: 'request', value: { decision: 'decline' } }]);
  await assert.rejects(provider.respond(id, 'request', { decision: 'accept' }), /expired/);
  callbacks.onRequest({ id: 'question', method: 'item/tool/requestUserInput', params: { threadId: id, questions: [{ id: 'choice', question: 'Which?' }] } });
  await assert.rejects(provider.respond(id, 'question', { answers: {} }), /each question/);
  await provider.respond(id, 'question', { answers: { choice: 'First' } });
  assert.deepEqual(responses.at(-1).value, { answers: { choice: { answers: ['First'] } } });
  await provider.send(id, 'message', other);
  assert.deepEqual(calls.find(c => c.method === 'turn/start').params.input, [{ type: 'text', text: 'message', text_elements: [] }]);
  assert.equal(calls.some(c => c.params?.approvalPolicy || c.params?.sandboxPolicy), false, 'transport does not relax permissions');
  assert.equal(codexItem({ type: 'reasoning', content: ['hidden'] }), null);
  callbacks.onRequest({ id: 'stale', method: 'item/commandExecution/requestApproval', params: { threadId: id } });
  rpc.closed = true;
  await assert.rejects(provider.respond(id, 'stale', { decision: 'accept' }), /expired/);
  assert.equal(responses.some(r => r.id === 'stale'), false);
  await provider.close();
});

test('Claude structured chat keeps permission requests pending until the user responds', async t => {
  const path = root(t); let permission, received, finished;
  const complete = new Promise(r => { finished = r; });
  const sdk = {
    async listSessions() { return [{ sessionId: id, summary: 'Saved Claude work', cwd: path, lastModified: 1 }]; },
    async getSessionInfo() { return { sessionId: id, summary: 'Saved Claude work', cwd: path, lastModified: 1 }; },
    async getSessionMessages() { return []; },
    query({ prompt, options }) {
      assert.deepEqual(options.settingSources, ['user', 'project', 'local']); assert.equal(options.permissionMode, undefined);
      async function* run() {
        const user = await prompt[Symbol.asyncIterator]().next(); received = user.value;
        permission = options.canUseTool('Bash', { command: 'echo test' }, { signal: new AbortController().signal });
        const answer = await permission;
        assert.equal(answer.behavior, 'deny');
        yield { type: 'assistant', uuid: other, message: { content: [{ type: 'text', text: 'Understood.' }] } };
        yield { type: 'result', is_error: false }; finished();
      }
      const generator = run(); generator.close = () => {}; generator.interrupt = async () => {}; return generator;
    },
  };
  const provider = createClaudeProvider({ sdk, home: path });
  await provider.list(); await provider.send(id, 'A user message', other);
  for (let n = 0; n < 50 && !provider.pending(id).length; n++) await new Promise(r => setTimeout(r, 5));
  assert.equal(received.message.content, 'A user message');
  const pending = provider.pending(id)[0]; assert.equal(pending.title, 'Bash');
  await assert.rejects(provider.respond(other, pending.id, { decision: 'accept' }), /expired/);
  await provider.respond(id, pending.id, { decision: 'decline' }); await complete;
  await provider.close();
});
