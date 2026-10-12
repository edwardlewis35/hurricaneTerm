import { mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const vendor = join(dist, 'vendor');
mkdirSync(vendor, { recursive: true });

const nm = join(root, 'node_modules');
copyFileSync(join(nm, '@xterm/xterm/lib/xterm.js'), join(vendor, 'xterm.js'));
copyFileSync(join(nm, '@xterm/xterm/css/xterm.css'), join(vendor, 'xterm.css'));
copyFileSync(join(nm, '@xterm/addon-fit/lib/addon-fit.js'), join(vendor, 'addon-fit.js'));
copyFileSync(join(nm, '@xterm/addon-search/lib/addon-search.js'), join(vendor, 'addon-search.js'));
copyFileSync(join(nm, '@xterm/addon-web-links/lib/addon-web-links.js'), join(vendor, 'addon-web-links.js'));
for (const f of ['index.html', 'app.js', 'core.js', 'term.js', 'ui.js', 'style.css']) {
  try { copyFileSync(join(root, 'src', f), join(dist, f)); } catch (e) {}
}
console.log('dist prepared:', dist);