// hurricaneTerm 0.6.0 Tabby 化集成测试：真实 index.html + 5 个前端文件 + Tauri stub
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));

const dom = new JSDOM(readFileSync(SRC + '/index.html', 'utf8'), {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://tauri.localhost/', virtualConsole: vc,
});
const { window } = dom;
const { document } = window;

// ---- 环境 stub ----
let ptyN = 0;
window.__TAURI__ = {
  core: { invoke: (c, a) => Promise.resolve(
    c === 'ui_state_load' ? null :
    c === 'sessions_load' ? [
      { name: 'lab-server', protocol: 'ssh', host: '10.0.0.5', port: 22, user: 'root', folder: 'lab' },
      { name: '串口控制台', protocol: 'serial', target: '/dev/ttyUSB0', baudRate: 115200 },
    ] :
    (c === 'spawn' || c.startsWith('connect_')) ? 'pty-' + (++ptyN) :
    c === 'complete_input' ? { items: [], start: 0 } : null) },
  event: { listen: () => Promise.resolve(() => {}) },
};
class FakeTerm {
  constructor() { this.cols = 80; this.rows = 24; this.options = {}; this.buffer = { active: { baseY: 0, cursorY: 0 } }; }
  open() {} loadAddon() {} write() {} focus() {} dispose() {} resize() {}
  onData(cb) { this._onData = cb; } onResize() {} onTitleChange() {}
  registerMarker() { return {}; } registerDecoration() { return { onRender() {}, dispose() {} }; }
  attachCustomKeyEventHandler() {}
}
window.Terminal = FakeTerm;
window.FitAddon = { FitAddon: class { fit() {} } };
window.SearchAddon = { SearchAddon: class { findNext() {} findPrevious() {} } };
window.WebLinksAddon = { WebLinksAddon: class {} };
window.Element.prototype.scrollIntoView = function () {};

// 阻止 core.js 立即 boot：伪装 loading，手动派发 DOMContentLoaded
Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
window.addEventListener('error', (e) => errors.push('window: ' + e.message));

// ---- 按 index.html 顺序加载真实脚本 ----
for (const f of ['core.js', 'tabbar.js', 'profiles.js', 'home.js', 'term.js', 'ui.js']) {
  try { window.eval(readFileSync(SRC + '/' + f, 'utf8')); }
  catch (e) { errors.push(`load ${f}: ${e.message}`); }
}
document.dispatchEvent(new window.Event('DOMContentLoaded'));
const T = window.WT; const TM = T.term; const $ = (s) => document.querySelector(s);
const results = [];
const ok = (name, cond) => results.push([cond ? 'PASS' : 'FAIL', name]);

async function flush(n = 12) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5)); }

// A. boot 后：TabBar/Home 挂载，无标签 → Home 可见
await flush();
ok('A1 TabBar 挂载', !!$('.ht-tabbar'));
ok('A2 Home 可见（hidden 已清）', !$('#home').hidden && $('#home').style.display === 'flex');
ok('A3 快速连接条存在', !!$('#home').querySelector('select') && !!$('#home').querySelector('input'));
ok('A4 Home 机器列表渲染', $('#home').textContent.includes('lab-server') && $('#home').textContent.includes('🔒'));

// B. 创建 SSH 标签 → Home 隐藏、标签条出现
const sess = T.s.sessions.find((s) => s.name === 'lab-server');
const tab1 = await TM.create(sess);
await flush();
ok('B1 标签创建', !!tab1 && TM.order.length === 1);
ok('B2 Home 已隐藏', $('#home').hidden);
ok('B3 标签条含标题+图标', $('.ht-tabbar').textContent.includes('lab-server') && $('.ht-tabbar').textContent.includes('🔒'));
ok('B4 lastUsed 回写', typeof sess.lastUsed === 'number' && sess.lastUsed > 0);

// C. 第二标签 + moveTab 契约（先移除再插入，to 可为剩余长度）
const tab2 = await TM.create(null);
await flush();
ok('C1 两标签', TM.order.length === 2);
TM.moveTab(tab2.id, 0);
ok('C2 moveTab 前置', TM.order[0] === tab2.id);
TM.moveTab(tab2.id, TM.order.length); // 尾部（修复过的 clamp）
ok('C3 moveTab 尾部不越界', TM.order[TM.order.length - 1] === tab2.id);

// D. pinned 前置显示序
TM.togglePin(tab1.id);
await flush();
const shown = [...document.querySelectorAll('.ht-tabbar .ht-tab')].map((e) => e.textContent);
ok('D1 pinned 前置', shown.length >= 1 && shown[0].includes('lab-server'));

// E. 右键菜单
const tabEl = document.querySelector('.ht-tabbar .ht-tab');
tabEl.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 50 }));
await flush();
const menu = document.querySelector('.ht-menu');
ok('E1 右键菜单出现', !!menu);
ok('E2 菜单含分屏/关闭其他/固定', menu && menu.textContent.includes('分屏') && menu.textContent.includes('关闭其他') && menu.textContent.includes('固定标签'));

// F. Profiles 管理器
window.Profiles.openManager();
await flush();
const ov = document.querySelector('.ht-pm-overlay');
ok('F1 管理器打开', !!ov && !ov.hidden);
ok('F2 列表含机器', ov && ov.textContent.includes('lab-server') && ov.textContent.includes('串口控制台'));

// G. splitActive 分屏
await TM.splitActive('right');
await flush();
ok('G1 分屏后 3 标签', TM.order.length === 3);
ok('G2 group1 可见', !document.querySelector('.group[data-g="1"]').hidden);

// H. 关闭全部 → Home 回来
for (const id of [...TM.order]) await TM.close(id);
await flush();
ok('H1 全关后 Home 重现', !$('#home').hidden);

// 报告
console.log(results.map(([s, n]) => `${s} ${n}`).join('\n'));
if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
console.log(`\n合计 ${results.filter(r => r[0] === 'PASS').length}/${results.length} PASS，JS 错误 ${errors.length} 个`);
process.exit(results.every((r) => r[0] === 'PASS') && errors.length === 0 ? 0 : 1);
