import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceStore, UI_MARKER } from '../agent-terminal/rootfs/opt/agent-terminal/workspaces.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspaces-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = { stateDir: join(root, 'state'), workspaceRoot: join(root, 'projects'),
    homeDirectory: join(root, 'ha'), optionsPath: join(root, 'options.json'),
    templatePath: join(root, 'template.html'), outputPath: join(root, 'run/index.html') };
  writeFileSync(paths.optionsPath, JSON.stringify({ agent: 'codex', secret: 'never-in-html' }));
  writeFileSync(paths.templatePath, '<script>const config = ' + UI_MARKER + ';</script>');
  return { root, paths, store: createWorkspaceStore(paths) };
}

test('workspaces persist with shared instructions and a single skills directory', t => {
  const { paths, store } = fixture(t);
  const workspace = store.create('automations', 'HA automations');
  assert.match(readFileSync(join(workspace.directory, 'AGENTS.md'), 'utf8'), /HA automations/);
  assert.equal(readFileSync(join(workspace.directory, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  assert.equal(readlinkSync(join(workspace.directory, '.claude/skills')), '../.agents/skills');
  mkdirSync(join(workspace.directory, '.agents/skills/check-yaml'));
  writeFileSync(join(workspace.directory, '.agents/skills/check-yaml/SKILL.md'), 'task instructions');
  assert.equal(readFileSync(join(workspace.directory, '.claude/skills/check-yaml/SKILL.md'), 'utf8'), 'task instructions');
  assert.deepEqual(createWorkspaceStore(paths).get('automations'), workspace);
  assert.deepEqual(store.list().map(w => w.id), ['homeassistant', 'automations']);
  assert.throws(() => store.create('automations'), /already exists/);
  assert.throws(() => store.create('homeassistant'), /already exists/);
});

test('registering an existing project preserves all existing files', t => {
  const { root, store } = fixture(t);
  const directory = join(root, 'existing project');
  mkdirSync(directory);
  writeFileSync(join(directory, 'AGENTS.md'), 'existing instructions');
  store.create('project', 'Existing project', directory);
  assert.deepEqual(readdirSync(directory), ['AGENTS.md']);
  assert.equal(readFileSync(join(directory, 'AGENTS.md'), 'utf8'), 'existing instructions');
});

test('untrusted workspace IDs cannot resolve paths or tmux target expressions', t => {
  const { store } = fixture(t);
  for (const id of ['../options', '/data', 'x.y', 'x:y', '=agent', 'x;id', '$(id)', 'x\ny', 'a'.repeat(41), '']) {
    assert.throws(() => store.get(id), /Invalid workspace ID/);
    assert.throws(() => store.create(id), /Workspace ID/);
  }
  assert.throws(() => store.get('unknown'), /Unknown workspace/);
  assert.throws(() => store.create('valid', 'Name', 'relative'), /absolute path/);
  assert.throws(() => store.create('valid', 'Name\nOther'), /printable/);
});

test('runtime UI safely serializes only public session metadata', t => {
  const { paths, store } = fixture(t);
  store.create('script', '</script><script>alert(1)</script>');
  const config = store.refreshUI();
  let html = readFileSync(paths.outputPath, 'utf8');
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.equal(html.includes('never-in-html'), false);
  assert.equal(config.defaultAgent, 'codex');
  assert.deepEqual(JSON.parse(html.slice('<script>const config = '.length, -';</script>'.length)), config);
  writeFileSync(paths.optionsPath, JSON.stringify({ web_command: 'secret-custom-command' }));
  assert.equal(store.refreshUI().defaultAgent, 'custom');
  html = readFileSync(paths.outputPath, 'utf8');
  assert.equal(html.includes('secret-custom-command'), false);
  assert.match(html, /"id":"custom"/);
  store.create('later');
  store.refreshUI();
  assert.match(readFileSync(paths.outputPath, 'utf8'), /"id":"later"/);
});
