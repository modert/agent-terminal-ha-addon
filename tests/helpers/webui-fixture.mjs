// Shared, inert ttyd/session transport for browser tests and exploratory runs.
const mock = `<script>
    window.testPackets = []; window.testFocus = []; window.testTerminalConnections = [];
    document.addEventListener('focusin', e => {
      window.testFocus.push({ id: e.target.id, active: navigator.userActivation.isActive });
    });
    window.fetch = async () => ({ json: async () => ({ token: '' }) });
    window.testHub = window.parent !== window && window.parent.testHub || {
      workspaces: [{ id: 'homeassistant', name: 'Home Assistant', directory: '/homeassistant' },
        { id: 'addon', name: 'Agent Terminal', directory: '/addons/agent-terminal' }],
      sessions: JSON.parse(localStorage.getItem('test-sessions') || 'null') || [
        ...['claude', 'codex', 'shell'].map(agent =>
          ({ id: 'agent-homeassistant-' + agent, name: 'Main', workspace: 'homeassistant', agent, stopped: false, running: false })),
        { id: 'session-' + 'b'.repeat(32), name: 'Session navigation', description: 'Polish the provider chooser',
          workspace: 'addon', agent: 'claude', stopped: false, running: false }],
      controls: [],
      publish() {
        localStorage.setItem('test-sessions', JSON.stringify(this.sessions));
        for (const socket of this.controls) if (socket.readyState === 1) socket.packet({ type: 'sessions', sessions: this.sessions,
          agents: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'ChatGPT' }, { id: 'shell', name: 'Shell' }],
          workspaces: this.workspaces });
      }
    };
    window.WebSocket = class {
      static OPEN = 1;
      readyState = 1;
      constructor(url) {
        this.url = url; this.args = new URL(url).searchParams.getAll('arg'); this.control = this.args[0] === 'sessions';
        if (this.control) testHub.controls.push(this); else { window.testSocket = this; window.testTerminalConnections.push(this); }
        setTimeout(() => this.onopen(), 0);
      }
      packet(value) { this.onmessage({ data: '0' + JSON.stringify(value) + '\\n' }); }
      send(data) {
        const text = new TextDecoder().decode(data);
        if (!this.control) {
          window.testPackets.push(text);
          if (text[0] === '{') {
            const id = this.args[2] || 'agent-' + this.args[1] + '-' + this.args[0];
            const record = testHub.sessions.find(s => s.id === id);
            if (record && !record.stopped) record.running = true;
            if (window.explorerPreview) {
              const title = (record?.name || 'Main') + ' / ' + this.args[0] + ' / ' + this.args[1];
              const screen = '\\x1b[?2004h\\x1b[36mAgent Terminal test session\\x1b[0m\\r\\n' + title +
                '\\r\\n\\r\\nSession controls are interactive. Terminal input is recorded only.\\r\\n> ';
              this.onmessage({ data: new TextEncoder().encode('0' + screen).buffer });
            }
          }
          return;
        }
        if (text[0] === '{') { testHub.publish(); return; }
        const request = JSON.parse(text.slice(1));
        let record = testHub.sessions.find(s => s.id === request.session);
        if (request.method === 'create') {
          record = { id: 'session-' + crypto.randomUUID().replaceAll('-', ''), name: request.name, description: request.description || '',
            agent: request.agent, workspace: request.workspace, running: false, stopped: false };
          testHub.sessions.push(record);
        } else if (request.method === 'rename') { record.name = request.name; record.description = request.description ?? record.description; }
        else if (request.method === 'stop') { record.stopped = true; record.running = false; }
        else if (request.method === 'start') record.stopped = false;
        if (request.method !== 'list') this.packet({ request: request.request, result: record });
        else this.packet({ request: request.request, result: { sessions: testHub.sessions,
          agents: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'ChatGPT' }, { id: 'shell', name: 'Shell' }],
          workspaces: testHub.workspaces } });
        testHub.publish();
      }
      close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    };
  </script>`;

export function fixtureHtml(bundle, { preview = false } = {}) {
  return bundle.replace('<head>', '<head><script>window.explorerPreview = ' + preview + '</script>' + mock)
    .replace('term.open(termEl);', 'term.open(termEl); window.testTerminal = term;');
}
