// Builds the single self-contained index.html that ttyd serves with --index.
//
// ttyd's -I option replaces only index.html - it will not serve any other file
// alongside it - so xterm's JS and CSS have to be inlined into the page.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mod = (...p) => join(here, 'node_modules', ...p);

// `</script` inside a JS string literal would end the inline script tag early.
const escape = (s) => s.replace(/<\/(script|style)/gi, '<\\/$1');

const parts = {
  XTERM_CSS: readFileSync(mod('@xterm', 'xterm', 'css', 'xterm.css'), 'utf8'),
  XTERM_JS: readFileSync(mod('@xterm', 'xterm', 'lib', 'xterm.js'), 'utf8'),
  FIT_JS: readFileSync(mod('@xterm', 'addon-fit', 'lib', 'addon-fit.js'), 'utf8'),
};

let html = readFileSync(join(here, 'index.template.html'), 'utf8');
for (const [name, body] of Object.entries(parts)) {
  const marker = `/*{{${name}}}*/`;
  if (!html.includes(marker)) throw new Error(`marker ${marker} missing from template`);
  html = html.replace(marker, () => escape(body));
}

const out = join(here, 'index.html');
writeFileSync(out, html);
console.log(`[webui] wrote ${out} (${(html.length / 1024).toFixed(0)} KiB)`);
