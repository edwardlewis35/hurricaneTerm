import { mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const vendor = join(dist, 'vendor');
mkdirSync(vendor, { recursive: true });

const nm = join(root, 'node_modules');
copyFileSync(join(nm, 'markdown-it/dist/browser/markdown-it.umd.min.js'), join(vendor, 'markdown-it.min.js'));
const markdownLicenses = ['markdown-it/LICENSE', 'argparse/LICENSE', 'entities/LICENSE', 'linkify-it/LICENSE', 'mdurl/LICENSE', 'punycode.js/LICENSE-MIT.txt', 'uc.micro/LICENSE.txt'];
writeFileSync(join(vendor, 'markdown-it-LICENSES.txt'), markdownLicenses.map(file => file + '\n\n' + readFileSync(join(nm, file), 'utf8')).join('\n\n'));
copyFileSync(join(nm, '@xterm/xterm/lib/xterm.js'), join(vendor, 'xterm.js'));
copyFileSync(join(nm, '@xterm/xterm/css/xterm.css'), join(vendor, 'xterm.css'));
copyFileSync(join(nm, '@xterm/addon-fit/lib/addon-fit.js'), join(vendor, 'addon-fit.js'));
copyFileSync(join(nm, '@xterm/addon-search/lib/addon-search.js'), join(vendor, 'addon-search.js'));
copyFileSync(join(nm, '@xterm/addon-web-links/lib/addon-web-links.js'), join(vendor, 'addon-web-links.js'));
// 同步顶级前端文件和图标，避免新增模块或品牌资源漏入离线安装包。
for (const f of readdirSync(join(root, 'src'))) {
  if (/\.(html|css|js|json|png|svg|webp)$/.test(f)) copyFileSync(join(root, 'src', f), join(dist, f));
}
console.log('dist prepared:', dist);
