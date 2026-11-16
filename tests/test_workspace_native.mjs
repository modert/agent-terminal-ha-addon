import test from 'node:test';
const controlRoot = process.env.AGENT_TERMINAL_TEST_CONTAINER === '1' ? new URL('file:///opt/agent-terminal/') : new URL('../agent-terminal/rootfs/opt/agent-terminal/', import.meta.url);
const { createCodexProvider, createClaudeProvider } = await import(new URL('work-providers.mjs', controlRoot));
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const pause = ms => new Promise(r => setTimeout(r, ms));

test('native Codex chat sends and reads a persisted response through an isolated app-server', { timeout: 60000, skip: spawnSync('codex', ['--version']).status !== 0 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-codex-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { /* drain synthetic requests only */ }
    if (!req.url.endsWith('/responses')) { res.writeHead(404).end(); return; }
    requests++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const message = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Workspace native test response.', annotations: [] }] };
    const send = (type, fields) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n');
    send('response.created', { response: { id: 'resp_fixture', object: 'response', status: 'in_progress', output: [] } });
    send('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
    send('response.content_part.added', { item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    send('response.output_text.delta', { item_id: message.id, output_index: 0, content_index: 0, delta: message.content[0].text });
    send('response.output_text.done', { item_id: message.id, output_index: 0, content_index: 0, text: message.content[0].text });
    send('response.output_item.done', { output_index: 0, item: message });
    send('response.completed', { response: { id: 'resp_fixture', object: 'response', status: 'completed', output: [message], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  writeFileSync(join(root, 'config.toml'), `model = "fixture"\nmodel_provider = "fixture"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nenv_key = "WORKSPACE_FIXTURE_KEY"\n`);
  const provider = createCodexProvider({ home: root, runtime: join(root, 'runtime'), sharedSocket: null,
    spawnServer(command, args, options) { return spawn(command, args, { ...options, cwd: root, env: { ...options.env, WORKSPACE_FIXTURE_KEY: 'fixture' } }); } });
  t.after(() => provider.close());
  const thread = await provider.create(root); await provider.send(thread.id, 'Return the fixture response without tools.', randomUUID());
  let history;
  for (let i = 0; i < 200; i++) { await pause(100); history = await provider.history(thread.id); if (history.items.some(m => m.text === 'Workspace native test response.')) break; }
  assert.ok(history.items.some(m => m.role === 'assistant' && m.text === 'Workspace native test response.'), JSON.stringify({ turn: history.turn, status: history.status }));
  assert.equal(requests, 1);
  assert.ok((await provider.list()).some(row => row.id === thread.id));
  const endpoint = (await provider.inspect(thread.id)).endpoint;
  const resumed = createCodexProvider({ home: root, runtime: join(root, 'resume-client'), sharedSocket: endpoint });
  t.after(() => resumed.close());
  assert.ok((await resumed.history(thread.id)).items.some(m => m.text === 'Workspace native test response.'));
  await resumed.send(thread.id, 'Continue the existing conversation.', randomUUID());
  for (let i = 0; i < 200; i++) { await pause(100); history = await resumed.history(thread.id); if (requests === 2 && history.turn?.status === 'completed') break; }
  assert.equal(requests, 2);
  assert.ok(history.items.some(m => m.role === 'user' && m.text === 'Continue the existing conversation.'));
});

test('native Claude SDK chat keeps its own isolated session and receives a response', { timeout: 60000, skip: spawnSync('claude', ['--version']).status !== 0 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-claude-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const originalConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  t.after(() => { if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = originalConfig; });
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { /* drain synthetic requests */ }
    if (req.url.includes('count_tokens')) { res.setHeader('Content-Type','application/json'); res.end('{"input_tokens":10}'); return; }
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(404).end(); return; }
    requests++; res.writeHead(200, { 'Content-Type':'text/event-stream' });
    const send = (type, fields) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n');
    send('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    send('content_block_start', { index: 0, content_block: { type:'text', text:'' } });
    send('content_block_delta', { index: 0, delta: { type:'text_delta', text:'Claude workspace fixture response.' } });
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason:'end_turn', stop_sequence:null }, usage: { output_tokens:5 } }); send('message_stop', {}); res.end();
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening'); t.after(() => server.close());
  const sdk = await import(new URL('node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', controlRoot));
  const provider = createClaudeProvider({ home: root, sdk: { ...sdk, query({prompt,options}) { return sdk.query({ prompt, options: { ...options, settingSources: [], env: { ...options.env, ANTHROPIC_API_KEY:'fixture', ANTHROPIC_AUTH_TOKEN:'', ANTHROPIC_BASE_URL:'http://127.0.0.1:' + server.address().port, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1' } } }); } } });
  t.after(() => provider.close());
  const thread = await provider.create(root); await provider.send(thread.id, 'Return the fixture response without tools.', randomUUID());
  let history;
  for (let i=0;i<300;i++) { await pause(100); history=await provider.history(thread.id); if (history.items.some(m=>m.text==='Claude workspace fixture response.') || history.error) break; }
  assert.ok(history.items.some(m=>m.role==='assistant' && m.text==='Claude workspace fixture response.'), history.error || JSON.stringify(history.status));
  assert.ok(requests >= 1);
  await provider.close();
  await pause(500);
  const resumed = createClaudeProvider({ home: root, sdk: { ...sdk, query({prompt,options}) { return sdk.query({ prompt, options: { ...options, settingSources: [], env: { ...options.env, ANTHROPIC_API_KEY:'fixture', ANTHROPIC_AUTH_TOKEN:'', ANTHROPIC_BASE_URL:'http://127.0.0.1:' + server.address().port, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1' } } }); } } });
  t.after(() => resumed.close());
  assert.ok((await resumed.list()).some(row => row.id === thread.id));
  assert.ok((await resumed.history(thread.id)).items.some(m => m.text === 'Claude workspace fixture response.'));
  await resumed.send(thread.id, 'Continue the existing conversation.', randomUUID());
  for (let i = 0; i < 300; i++) { await pause(100); history = await resumed.history(thread.id); if (history.items.filter(m => m.role === 'assistant' && m.text === 'Claude workspace fixture response.').length >= 2 || history.error) break; }
  assert.ok(history.items.filter(m => m.role === 'assistant' && m.text === 'Claude workspace fixture response.').length >= 2, history.error || 'Existing conversation did not continue');
});
