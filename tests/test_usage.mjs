import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readCodexUsage, readProviderUsage, quotaWindow } from '../agent-terminal/rootfs/opt/agent-terminal/usage.mjs';

test('quota reports use the newest account snapshot, preserve zero and omit chat content', t => {
  const root = mkdtempSync(join(tmpdir(), 'usage-reports-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'conversations')); mkdirSync(join(root, 'usage'));
  const records = ['a', 'b'].map(id => ({ id, agent: 'codex', conversationId: id }));
  for (const [i, record] of records.entries()) {
    const transcript = join(root, record.id + '.jsonl');
    writeFileSync(join(root, 'conversations', record.id + '.json'), JSON.stringify({ agent: 'codex', transcript }));
    writeFileSync(transcript, 'x'.repeat(600000) + '\n' + JSON.stringify({ timestamp: '2026-10-0' + (i + 1) + 'T12:00:00Z', type: 'event_msg', payload: {
      type: 'token_count', rate_limits: { primary: { used_percent: i * 25, window_minutes: 300 }, secondary: { used_percent: 0, window_minutes: 10080 } }
    } }) + '\n' + JSON.stringify({ type: 'message', content: 'private chat text' }) + '\n{unfinished');
  }
  const report = readProviderUsage({ stateDir: root, records });
  assert.equal(report.providers.codex.windows[0].usedPercent, 25, 'shared quota reports must not be summed');
  assert.equal(report.providers.codex.windows[1].usedPercent, 0);
  assert.equal(report.providers.codex.windows[1].label, 'Weekly');
  assert.equal(JSON.stringify(report).includes('private chat text'), false);
  assert.equal(readCodexUsage(join(root, 'missing')), null);
  assert.equal(quotaWindow({ used_percent: -1 }, 'test'), null);
  assert.equal(quotaWindow({ used_percent: '25' }, 'test'), null);
  assert.equal(report.providers.claude.windows.length, 0, 'unknown is not zero usage');
  assert.match(report.providers.ollama.source, /Local/);
});

test('Claude status-line collector saves only valid quota counters', t => {
  const root = mkdtempSync(join(tmpdir(), 'claude-quota-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = new URL('../agent-terminal/rootfs/opt/agent-terminal/claude-statusline.mjs', import.meta.url).pathname;
  const output = execFileSync(process.execPath, [script], { env: { ...process.env, AGENT_TERMINAL_STATE_DIR: root }, encoding: 'utf8', input: JSON.stringify({
    transcript_path: '/private/transcript', secret: 'private marker', rate_limits: {
      five_hour: { used_percentage: 0, resets_at: 1792000000, private: 'marker' }, seven_day: { used_percentage: 30 }
    }
  }) });
  assert.match(output, /0% used/);
  const saved = readFileSync(join(root, 'usage', 'claude.json'), 'utf8');
  assert.equal(saved.includes('private'), false);
  assert.equal(readProviderUsage({ stateDir: root, records: [] }).providers.claude.windows[1].usedPercent, 30);
});
