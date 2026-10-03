import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { launchBrowser } from '../tools/ui-explorer/browser.mjs';
import { startFixture } from '../tools/ui-explorer/fixture.mjs';

// Run explicitly as an ordinary user on the test VM. Chromium retains its
// sandbox, unlike the existing browser suite's disposable-container launcher.
test('explorer uses a fresh inert UI and blocks navigation beyond its fixture', {
  skip: process.env.UI_EXPLORER_BROWSER_TEST !== '1', timeout: 30000,
}, async t => {
  let externalRequests = 0;
  const external = createServer((_req, res) => { externalRequests++; res.end('must not be reached'); });
  external.listen(0, '127.0.0.1'); await once(external, 'listening');
  t.after(() => { external.close(); external.closeAllConnections(); });
  const fixture = await startFixture(process.env.WEBUI_BUNDLE || resolve('agent-terminal/rootfs/opt/webui/index.html'));
  t.after(() => fixture.close());
  const browser = await launchBrowser({ executable: process.env.CHROMIUM_BIN || '/usr/bin/chromium',
    origin: fixture.origin, viewport: { width: 1280, height: 800 } });
  t.after(() => browser.close());
  const png = Buffer.from(await browser.screenshot(), 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const evidence = await browser.evidence();
  assert.equal(evidence.sessions.length, 4);
  assert.equal(evidence.split, false);
  assert.equal(browser.events.some(e => e.type === 'page-error'), false);
  const result = await browser.command('Page.navigate', { url: `http://127.0.0.1:${external.address().port}/outside` });
  assert.match(result.errorText, /BLOCKED_BY_CLIENT/);
  assert.equal(externalRequests, 0);
  assert.equal(browser.events.some(e => e.type === 'blocked-network'), true);
});
