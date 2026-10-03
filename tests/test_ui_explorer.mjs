import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { validateAction, performAction } from '../tools/ui-explorer/actions.mjs';
import { nextAction, ollamaRequest } from '../tools/ui-explorer/ollama.mjs';

test('invalid model actions cannot invoke browser commands', async () => {
  const commands = [];
  const browser = { command: (...args) => commands.push(args) };
  for (const action of [
    { action: 'shell', text: 'id' }, { action: 'click', x: -1, y: 50 },
    { action: 'click', x: 50, y: 1001 }, { action: 'drag', x: 1, y: 1, to_x: NaN, to_y: 1 },
    { action: 'key', key: 'Ctrl+L' }, { action: 'key', key: 'Ctrl+Shift+I' },
    { action: 'type', text: '\x1b[31m' }, { action: 'type', text: 'x'.repeat(2001) },
    { action: 'wait', seconds: 999 }, { action: 'scroll', x: 50, y: 50, delta: Infinity },
    { action: 'click', x: 1, y: 1, script: 'document.cookie' },
  ]) await assert.rejects(performAction(browser, { reason: 'test', ...action }, { width: 1280, height: 800 }));
  assert.deepEqual(commands, []);
});

test('coordinate conversion, modifiers and Unicode survive the controller', async () => {
  const commands = [];
  const browser = { command: async (method, params) => commands.push({ method, ...params }) };
  const viewport = { width: 1280, height: 800 };
  await performAction(browser, { action: 'click', reason: '', x: 1000, y: 1000 }, viewport);
  assert.equal(commands[0].x, 1279); assert.equal(commands[0].y, 799);
  assert.deepEqual(commands.map(c => c.type), ['mousePressed', 'mouseReleased']);
  commands.length = 0;
  await performAction(browser, { action: 'key', reason: '', key: 'Shift+Enter' }, viewport);
  assert.equal(commands[0].modifiers, 8); assert.equal(commands[0].text, '\r');
  assert.equal(commands[1].text, undefined); assert.equal(commands[1].type, 'keyUp');
  await performAction(browser, { action: 'type', reason: '', text: '日本語\n🙂' }, viewport);
  assert.equal(commands.at(-1).text, '日本語\n🙂');
  assert.equal(validateAction({ action: 'done', reason: 'Needs human review' }).action, 'done');
});

test('Ollama receives screenshots and returns validated actions; failures stay failures', async t => {
  let request, result = { message: { content: JSON.stringify({ action: 'click', reason: 'Open menu', x: 40, y: 15 }) }, eval_count: 35 };
  let status = 200, hang = false;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    request = JSON.parse(body || '{}');
    if (hang) return;
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const options = { base: `http://127.0.0.1:${server.address().port}`, model: 'local-vision',
    thinking: true, timeoutMs: 1000, viewport: { width: 1280, height: 800 }, goal: 'Explore',
    step: 1, steps: 5, history: [], screenshot: 'fake-base64' };
  const good = await nextAction(options);
  assert.equal(good.action.action, 'click'); assert.equal(good.metrics.outputTokens, 35);
  assert.deepEqual(request.messages[1].images, ['fake-base64']);
  assert.equal(request.stream, false); assert.equal(request.think, false);
  const clickSchema = request.format.oneOf.find(s => s.properties.action.const === 'click');
  assert.equal(clickSchema.additionalProperties, false);
  assert.ok(clickSchema.required.includes('x') && clickSchema.required.includes('y'));
  result = { message: { content: '{"action":"shell","reason":"run a command"}' } };
  assert.match((await nextAction(options)).error, /Unknown action/);
  result = { message: { content: 'not JSON' } };
  assert.ok((await nextAction(options)).error);
  result = { error: 'model unavailable' };
  await assert.rejects(nextAction(options), /model unavailable/);
  status = 503;
  await assert.rejects(nextAction(options), /HTTP 503/);
  await assert.rejects(ollamaRequest('http://user:secret@localhost', '/api/show', {}, 1000), /without credentials/);
  hang = true;
  await assert.rejects(ollamaRequest(options.base, '/api/chat', {}, 20), /timeout|aborted/i);
  const stop = new AbortController();
  const waiting = ollamaRequest(options.base, '/api/chat', {}, 10000, stop.signal);
  stop.abort(new Error('Interrupted by operator'));
  await assert.rejects(waiting, /Interrupted by operator/);
});
