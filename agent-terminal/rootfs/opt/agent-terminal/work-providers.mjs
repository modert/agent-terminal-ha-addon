// Provider-native chat transports. Never type messages into a hidden terminal.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { connectCodex } from './codex-rpc.mjs';
import { nativeCodex } from './remote.mjs';
import { remoteRuntimeDir } from './remote-client.mjs';

export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function validThread(id) { if (!UUID.test(id || '')) throw new Error('Invalid conversation ID.'); return id; }
const clip = (value, max = 16000) => String(value || '').slice(0, max);
export function codexItem(entry) {
  const i = entry.item || entry;
  if (i.type === 'reasoning' || i.type === 'hookPrompt') return null;
  const base = { id: i.id, type: i.type, at: entry.startedAtMs || i.startedAtMs || null };
  if (i.type === 'userMessage') return { ...base, role: 'user', text: clip((i.content || []).map(c => c.text || (c.path ? '[Attachment: ' + c.path + ']' : '')).join('\n')) };
  if (i.type === 'agentMessage' || i.type === 'plan') return { ...base, role: 'assistant', text: clip(i.text), questions: i.questions || [] };
  if (i.type === 'commandExecution') return { ...base, role: 'activity', title: clip(i.command, 500), text: clip(i.aggregatedOutput, 6000), status: i.status };
  if (i.type === 'fileChange') return { ...base, role: 'result', title: 'Changed files', status: i.status,
    files: (i.changes || []).slice(0, 8).map(c => ({ path: c.path, diff: clip(c.diff, 2000) })) };
  if (i.type === 'mcpToolCall' || i.type === 'dynamicToolCall') return { ...base, role: 'activity', title: [i.server, i.namespace, i.tool].filter(Boolean).join(' / '), status: i.status, text: clip(JSON.stringify(i.result || i.error || i.contentItems || ''), 6000) };
  return { ...base, role: 'activity', title: i.type, text: clip(i.text || i.review || '', 3000), status: i.status };
}
function threadMeta(t, provider) { return { provider, id: t.id, title: clip(t.name || t.preview || 'Untitled conversation', 160), cwd: t.cwd,
  updatedAt: t.updatedAt * 1000, createdAt: t.createdAt * 1000, status: t.status, model: t.model, archived: false }; }
export function createCodexProvider({ provider = 'codex', home, runtime, connect = connectCodex, spawnServer = spawn, command = nativeCodex, sharedSocket = provider === 'codex' ? join(remoteRuntimeDir(), 'app-server.sock') : null } = {}) {
  let rpc, starting, child, endpoint; const approvals = new Map(), attached = new Set(), live = new Map();
  function notification(message) {
    const p = message.params || {};
    if (message.method === 'serverRequest/resolved') approvals.delete(String(p.requestId));
    if (message.method === 'turn/completed') for (const [id, a] of approvals) if (a.params.threadId === p.threadId) approvals.delete(id);
    if (message.method === 'thread/status/changed') live.set(p.threadId, p.status);
  }
  function serverRequest(message) {
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'];
    if (supported.includes(message.method)) approvals.set(String(message.id), message);
    // Unsupported server tools are never executed or automatically approved.
    else if (message.method === 'item/tool/call') rpc?.respond(message.id, { contentItems: [{ type: 'inputText', text: 'This client does not provide dynamic tools.' }], success: false });
  }
  async function ensure() {
    if (rpc && !rpc.closed) return rpc;
    if (starting) return starting;
    starting = (async () => {
      approvals.clear(); attached.clear(); live.clear();
      const options = { onNotification: notification, onRequest: serverRequest, timeout: 30000 };
      if (sharedSocket && existsSync(sharedSocket)) {
        try { rpc = await connect(sharedSocket, options); endpoint = sharedSocket; return rpc; } catch {}
      }
      mkdirSync(runtime, { recursive: true, mode: 0o700 }); endpoint = join(runtime, provider + '.sock');
      // Recover our surviving local server before starting another one.
      try { rpc = await connect(endpoint, options); return rpc; } catch {}
      child = spawnServer(typeof command === 'function' ? command() : command, ['app-server', '--listen', 'unix://' + endpoint], {
        cwd: '/homeassistant', env: { ...process.env, CODEX_HOME: home, AGENT_TERMINAL_SESSION_ID: '', AGENT_TERMINAL_LAUNCH_ID: '', AGENT_CONVERSATION_ID: '' }, stdio: ['ignore', 'ignore', 'pipe'],
      });
      let exited = false; child.on('error', () => { exited = true; }); child.on('exit', () => { exited = true; }); child.stderr?.on('data', () => {});
      for (let n = 0; n < 80 && !exited; n++) {
        try { rpc = await connect(endpoint, options); return rpc; } catch { await new Promise(r => setTimeout(r, 100)); }
      }
      throw new Error(provider + ' chat server could not start. Inspect the terminal or provider login.');
    })().finally(() => { starting = null; });
    return starting;
  }
  async function attach(id) {
    validThread(id); const client = await ensure();
    if (!attached.has(id)) { await client.call('thread/resume', { threadId: id, excludeTurns: true }); attached.add(id); }
    return client;
  }
  async function list() {
    const client = await ensure(), threads = []; let cursor = null;
    for (let page = 0; page < 10; page++) {
      const result = await client.call('thread/list', { limit: 100, cursor, sortKey: 'updated_at', modelProviders: [], useStateDbOnly: true });
      threads.push(...result.data.filter(t => !t.parentThreadId).map(t => threadMeta(t, provider))); cursor = result.nextCursor; if (!cursor) break;
    }
    return threads;
  }
  async function history(id, cursor = null) {
    validThread(id); const client = await ensure();
    const meta = await client.call('thread/read', { threadId: id });
    // Read-only browsing never takes a conversation away from another client.
    const page = await client.call('thread/items/list', { threadId: id, sortDirection: 'desc', limit: 20, ...(cursor ? { cursor } : {}) });
    const turns = await client.call('thread/turns/list', { threadId: id, sortDirection: 'desc', limit: 1 });
    return { ...threadMeta(meta.thread, provider), items: page.data.map(codexItem).filter(Boolean).reverse(), cursor: page.nextCursor,
      turn: turns.data[0] ? { id: turns.data[0].id, status: turns.data[0].status, error: turns.data[0].error?.message } : null,
      status: live.get(id) || meta.thread.status, approvals: pending(id) };
  }
  function pending(id) { return [...approvals.values()].filter(a => a.params.threadId === id).map(a => ({ id: String(a.id), method: a.method, ...a.params })); }
  async function respond(id, requestId, answer) {
    const client = await ensure();
    const a = approvals.get(String(requestId)); if (!a || a.params.threadId !== id) throw new Error('This request has already been answered or expired.');
    let result;
    if (a.method === 'item/tool/requestUserInput') {
      const answers = {};
      for (const q of a.params.questions) { const value = answer.answers?.[q.id]; if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new Error('Answer each question.'); answers[q.id] = { answers: [value] }; }
      result = { answers };
    } else if (a.method === 'mcpServer/elicitation/request') {
      if (!['decline', 'cancel'].includes(answer.decision)) throw new Error('Complete this external authorization in the terminal.');
      result = { action: answer.decision, content: null, _meta: null };
    } else {
      if (!['accept', 'decline', 'cancel'].includes(answer.decision)) throw new Error('Invalid approval decision.');
      result = a.method === 'item/permissions/requestApproval' ? { permissions: answer.decision === 'accept' ? a.params.permissions : {}, scope: 'turn' } : { decision: answer.decision };
    }
    client.respond(a.id, result); approvals.delete(String(requestId)); return true;
  }
  return { provider, list, history, pending, respond,
    async create(cwd, model) { const client = await ensure(); const r = await client.call('thread/start', { cwd, ...(model ? { model } : {}) }); attached.add(r.thread.id); return threadMeta(r.thread, provider); },
    async send(id, text, messageId, model, attachments = []) { const client = await attach(id); if (pending(id).length) throw new Error('Answer the pending request before sending another message.'); return client.call('turn/start', { threadId: id, clientUserMessageId: messageId, input: [{ type: 'text', text, text_elements: [] }, ...attachments.map(a => ({ type: 'localImage', path: a.path }))], ...(model ? { model } : {}) }); },
    async interrupt(id) { const client = await attach(id); const r = await client.call('thread/turns/list', { threadId: id, limit: 1 }); const turn = r.data.find(t => t.status === 'inProgress'); if (turn) await client.call('turn/interrupt', { threadId: id, turnId: turn.id }); return true; },
    async inspect(id) { await attach(id); return { provider, id, endpoint }; },
    async models() { return (await (await ensure()).call('model/list', {})).data.map(m => ({ id: m.model, name: m.displayName || m.model })); },
    async close() { rpc?.dispose(); child?.kill('SIGTERM'); },
  };
}

export function claudeItems(messages) {
  return messages.flatMap(m => {
    const content = m.message?.content; if (!content) return [];
    const pieces = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    return pieces.flatMap((p, index) => {
      const id = m.uuid + ':' + index;
      if (p.type === 'text') return [{ id, role: m.type === 'user' ? 'user' : 'assistant', type: 'message', text: clip(p.text) }];
      if (p.type === 'tool_use') return [{ id, role: 'activity', type: 'tool', title: p.name, text: clip(JSON.stringify(p.input), 6000), files: p.input?.file_path ? [{ path: p.input.file_path }] : [] }];
      if (p.type === 'tool_result') return [{ id, role: 'activity', type: 'toolResult', title: 'Tool result', text: clip(typeof p.content === 'string' ? p.content : JSON.stringify(p.content), 6000) }];
      return [];
    });
  });
}
export function createClaudeProvider({ sdk, home = '/data/claude/.claude', executable = '/usr/local/bin/claude', onNew = () => {} } = {}) {
  const active = new Map(), metadata = new Map(), approvals = new Map();
  async function api() { if (!sdk) sdk = await import('@anthropic-ai/claude-agent-sdk'); return sdk; }
  const meta = s => ({ provider: 'claude', id: s.sessionId, title: clip(s.customTitle || s.summary || s.firstPrompt || 'Untitled conversation', 160), cwd: s.cwd, updatedAt: s.lastModified, createdAt: s.createdAt || s.lastModified, archived: !!s.archived });
  function pending(id) { return [...approvals.values()].filter(p => p.threadId === id).map(({ resolve, input, ...a }) => a); }
  async function find(id) {
    validThread(id); if (metadata.has(id)) return metadata.get(id);
    const value = await (await api()).getSessionInfo(id); if (!value) throw new Error('Conversation not found.');
    const result = meta(value); metadata.set(id, result); return result;
  }
  async function start(id) {
    if (active.has(id)) return active.get(id);
    const info = await find(id), queue = [], waiters = []; let ended = false;
    if (info.fresh && await (await api()).getSessionInfo(id)) info.fresh = false;
    async function* input() { while (!ended) { if (!queue.length) await new Promise(r => waiters.push(r)); while (queue.length) yield queue.shift(); } }
    const state = { info, state: 'idle', items: [], error: null, query: null, push(m) { queue.push(m); waiters.splice(0).forEach(r => r()); }, end() { ended = true; waiters.splice(0).forEach(r => r()); } };
    active.set(id, state);
    const agent = await api();
    try {
      state.query = agent.query({ prompt: input(), options: { cwd: info.cwd, pathToClaudeCodeExecutable: executable,
        ...(info.fresh ? { sessionId: id } : { resume: id }), settingSources: ['user', 'project', 'local'],
        env: { ...process.env, CLAUDE_CONFIG_DIR: home, DISABLE_AUTOUPDATER: '1', AGENT_TERMINAL_SESSION_ID: '', AGENT_TERMINAL_LAUNCH_ID: '' },
        canUseTool: (name, input, context) => new Promise(resolve => {
          const key = randomUUID(); approvals.set(key, { id: key, threadId: id, method: name === 'AskUserQuestion' ? 'questions' : 'permission', title: name, detail: clip(JSON.stringify(input, null, 2), 12000), questions: input.questions || [], input, resolve });
          state.state = 'needs_you'; context.signal.addEventListener('abort', () => { approvals.delete(key); resolve({ behavior: 'deny', message: 'Request cancelled.' }); }, { once: true });
        }),
      } });
      (async () => {
        try {
          for await (const event of state.query) {
            if (['assistant', 'user'].includes(event.type)) state.items.push(...claudeItems([event]));
            if (state.items.length > 200) state.items.splice(0, state.items.length - 200);
            if (event.type === 'result') { state.state = event.is_error ? 'error' : 'idle'; state.error = event.is_error ? clip(event.result || event.errors?.join('\n') || 'Provider error', 2000) : null; info.error = state.error; }
            if (event.type === 'system' && event.subtype === 'session_state_changed') state.state = event.state === 'requires_action' ? 'needs_you' : event.state;
          }
        } catch (error) { state.error = clip(error.message, 2000); state.state = 'error'; info.error = state.error; }
        finally { active.delete(id); for (const [key, a] of approvals) if (a.threadId === id) { approvals.delete(key); a.resolve({ behavior: 'deny', message: 'Session ended.' }); } }
      })();
      return state;
    } catch (error) { active.delete(id); throw error; }
  }
  return { provider: 'claude', pending, restore(row) { metadata.set(row.id, row); },
    async list() { const rows = (await (await api()).listSessions({ limit: 1000 })).map(meta); for (const row of rows) metadata.set(row.id, row); return rows.filter(r => !r.archived).concat([...metadata.values()].filter(r => r.fresh && !rows.some(v => v.id === r.id))).map(r => ({ ...r, status: { type: active.get(r.id)?.state || 'notLoaded' } })); },
    async create(cwd) { const row = { provider: 'claude', id: randomUUID(), cwd, title: 'New conversation', updatedAt: Date.now(), createdAt: Date.now(), fresh: true }; metadata.set(row.id, row); onNew(row); return row; },
    async history(id, cursor) {
      const info = await find(id), state = active.get(id);
      if (info.fresh && await (await api()).getSessionInfo(id)) info.fresh = false;
      const messages = info.fresh && !state ? [] : await (await api()).getSessionMessages(id).catch(() => []);
      const all = claudeItems(messages), end = cursor ? Math.max(0, Number(cursor)) : all.length;
      const items = all.slice(Math.max(0, end - 20), end);
      if (!cursor && state) for (const item of state.items) if (!items.some(i => i.id === item.id)) items.push(item);
      return { ...info, items: items.slice(-25), cursor: end > 20 ? String(end - 20) : null, status: { type: state?.state || (info.error ? 'error' : 'notLoaded') }, error: state?.error || info.error, approvals: pending(id) };
    },
    async send(id, text, messageId, model, attachments = []) { const state = await start(id); if (pending(id).length) throw new Error('Answer the pending request first.'); if (model) await state.query.setModel(model); state.state = 'running'; state.push({ type: 'user', uuid: messageId, session_id: id, parent_tool_use_id: null, message: { role: 'user', content: attachments.length ? [{ type: 'text', text }, ...attachments.map(a => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } }))] : text } }); return { accepted: true }; },
    async interrupt(id) { await active.get(id)?.query?.interrupt(); return true; },
    async respond(id, requestId, answer) {
      const a = approvals.get(requestId); if (!a || a.threadId !== id) throw new Error('Request expired.');
      let result;
      if (a.method === 'questions') {
        const answers = {}; for (const q of a.questions) { const value = answer.answers?.[q.question]; if (typeof value !== 'string' || !value.trim()) throw new Error('Answer each question.'); answers[q.question] = value; }
        result = { behavior: 'allow', updatedInput: { ...a.input, answers } };
      } else { if (!['accept', 'decline', 'cancel'].includes(answer.decision)) throw new Error('Invalid decision.'); result = answer.decision === 'accept' ? { behavior: 'allow', updatedInput: a.input } : { behavior: 'deny', message: 'Declined by the user.' }; }
      approvals.delete(requestId); a.resolve(result); if (active.has(id)) active.get(id).state = 'running'; return true;
    },
    async inspect(id) { await find(id); return { provider: 'claude', id, active: active.has(id) }; },
    async close() { for (const state of active.values()) { state.end(); state.query?.close(); } },
  };
}
