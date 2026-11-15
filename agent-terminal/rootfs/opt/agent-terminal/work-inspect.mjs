// Trusted local backend view for the same conversation as the workspace.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { requestWork } from './work-client.mjs';
const [provider, thread] = process.argv.slice(2);
const ref = { provider, thread };
try {
  const info = await requestWork('inspect', ref);
  if (info.endpoint) {
    const child = spawn('codex', ['--remote', 'unix://' + info.endpoint, 'resume', thread], { stdio: 'inherit', env: { ...process.env, CODEX_HOME: provider === 'ollama' ? '/data/ollama/codex' : '/data/codex' } });
    child.on('error', e => { console.error(e.message); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code || 0; });
  } else {
    console.log('Conversation backend — messages share the workspace chat.\nType a message, /stop, /approve REQUEST_ID, /deny REQUEST_ID, or /quit.');
    const seen = new Map(); let reading = false;
    async function poll() {
      if (reading) return; reading = true;
      try {
        const history = await requestWork('history', ref);
        for (const item of history.items) { const signature = JSON.stringify(item); if (seen.get(item.id) === signature) continue; seen.set(item.id, signature); console.log('\n[' + item.role + '] ' + (item.title || '') + '\n' + (item.text || '')); }
        for (const a of history.approvals) if (!seen.has(a.id)) { seen.set(a.id, 'approval'); console.log('\n[Needs you: ' + a.id + '] ' + (a.title || a.method) + '\n' + (a.detail || JSON.stringify(a.questions))); }
      } catch (error) { console.error(error.message); } finally { reading = false; }
    }
    const timer = setInterval(poll, 1500); await poll();
    const lines = createInterface({ input: process.stdin });
    lines.on('line', async line => {
      try {
        if (line === '/quit') { clearInterval(timer); lines.close(); return; }
        if (line === '/stop') await requestWork('interrupt', ref);
        else if (/^\/(approve|deny) /.test(line)) await requestWork('respond', { ...ref, requestId: line.split(' ')[1], answer: { decision: line.startsWith('/approve') ? 'accept' : 'decline' } });
        else if (line.trim()) await requestWork('send', { ...ref, text: line, messageId: randomUUID() });
        await poll();
      } catch (error) { console.error(error.message); }
    });
    lines.on('close', () => { clearInterval(timer); });
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
