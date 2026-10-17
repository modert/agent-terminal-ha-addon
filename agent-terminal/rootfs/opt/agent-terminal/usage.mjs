// Read only provider-reported counters. Never return transcripts or credentials.
import { openSync, closeSync, fstatSync, readSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WINDOW = 512 * 1024;
export function quotaWindow(value, label, percent = 'used_percent', reset = 'resets_at') {
  if (!value || typeof value[percent] !== 'number' || !Number.isFinite(value[percent]) || value[percent] < 0 || value[percent] > 100) return null;
  const minutes = value.window_minutes;
  return { label: minutes === 10080 ? 'Weekly' : minutes === 300 ? '5-hour' : minutes > 0 ? minutes + '-minute' : label,
    usedPercent: value[percent], resetsAt: Number.isFinite(value[reset]) ? value[reset] : null };
}
export function readCodexUsage(path) {
  let fd;
  try {
    fd = openSync(path, 'r'); const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, WINDOW), data = Buffer.alloc(length);
    readSync(fd, data, 0, length, stat.size - length);
    const lines = data.toString('utf8').split('\n');
    if (stat.size > length) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      let item; try { item = JSON.parse(lines[i]); } catch { continue; }
      if (item.type !== 'event_msg' || item.payload?.type !== 'token_count') continue;
      const rate = item.payload.rate_limits;
      const windows = [quotaWindow(rate?.primary, 'Session window'), quotaWindow(rate?.secondary, 'Weekly')].filter(Boolean);
      if (windows.length) return { windows, updatedAt: Number.isFinite(Date.parse(item.timestamp)) ? Date.parse(item.timestamp) : stat.mtimeMs };
    }
  } catch { /* Missing/rotated transcript or provider format not supported. */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return null;
}
export function readProviderUsage({ stateDir, records, now = Date.now() }) {
  const result = {};
  for (const agent of ['claude', 'codex', 'ollama', 'antigravity', 'grok', 'shell', 'custom']) {
    result[agent] = { windows: [], updatedAt: null, source: agent === 'ollama' ? 'Local models: no subscription quota' :
      ['shell', 'custom'].includes(agent) ? 'No provider quota' : 'Usage unavailable from this provider' };
  }
  // Bound work even when many historical tasks exist. Codex quota is shared
  // by its account; use the newest observed report, never add session quotas.
  const candidates = records.filter(r => r.agent === 'codex' && r.conversationId).slice(-64);
  for (const record of candidates) {
    try {
      const saved = JSON.parse(readFileSync(join(stateDir, 'conversations', record.id + '.json'), 'utf8'));
      if (saved.agent !== 'codex' || !saved.transcript) continue;
      const usage = readCodexUsage(saved.transcript);
      if (usage && usage.updatedAt > (result.codex.updatedAt || 0)) result.codex = { ...usage, source: 'Last provider report' };
    } catch { /* A stale record must not prevent other providers loading. */ }
  }
  try {
    const path = join(stateDir, 'usage', 'claude.json');
    if (existsSync(path)) {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      const windows = [quotaWindow(saved.five_hour, '5-hour', 'used_percentage'), quotaWindow(saved.seven_day, 'Weekly', 'used_percentage')].filter(Boolean);
      if (windows.length && Number.isFinite(saved.updatedAt)) result.claude = { windows, updatedAt: saved.updatedAt, source: 'Last provider report' };
    }
  } catch { /* No status-line report yet. */ }
  return { providers: result, checkedAt: now };
}
