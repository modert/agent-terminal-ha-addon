#!/usr/bin/env node
// Workspace metadata is one file per ID, so concurrent creates cannot replace
// one another. Browser requests can select these IDs, never arbitrary paths.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = /^[a-z][a-z0-9_-]{0,39}$/;
export const UI_MARKER = '/*{{SESSION_CONFIG}}*/ null';

export function createWorkspaceStore({
  stateDir = '/data/agent-terminal',
  workspaceRoot = '/share/agent-terminal/workspaces',
  homeDirectory = '/homeassistant',
  optionsPath = '/data/options.json',
  templatePath = '/opt/webui/index.html',
  outputPath = '/run/agent-terminal/index.html',
} = {}) {
  const registry = join(stateDir, 'workspaces');
  const home = { id: 'homeassistant', name: 'Home Assistant', directory: homeDirectory };
  function validate(workspace) {
    if (!ID.test(workspace.id)) throw new Error('Workspace ID must use lowercase letters, numbers, _ or -, starting with a letter (max 40).');
    if (typeof workspace.name !== 'string' || !workspace.name.trim() || workspace.name.length > 80 || /[\x00-\x1f\x7f]/.test(workspace.name)) throw new Error('Workspace name must be 1–80 printable characters.');
    if (typeof workspace.directory !== 'string' || !isAbsolute(workspace.directory) || /[\x00-\x1f\x7f]/.test(workspace.directory)) throw new Error('Workspace directory must be an absolute path.');
    return { id: workspace.id, name: workspace.name, directory: workspace.directory };
  }
  function get(id) {
    if (!ID.test(id)) throw new Error('Invalid workspace ID.');
    if (id === home.id) return home;
    const file = join(registry, id + '.json');
    if (!existsSync(file)) throw new Error(`Unknown workspace: ${id}`);
    const workspace = validate(JSON.parse(readFileSync(file, 'utf8')));
    if (workspace.id !== id) throw new Error(`Workspace ID does not match ${file}`);
    return workspace;
  }
  function list() {
    const files = existsSync(registry) ? readdirSync(registry).filter(name => name.endsWith('.json')).sort() : [];
    return [home, ...files.map(name => get(name.slice(0, -5))).filter(w => w.id !== home.id)];
  }
  function create(id, name = id, directory = join(workspaceRoot, id)) {
    const workspace = validate({ id, name, directory });
    if (id === home.id || existsSync(join(registry, id + '.json'))) throw new Error(`Workspace already exists: ${id}`);
    const newDirectory = !existsSync(directory);
    mkdirSync(directory, { recursive: true });
    if (!statSync(directory).isDirectory()) throw new Error('Workspace path is not a directory.');
    if (newDirectory) {
      writeFileSync(join(directory, 'AGENTS.md'), `# ${name}\n\nAdd this workspace's goals, conventions, relevant files, and validation steps here.\n`, { flag: 'wx' });
      writeFileSync(join(directory, 'CLAUDE.md'), '@AGENTS.md\n', { flag: 'wx' });
      mkdirSync(join(directory, '.agents/skills'), { recursive: true });
      mkdirSync(join(directory, '.claude'), { recursive: true });
      symlinkSync('../.agents/skills', join(directory, '.claude/skills'));
    }
    mkdirSync(registry, { recursive: true, mode: 0o700 });
    writeFileSync(join(registry, id + '.json'), JSON.stringify(workspace, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return workspace;
  }
  function refreshUI() {
    const options = JSON.parse(readFileSync(optionsPath, 'utf8'));
    const agents = [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'ChatGPT' }, { id: 'shell', name: 'Shell' }];
    if (options.web_command) agents.push({ id: 'custom', name: 'Custom' });
    const config = { agents, workspaces: list(), defaultAgent: options.web_command ? 'custom' : (options.agent || 'claude') };
    const json = JSON.stringify(config).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const template = readFileSync(templatePath, 'utf8');
    if (!template.includes(UI_MARKER)) throw new Error('Terminal UI is missing its workspace marker.');
    mkdirSync(resolve(outputPath, '..'), { recursive: true });
    const temporary = `${outputPath}.${process.pid}.tmp`;
    writeFileSync(temporary, template.replace(UI_MARKER, () => json));
    renameSync(temporary, outputPath);
    return config;
  }
  return { get, list, create, refreshUI };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = createWorkspaceStore();
  const [command = 'list', ...args] = process.argv.slice(2);
  try {
    if (command === 'get' && args.length === 1) console.log(JSON.stringify(store.get(args[0])));
    else if (command === 'list') {
      const workspaces = store.list();
      console.log(args[0] === '--json' ? JSON.stringify(workspaces) : workspaces.map(w => `${w.id}\t${w.name}\t${w.directory}`).join('\n'));
    } else if (command === 'create' && args.length >= 1 && args.length <= 3) {
      const workspace = store.create(...args);
      console.log(`Created ${workspace.name}: ${workspace.directory}`);
      try { store.refreshUI(); }
      catch (error) { console.error(`Workspace saved; UI refresh failed: ${error.message}`); process.exitCode = 1; }
      console.log('Reload the terminal page to find it in the workspace selector.');
    } else if (command === 'refresh-ui' && args.length === 0) store.refreshUI();
    else {
      console.log('Usage: agent-workspace list [--json]\n       agent-workspace create ID [NAME] [DIRECTORY]\n       agent-workspace get ID\n       agent-workspace refresh-ui');
      if (command !== 'help' && command !== '--help') process.exitCode = 2;
    }
  } catch (error) { console.error(`agent-workspace: ${error.message}`); process.exitCode = 1; }
}
