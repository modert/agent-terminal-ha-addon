// Provider lifecycle hook. Only an add-on-launched process has a matching
// launch token. Never print hook input: it may contain private chat metadata.
import { readFileSync } from 'node:fs';
import { createSessionStore } from './sessions.mjs';

const id = process.env.AGENT_TERMINAL_SESSION_ID;
const launch = process.env.AGENT_TERMINAL_LAUNCH_ID;
const agent = process.argv[2];
if (id && launch && ['claude', 'codex'].includes(agent)) {
  try {
    const input = readFileSync(0, 'utf8');
    if (input.length > 65536) throw new Error('Oversized session event');
    createSessionStore().remember(id, agent, launch, JSON.parse(input));
  } catch {
    // A deleted session or stale callback is harmless. Hook failures must
    // never block the agent or expose a transcript in its output.
  }
}
