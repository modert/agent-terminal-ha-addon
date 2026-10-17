// Claude's documented status-line input includes account quota windows. Save
// only those counters, never the incoming prompt/session paths or auth data.
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { quotaWindow } from './usage.mjs';
try {
  const input = readFileSync(0, 'utf8');
  if (input.length > 65536) process.exit(0);
  const data = JSON.parse(input), rate = data.rate_limits;
  const saved = { updatedAt: Date.now() };
  for (const key of ['five_hour', 'seven_day']) {
    if (quotaWindow(rate?.[key], key, 'used_percentage')) saved[key] = {
      used_percentage: rate[key].used_percentage,
      ...(Number.isFinite(rate[key].resets_at) ? { resets_at: rate[key].resets_at } : {}),
    };
  }
  if (saved.five_hour || saved.seven_day) {
    const root = join(process.env.AGENT_TERMINAL_STATE_DIR || '/data/agent-terminal', 'usage');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const temp = join(root, randomUUID() + '.tmp');
    writeFileSync(temp, JSON.stringify(saved) + '\n', { mode: 0o600 }); renameSync(temp, join(root, 'claude.json'));
  }
  const windows = [quotaWindow(saved.five_hour, '5h', 'used_percentage'), quotaWindow(saved.seven_day, '7d', 'used_percentage')].filter(Boolean);
  if (windows.length) console.log(windows.map(w => w.label + ' ' + Math.round(w.usedPercent) + '% used').join(' · '));
} catch { /* A status line must never block a conversation. */ }
