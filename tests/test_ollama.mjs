import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalStore, validateSettings, localModels, chooseModel, launchOptions, modelCatalog } from '../agent-terminal/rootfs/opt/agent-terminal/ollama.mjs';

test('local model discovery excludes cloud aliases, remote models and models without tools', async () => {
  const names = ['local:4b', 'renamed:4b', 'model:cloud', 'model:CLOUD', 'embedding', 'unknown'];
  const inspected = [];
  const models = await localModels('http://model.test:11434', async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: names.map(name => ({ name })) }));
    const model = JSON.parse(options.body).model; inspected.push(model);
    if (model === 'unknown') return new Response('unavailable', { status: 503 });
    return new Response(JSON.stringify({ capabilities: model === 'embedding' ? ['embedding'] : ['completion', 'tools', 'vision'],
      ...(model === 'renamed:4b' ? { remote_host: 'https://remote.test' } : {}) }));
  });
  assert.deepEqual(models, [{ name: 'local:4b', vision: true, thinking: false }]);
  assert.equal(inspected.some(name => /cloud/i.test(name)), false);
  await assert.rejects(localModels('http://model.test', async () => new Response('bad', { status: 503 })), /HTTP 503/);
});

test('local server validation forbids credential URLs, paths and cloud models', () => {
  assert.equal(validateSettings({ url: 'http://model.test:11434/', model: 'local:4b' }).url, 'http://model.test:11434');
  for (const value of [{ url: 'file:///data' }, { url: 'http://user:password@host' }, { url: 'http://host/api' },
    { url: 'http://host', model: 'local:CLOUD' }, { url: 'http://host', model: 'a b' }]) assert.throws(() => validateSettings(value));
});

test('local sessions inherit the reviewer preset once and keep their own model selection', t => {
  const root = mkdtempSync(join(tmpdir(), 'ollama-store-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'health')); writeFileSync(join(root, 'health/config.json'), JSON.stringify({ ollamaUrl: 'http://model.test', model: 'local:4b' }));
  const store = createLocalStore(root), a = 'session-' + 'a'.repeat(32), b = 'session-' + 'b'.repeat(32);
  assert.equal(store.selection(a).model, 'local:4b');
  store.save(a, { url: 'http://model.test', model: 'local:4b' });
  store.save(b, { url: 'http://other.test', model: 'other:7b' });
  assert.equal(createLocalStore(root).selection(a).model, 'local:4b');
  assert.equal(createLocalStore(root).selection(b).model, 'other:7b');
  assert.equal(store.selection('standalone').model, 'other:7b');
  writeFileSync(join(root, 'health/config.json'), '{broken');
  assert.equal(store.config().model, 'other:7b', 'damaged health data cannot break a configured local session');
  assert.throws(() => store.selection('../secret'), /Invalid local session/);
});

test('the model picker supports default, number, name and changing the server', async () => {
  const models = [{ name: 'local:4b' }, { name: 'other:7b' }], settings = { url: 'http://host', model: 'local:4b' };
  for (const [answer, expected] of [['', 'local:4b'], ['2', 'other:7b'], ['other:7b', 'other:7b']]) {
    assert.equal((await chooseModel({ settings, models, question: async () => answer })).model, expected);
  }
  assert.equal(await chooseModel({ settings, models, question: async () => 's' }), null);
  await assert.rejects(chooseModel({ settings, models, question: async () => '99' }), /Choose an installed/);
  await assert.rejects(chooseModel({ settings, models: [], question: () => assert.fail() }), /No installed/);
});

test('local launches isolate data, remove cloud credentials and resume an exact conversation', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';
  const options = launchOptions({ settings: { url: 'http://model.test:11434', model: 'local:4b' },
    home: '/data/local-test/codex', catalog: '/data/local-test/models.json', conversationId: id,
    environment: { CODEX_HOME: '/data/codex', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', OPENAI_BASE_URL: 'http://cloud.test', SUPERVISOR_TOKEN: 'local-ha' } });
  assert.equal(options.env.CODEX_HOME, '/data/local-test/codex');
  assert.equal(options.env.AGENT, 'ollama');
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) assert.equal(options.env[key], undefined);
  assert.equal(options.env.SUPERVISOR_TOKEN, 'local-ha');
  assert.ok(options.args.includes('model_providers.agent_ollama.base_url="http://model.test:11434/v1"'));
  assert.ok(options.args.includes('model_providers.agent_ollama.requires_openai_auth=false'));
  assert.ok(options.args.includes('web_search="disabled"'));
  assert.deepEqual(options.args.slice(-4), ['resume', id, '-m', 'local:4b']);
  assert.equal(options.args.includes('--oss'), false, 'preflighted models are never automatically pulled');
  assert.deepEqual(modelCatalog([{ name: 'local:4b', vision: false }]).models[0].input_modalities, ['text']);
});
