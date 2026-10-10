// Provider lifecycle hook. Only an add-on-launched process has a matching
// launch token. Never print hook input: it may contain private chat metadata.
import { readFileSync } from 'node:fs';
import { createSessionStore } from './sessions.mjs';

const id = process.env.AGENT_TERMINAL_SESSION_ID;
const launch = process.env.AGENT_TERMINAL_LAUNCH_ID;
const agent = process.argv[2] === 'codex' && process.env.AGENT === 'ollama' ? 'ollama' : process.argv[2];
// Antigravity has no start event. It names the conversation in use each time
// it calls the model, so a new ID means the user switched or cleared it in the
// terminal, or the saved one was gone: the session follows the last one named.
const antigravity = input => ({ hook_event_name: process.argv[3] === 'Stop' ? 'Stop' : 'SessionStart', source: 'resume',
  session_id: input.conversationId, transcript_path: input.transcriptPath });
if (id && launch && ['claude', 'codex', 'ollama', 'antigravity'].includes(agent)) {
  try {
    const input = readFileSync(0, 'utf8');
    if (input.length > 65536) throw new Error('Oversized session event');
    const event = JSON.parse(input);
    createSessionStore().remember(id, agent, launch, agent === 'antigravity' ? antigravity(event) : event);
  } catch {
    // A deleted session or stale callback is harmless. Hook failures must
    // never block the agent or expose a transcript in its output.
  }
}
// Antigravity reads a hook's output as its answer; an empty one changes nothing.
if (agent === 'antigravity') console.log('{}');
