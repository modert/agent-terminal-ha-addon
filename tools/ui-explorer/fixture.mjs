import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fixtureHtml } from '../../tests/helpers/webui-fixture.mjs';

export async function startFixture(bundle) {
  const source = await readFile(bundle, 'utf8');
  if (source.includes('/*{{XTERM_JS}}*/')) throw new Error('Build the web UI before starting the explorer');
  const html = fixtureHtml(source, { preview: true });
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || new URL(req.url, 'http://localhost').pathname !== '/') {
      res.writeHead(404).end(); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'");
    res.end(html);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { origin: `http://127.0.0.1:${server.address().port}`,
    bundleSha256: createHash('sha256').update(source).digest('hex'),
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}
