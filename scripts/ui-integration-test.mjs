// hurricaneTerm 0.7.0 Tabby 化集成测试：真实 index.html + 全部前端文件 + Tauri stub
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
window.__invokes = [];
window.__TAURI__ = {
  core: { invoke: (c, a) => { window.__invokes.push([c, a]); return Promise.resolve(
    c === 'ui_state_load' ? null :
    c === 'sessions_load' ? [
      { name: 'lab-server', protocol: 'ssh', host: '10.0.0.5', port: 22, user: 'root', folder: 'lab' },
      { name: '串口控制台', protocol: 'serial', target: '/dev/ttyUSB0', baudRate: 115200 },
    ] :
    (c === 'spawn' || c.startsWith('connect_')) ? 'pty-' + (++ptyN) :
    c === 'complete_input' ? { items: [], start: 0 } :
    c === 'fs_realpath' ? (a?.path || '/home/local') :
    c === 'sftp_realpath' ? (a?.path === '.' || !a?.path ? '/home/root' : a.path) :
    c === 'fs_list' ? [
      { name: 'src', is_dir: true, path: './src', size: 0 },
      { name: 'README.md', is_dir: false, path: './README.md', size: 4213 },
    ] :
    c === 'sftp_list' ? [
      { name: 'etc', is_dir: true, path: './etc', size: 0 },
      { name: 'app.log', is_dir: false, path: './app.log', size: 90210 },
    ] : null); } },
  event: { listen: () => Promise.resolve(() => {}) },
};
class FakeTerm {
  constructor() { this.cols = 80; this.rows = 24; this.options = {}; this.buffer = { active: { baseY: 0, cursorY: 0 } }; }
  open(host) { this._input = document.createElement('textarea'); host.appendChild(this._input); }
  focus() { this._input?.focus(); }
  loadAddon() {} write() {} dispose() {} resize() {} selectAll() {} scrollToTop() {} scrollToBottom() {}
  getSelection() { return ''; } clearSelection() {} scrollToLine() {}
  onData(cb) { this._onData = cb; } onResize() {} onTitleChange() {}
  onSelectionChange(cb) { this._onSel = cb; } input(d) { this._onData && this._onData(d); }
  registerMarker() { return {}; } registerDecoration() { return { onRender() {}, dispose() {} }; }
  attachCustomKeyEventHandler(cb) { this._ckeh = cb; }
}
window.Terminal = FakeTerm;
window.FitAddon = { FitAddon: class { fit() {} } };
window.SearchAddon = { SearchAddon: class { findNext() { return true; } findPrevious() { return true; } } };
window.WebLinksAddon = { WebLinksAddon: class {} };
window.Element.prototype.scrollIntoView = function () {};

// 阻止 core.js 立即 boot：伪装 loading，手动派发 DOMContentLoaded
Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
window.addEventListener('error', (e) => errors.push('window: ' + e.message));

// ---- 按 index.html 顺序加载真实脚本 ----
for (const f of ['core.js', 'icons.js', 'titlebar.js', 'tabbar.js', 'actbar.js', 'profiles.js', 'home.js', 'settings.js', 'term.js', 'sftp.js', 'ui.js']) {
  try { window.eval(readFileSync(SRC + '/' + f, 'utf8')); }
  catch (e) { errors.push(`load ${f}: ${e.message}`); }
}
document.dispatchEvent(new window.Event('DOMContentLoaded'));
const T = window.WT; const TM = T.term; const UI = window.UI;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const results = [];
const ok = (name, cond) => results.push([cond ? 'PASS' : 'FAIL', name]);

async function flush(n = 12) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5)); }

/* ============ A. 老式外壳已拆除（回归护栏） ============ */
await flush();
ok('A1 无老式菜单栏 #menubar', !$('#menubar'));
ok('A2 无老式工具栏 #toolbar', !$('#toolbar'));
ok('A3 无 <dialog> 弹窗', $$('dialog').length === 0);
ok('A4 无老式 dock 文字选项卡 #dock-tabs', !$('#dock-tabs'));
ok('A5 无边框标题栏存在', !!$('#titlebar') && $$('.tb-drag').length >= 1);
ok('A6 非 Tauri 环境下窗口控制自动隐藏', $('#tb-winctl').hidden === true);
ok('A7 标题栏动作区已建按钮', $$('#tb-actions .tb-btn').length >= 4);

/* ============ B. 活动栏 ============ */
ok('B1 活动栏挂载', $$('#actbar .ab-btn').length >= 9);
ok('B2 侧栏默认收起（Tabby 行为）', $('#dock').hidden === true && T.s.dockVisible === false);
const explorerBtn = $('#actbar .ab-btn[data-pane="explorer"]');
explorerBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush();
ok('B3 点图标 → 侧栏展开且窗格高亮', $('#dock').hidden === false && explorerBtn.classList.contains('on'));
ok('B4 会话窗格渲染出机器', $('#dock-body').textContent.includes('lab-server'));
explorerBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush();
ok('B5 再点同一图标 → 收起', $('#dock').hidden === true);

/* ============ C. 主页 ============ */
ok('C1 Home 可见（hidden 已清）', !$('#home').hidden && $('#home').style.display === 'flex');
ok('C2 快速连接条存在', !!$('#home').querySelector('select') && !!$('#home').querySelector('input'));
ok('C3 Home 机器列表渲染', $('#home').textContent.includes('lab-server'));
ok('C4 emoji 图标已换成内联 SVG', !!$('#home .ht-home-ico svg') && !$('#home').textContent.includes('🔒'));

/* ============ D. 设置页（取代 dialog） ============ */
window.Settings.open('triggers');
await flush();
ok('D1 设置页打开', $('#settings').hidden === false && window.Settings.isOpen());
ok('D2 左导航 6 分区', $$('#settings .st-nav-i').length === 6);
ok('D3 触发器分区渲染', $('#settings').textContent.includes('触发器') && !!$('#settings [data-tradd]'));
ok('D4 设置页打开时主页让位', $('#home').hidden === true);
window.Settings.open('appearance');
await flush();
ok('D5 外观分区含主题卡', $$('#settings .st-theme').length === Object.keys(TM.THEMES).length);
ok('D6 外观分区含状态栏开关', !!$('#settings [data-toggle="statusBar"]'));

// 默认隐藏状态栏，开启 / 再关闭均立即生效
ok('D6b 状态栏默认关闭，终端铺满窗口', T.s.statusBar === false && document.body.classList.contains('no-status'));
$('#settings [data-toggle="statusBar"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush();
ok('D7 状态栏可开启', !document.body.classList.contains('no-status') && T.s.statusBar === true);
$('#settings [data-toggle="statusBar"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush();
ok('D8 状态栏可关闭', document.body.classList.contains('no-status') && T.s.statusBar === false);

// 触发器增删（原 #dlg-triggers 能力必须无损失迁移）
window.Settings.open('triggers');
await flush();
$('#settings [data-tr="name"]').value = 't-err';
$('#settings [data-tr="pattern"]').value = 'error|failed';
$('#settings [data-tr="action"]').value = 'highlight';
$('#settings [data-tradd]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush();
ok('D9 设置页内新增触发器', T.s.triggers.length === 1 && T.s.triggers[0].pattern === 'error|failed');
$('#settings [data-trdel="0"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush();
ok('D10 设置页内删除触发器', T.s.triggers.length === 0);

window.Settings.close();
await flush();
ok('D11 关闭设置页 → 无终端时回主页', $('#settings').hidden === true && !$('#home').hidden);

/* ============ E. 标签页 ============ */
const sess = T.s.sessions.find((s) => s.name === 'lab-server');
const tab1 = await TM.create(sess);
await flush();
ok('E1 标签创建', !!tab1 && TM.order.length === 1);
ok('E2 Home 已隐藏', $('#home').hidden);
ok('E3 标签条含标题', $('.ht-tabbar').textContent.includes('lab-server'));
ok('E4 标签图标为 SVG', !!$('.ht-tab .ht-ico svg') && !$('.ht-tabbar').textContent.includes('🔒'));
ok('E5 lastUsed 回写', typeof sess.lastUsed === 'number' && sess.lastUsed > 0);
ok('E6 聚焦窗格描边', $('.group[data-g="0"]').classList.contains('focused'));
ok('E7 窗口标题跟随标签', document.title.includes('lab-server'));

const tab2 = await TM.create(null);
await flush();
ok('E8 两标签', TM.order.length === 2);
TM.moveTab(tab2.id, 0);
ok('E9 moveTab 前置', TM.order[0] === tab2.id);
TM.moveTab(tab2.id, TM.order.length);
ok('E10 moveTab 尾部不越界', TM.order[TM.order.length - 1] === tab2.id);

TM.togglePin(tab1.id);
await flush();
const shown = $$('.ht-tabbar .ht-tab').map((e) => e.textContent);
ok('E11 pinned 前置', shown.length >= 1 && shown[0].includes('lab-server'));
ok('E12 pinned 图标为 SVG', !!$('.ht-tab .ht-pin svg'));

/* ============ F. 右键菜单 ============ */
const tabEl = $('.ht-tabbar .ht-tab');
tabEl.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 50 }));
await flush();
const menu = $('.ht-menu');
ok('F1 右键菜单出现', !!menu);
ok('F2 菜单含分屏/固定/关闭其他', menu.textContent.includes('分屏') && menu.textContent.includes('固定标签') && menu.textContent.includes('关闭其他标签'));
ok('F3 菜单项带 SVG 图标', !!menu.querySelector('.mi .mic svg'));
ok('F4 菜单色板已渲染', $$('.ht-menu .swatches .sw').length >= 9);
window.TabBar.closeMenu();
await flush();
ok('F5 菜单可关闭', !$('.ht-menu') && window.TabBar.menuOpen() === false);

/* ============ G. 机器管理 ============ */
window.Profiles.openManager();
await flush();
const ov = $('.ht-pm-overlay');
ok('G1 管理器打开', !!ov && !ov.hidden);
ok('G2 列表含机器', ov.textContent.includes('lab-server') && ov.textContent.includes('串口控制台'));
ok('G3 协议图标为 SVG', !!ov.querySelector('.ht-pm-ico svg'));
ov.querySelector('.ht-pm-x').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush();
ok('G4 管理器可关闭', ov.hidden === true);

/* ============ H. 分屏 ============ */
const splitSource = TM.activeTab();
const visibleInGroup = (g) => Array.from(TM.hostEl(g).querySelectorAll('.term-wrap'))
  .filter((wrap) => !TM.groupEl(g).hidden && wrap.style.display !== 'none');
await TM.splitActive('right');
await flush();
const splitCopy = TM.activeTab();
ok('H1 分屏后 3 标签', TM.order.length === 3);
ok('H2 group1 可见', !$('.group[data-g="1"]').hidden);
ok('H3 分屏分隔条出现', $('#gutter').hidden === false);
ok('H3b 向右分屏原终端在左、副本在右且都可见', splitSource.group === 0 && splitCopy.group === 1
  && visibleInGroup(0)[0] === splitSource.wrap && visibleInGroup(1)[0] === splitCopy.wrap);
const gBefore = TM.activeTab().group;
TM.focusNextGroup();
await flush();
ok('H4 窗格间焦点轮换', TM.activeTab().group !== gBefore);
ok('H4b 焦点切换保留两侧终端', visibleInGroup(0).length === 1 && visibleInGroup(1).length === 1);
TM.activate(splitSource.id);
const sameGroupTab = TM.order.map((id) => TM.tabs[id]).find((tab) => tab.group === 0 && tab.id !== splitSource.id);
TM.activate(sameGroupTab.id);
ok('H4c 同组切换只替换本组终端，另一侧保持副本', splitSource.wrap.style.display === 'none'
  && visibleInGroup(0)[0] === sameGroupTab.wrap && visibleInGroup(1)[0] === splitCopy.wrap);
const extraSplitTab = await TM.create(null, { group: 0 });
TM.activate(splitCopy.id);
await TM.close(extraSplitTab.id);
ok('H4d 关闭非聚焦组可见标签后该组补选剩余终端', TM.active === splitCopy.id
  && visibleInGroup(0).length === 1 && visibleInGroup(1)[0] === splitCopy.wrap);
TM.unsplit();
await flush();
ok('H5 取消分屏后分隔条隐藏', $('#gutter').hidden === true && $('.group[data-g="1"]').hidden);
ok('H5b 取消分屏后所有会话归入0组且仅显示活动终端', TM.order.every((id) => TM.tabs[id].group === 0)
  && visibleInGroup(0).length === 1 && visibleInGroup(0)[0] === TM.activeTab().wrap);
await TM.close(splitCopy.id);

// 保留一个更新但隐藏的同组标签，关闭另一侧时仍应回到原来可见的终端。
await TM.create(null);
TM.activate(splitSource.id);
for (const direction of ['right', 'down', 'left', 'up']) {
  const source = TM.activeTab();
  await TM.splitActive(direction);
  await flush();
  const copy = TM.activeTab();
  const before = direction === 'left' || direction === 'up';
  ok(`H ${direction} 原终端与新终端位于正确两侧`, source.group === (before ? 1 : 0)
    && copy.group === (before ? 0 : 1)
    && source.wrap.parentElement === TM.hostEl(source.group) && copy.wrap.parentElement === TM.hostEl(copy.group)
    && $('#groups').dataset.dir === (direction === 'left' || direction === 'right' ? 'h' : 'v'));
  ok(`H ${direction} 两个终端 DOM 同时可见`, visibleInGroup(0).length === 1 && visibleInGroup(1).length === 1
    && source.wrap.style.display === 'block' && copy.wrap.style.display === 'block');
  if (!before) {
    await TM.close(copy.id);
    ok(`H ${direction} 关闭1组最后标签恢复原终端单屏`, TM.splitDir === null && TM.groupEl(1).hidden
      && visibleInGroup(0)[0] === source.wrap && TM.active === source.id);
  } else {
    TM.unsplit();
    await TM.close(copy.id);
  }
}

// 对称边界：关闭0组的最后一个标签，剩下的1组终端应回到单屏0组。
const leftSource = TM.activeTab();
await TM.splitActive('left');
const leftCopy = TM.activeTab();
TM.activate(leftSource.id);
for (const id of [...TM.order]) if (TM.tabs[id].group === 0 && id !== leftCopy.id) await TM.close(id);
await TM.close(leftCopy.id);
ok('H6 关闭0组最后标签同样取消分屏并保留另一侧终端', TM.splitDir === null && TM.groupEl(1).hidden
  && leftSource.group === 0 && leftSource.wrap.parentElement === TM.hostEl(0)
  && visibleInGroup(0)[0] === leftSource.wrap && TM.active === leftSource.id);

// 副本连接失败不能留下一个空的分屏组。
const invokeBeforeSplitFailure = window.__TAURI__.core.invoke;
window.__TAURI__.core.invoke = (command, args) => command === 'spawn'
  ? Promise.reject(new Error('split connection failed')) : invokeBeforeSplitFailure(command, args);
try { await TM.splitActive('down'); }
finally { window.__TAURI__.core.invoke = invokeBeforeSplitFailure; }
ok('H7 首次分屏连接失败恢复单屏且原终端可见', TM.splitDir === null && TM.groupEl(1).hidden
  && visibleInGroup(0)[0] === leftSource.wrap && TM.active === leftSource.id);

/* ============ I. 命令面板 ============ */
UI.openPalette();
await flush();
ok('I1 面板打开', $('#palette').hidden === false);
ok('I2 命令分组标题', $$('#palette-list .pg').length >= 5);
ok('I3 命令条目数（菜单能力已迁入）', $$('#palette-list .pitem').length >= 30);
UI.filterPalette('触发器');
await flush();
ok('I4 过滤生效', $$('#palette-list .pitem').length >= 1 && $('#palette-list').textContent.includes('触发器'));
UI.filterPalette('');
UI.closePalette();
await flush();
ok('I5 面板可关闭', $('#palette').hidden === true);

/* ============ J. 浮动搜索 + Toast + 主题 ============ */
UI.openSearch();
await flush();
ok('J1 浮动搜索卡打开（非整条 searchbar）', !$('#search-float').hidden && !$('#searchbar'));
$('#search-input').value = 'root';
UI.doSearch(true);
ok('J2 搜索反馈计数', $('#search-count').textContent.length > 0);
UI.closeSearch();
ok('J3 搜索卡可关闭', $('#search-float').hidden === true);

$('#toasts').textContent = '';
UI.toast('测试提示', 50);
ok('J4 Toast 走左下角堆叠容器', $$('#toasts .toast').length === 1 && $('#toasts').textContent.includes('测试提示'));

const before = T.s.theme;
TM.applyTheme('tabby-light');
await flush();
ok('J5 可切到 Tabby 浅色主题', T.s.theme === 'tabby-light' && before === 'tabby-dark');
ok('J6 主题写入 CSS 变量', document.documentElement.style.getPropertyValue('--accent') === '#0e9f6e');
ok('J7 --term-bg 驱动标签/主区连体', document.documentElement.style.getPropertyValue('--term-bg') === '#ffffff');
TM.applyTheme('tabby-dark');
await flush();
ok('J8 切回深色', T.s.theme === 'tabby-dark');

/* ============ K. 全关 → 主页回归 ============ */
for (const id of [...TM.order]) await TM.close(id);
await flush();
ok('K1 全关后 Home 重现', !$('#home').hidden);
ok('K2 无标签时显示品牌位', !!$('.ht-brand'));

/* ============ L. 实机反馈修复 + 内置输出高亮 ============ */
TM.applyTheme('tabby-light');
ok('L1 浅色主题写入 color-scheme（原生下拉框跟随）', document.documentElement.style.getPropertyValue('--color-scheme') === 'light');
TM.applyTheme('tabby-dark');
ok('L2 深色主题 color-scheme=dark', document.documentElement.style.getPropertyValue('--color-scheme') === 'dark');
ok('L3 模式色带 class（默认远程）', document.body.classList.contains('mode-remote'));
UI.setMode('Local');
ok('L4 切本地后色带切换', document.body.classList.contains('mode-local') && !document.body.classList.contains('mode-remote'));
UI.setMode('Remote');
ok('L5 内置高亮默认开启且 4 类规则', T.s.builtinHighlight !== false && TM.HIGHLIGHT_RULES.length === 4);
const tabH = await TM.create(null);
await flush();
tabH.term._onData('kubectl get pods\r');
await flush();
ok('L6 大纲记录真实命令文本', tabH.outline.length === 1 && tabH.outline[0].text === 'kubectl get pods');
TM.runHighlights(tabH, 'default  worker-batch-9x2  0/1  Error  7  41m');
ok('L7 高亮命中生成行装饰', (tabH._hls || []).length >= 1);
TM.runHighlights(tabH, '192.168.1.1:22 open');
ok('L8 地址类规则命中', (tabH._hls || []).length >= 2);
const before9 = (tabH._hls || []).length;
TM.runHighlights(tabH, 'E'.repeat(200) + ' Error ' + 'x'.repeat(200));
ok('L9 超宽换行行盖满全部视觉行（cols=80 → 6 行）', (tabH._hls || []).length - before9 === 6);
await TM.close(tabH.id);
await flush();

/* ============ M. 0.7.3 批次：图标/布局/配色/PuTTY 习惯/更新检查 ============ */
const exIco = $('#actbar .ab-btn[data-pane="explorer"]').innerHTML;
const pfIco = $('#actbar .ab-btn.ab-profiles').innerHTML;
ok('M1 会话与机器管理图标不再重复', exIco !== pfIco && exIco.includes('svg') && pfIco.includes('svg'));
ok('M2 新建按钮紧跟标签末尾', $('.ht-tabbar').firstElementChild.classList.contains('ht-tabs') && $('.ht-tabbar').lastElementChild.classList.contains('ht-actions') && !!$('.ht-actions .ht-plus'));
ok('M3 强调色为玉绿（非蓝）', document.documentElement.style.getPropertyValue('--accent') === '#3ecf8e');
ok('M4 PuTTY 习惯默认开：选中复制 + 右键粘贴', T.s.copyOnSelect !== false && T.s.rightClickPaste !== false);
const tabM = await TM.create(sess);
await flush();
ok('M5 SSH 连接后侧栏提供独立文件管理入口', T.s.dockPane === 'filer' && !$('#dock').hidden && !!$('#open-sftp-panel'));
$('#open-sftp-panel').click();
await flush();
ok('M6 独立 SFTP 面板挂载双栏且列出远端家目录', window.SftpPanel.isOpen()
  && $$('#sftp-panel .sftp-pane').length === 2
  && $('#sftp-panel [data-side="remote"] .sftp-path').value === '/home/root'
  && $('#sftp-panel [data-side="remote"]').textContent.includes('app.log'));
window.SftpPanel.close();
// Tab 无候选时交还 shell
window.__invokes.length = 0;
const ckeh = tabM.term._ckeh;
ok('M7 xterm 自定义键处理已挂载', typeof ckeh === 'function');
if (ckeh) { ckeh({ type: 'keydown', key: 'Tab', shiftKey: false, ctrlKey: false, preventDefault() {} }); }
await flush();
ok('M8 Tab 无候选时把 \t 写回 pty（shell 补全不被吞）', window.__invokes.some(([c, a]) => c === 'write' && a && a.data === '\t'));
// 更新检查：无网络环境应静默失败不抛错
const up = await T.checkUpdate(false);
ok('M9 更新检查离线静默失败', up === null && !!T.s.updateInfo === false || up === null);
await TM.close(tabM.id);
await flush();

/* ============ N. 会话落盘日志（PuTTY Logging） ============ */
T.s.sessionLog = true;
window.__invokes.length = 0;
const tabN = await TM.create(null);
await flush();
ok('N1 开关开启后新会话调用 session_log_start', window.__invokes.some(([c]) => c === 'session_log_start') && tabN.logging === true);
tabN.logBuf = 'hello log\r\n';
window.__invokes.length = 0;
T.flushLogs(tabN);
await flush();
ok('N2 缓冲按块刷盘 session_log_append', window.__invokes.some(([c, a]) => c === 'session_log_append' && a.data === 'hello log\r\n'));
window.__invokes.length = 0;
await TM.close(tabN.id);
await flush();
ok('N3 关闭会话时停止日志', window.__invokes.some(([c]) => c === 'session_log_stop'));
T.s.sessionLog = false;

/* ============ O. 跳板机参数透传 ============ */
window.__invokes.length = 0;
const jumpSess = { name: 'via-bastion', protocol: 'ssh', host: '10.9.0.7', port: 22, user: 'dev', jumpHost: 'ops@bastion.example:2222' };
const tabO = await TM.create(jumpSess);
await flush();
const jc = window.__invokes.find(([c]) => c === 'connect_ssh');
ok('O1 connect_ssh 透传 jumpHost', !!jc && jc[1].jumpHost === 'ops@bastion.example:2222');
await TM.close(tabO.id);
await flush();

/* ============ P. 所有主题 + 原生/动态下拉框主题回归 ============ */
const themeTokens = Object.keys(TM.THEMES['tabby-dark'].vars);
for (const [name, theme] of Object.entries(TM.THEMES)) {
  TM.applyTheme(name);
  ok(`P ${name} 每次切换写入完整有效令牌`,
    themeTokens.length === Object.keys(theme.vars).length && themeTokens.every((key) => {
      const value = document.documentElement.style.getPropertyValue(key);
      return !!value && value !== 'undefined' && value === theme.vars[key];
    }));
  ok(`P ${name} 原生控件深浅模式同步`,
    document.documentElement.style.colorScheme === theme.vars['--color-scheme']);
}
// 先亮后暗：accent-soft 在其它内置主题也必须重新生成，不能留下 Tabby 浅色的绿。
TM.applyTheme('tabby-light');
const lightAccentSoft = document.documentElement.style.getPropertyValue('--accent-soft');
TM.applyTheme('default');
ok('P1 非 Tabby 主题强调色透明令牌没有 undefined 或上一个主题残留',
  document.documentElement.style.getPropertyValue('--accent-soft') !== lightAccentSoft
  && document.documentElement.style.getPropertyValue('--accent-soft').startsWith('rgba(61,174,233,'));

const themeStyle = document.createElement('style');
themeStyle.textContent = readFileSync(SRC + '/style.css', 'utf8');
document.head.appendChild(themeStyle);
const themeRules = Array.from(themeStyle.sheet.cssRules);
const themeRule = (selector) => themeRules.find((rule) => rule.selectorText === selector)?.style;
ok('P2 普通输入和下拉框使用主主题文字/底色',
  themeRule('input, select, textarea')?.getPropertyValue('color') === 'var(--fg)'
  && themeRule('input, select, textarea')?.getPropertyValue('background') === 'var(--input-bg)');
ok('P3 option/optgroup 弹层显式跟随主题',
  themeRule('option, optgroup')?.getPropertyValue('color') === 'var(--fg)'
  && themeRule('option, optgroup')?.getPropertyValue('background') === 'var(--input-bg)');
ok('P4 placeholder 跟随主题而非硬编码白色',
  themeRule('input::placeholder, textarea::placeholder')?.getPropertyValue('color') === 'var(--placeholder)');

window.Profiles.edit(sess);
await flush();
const profileProtocol = $('.ht-pm-field select[data-k="protocol"]');
const profileProtocolValue = profileProtocol.value;
const profileRule = Array.from($('#ht-pm-style').sheet.cssRules)
  .find((rule) => rule.selectorText === '.ht-pm-field input, .ht-pm-field select')?.style;
ok('P5 动态机器管理下拉框使用公共控件主题',
  profileRule?.getPropertyValue('background') === 'var(--input-bg)'
  && profileRule?.getPropertyValue('color') === 'var(--fg)');
TM.applyTheme('tabby-light');
ok('P6 已打开的动态下拉框切浅色时不重建或丢失选择',
  $('.ht-pm-field select[data-k="protocol"]') === profileProtocol
  && profileProtocol.value === profileProtocolValue
  && document.documentElement.style.colorScheme === 'light');
TM.applyTheme('tabby-dark');
ok('P7 下拉框切回深色时不保留浅色控件令牌',
  document.documentElement.style.colorScheme === 'dark'
  && document.documentElement.style.getPropertyValue('--input-bg') === TM.THEMES['tabby-dark'].vars['--input-bg']);
$('.ht-pm-x').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

/* ============ Q. Tabby 顶栏与完整页面回归 ============ */
ok('Q1 侧栏工具包含在按需展开的 Dock 中', $('#actbar').parentElement === $('#dock'));
ok('Q2 右上角设置是最后一个应用动作且无侧栏重复入口',
  $('#tb-actions').lastElementChild.classList.contains('tb-settings') && !$('.ab-settings'));
$('#tb-actions .tb-settings').click();
await flush();
ok('Q3 右上角设置按钮能打开页面并同步高亮', window.Settings.isOpen()
  && $('.tb-settings').classList.contains('on') && $('.tb-settings').getAttribute('aria-pressed') === 'true');
$('.st-close').click();
await flush();
ok('Q4 设置页关闭按钮同步取消右上角高亮', !window.Settings.isOpen()
  && !$('.tb-settings').classList.contains('on') && $('.tb-settings').getAttribute('aria-pressed') === 'false');
window.Settings.open();
window.Home.show();
ok('Q5 打开主页时设置覆盖层关闭', !window.Settings.isOpen() && !$('#home').hidden);
const orderBeforePlus = TM.order.length;
$('.ht-plus').click();
await flush();
ok('Q6 标签末尾加号实际新建并激活本地终端', TM.order.length === orderBeforePlus + 1
  && TM.activeTab().session === null && $('#home').hidden);
ok('Q7 标签区域有键盘导航语义', $('.ht-tabs').getAttribute('role') === 'tablist'
  && $('.ht-tab.ht-active').getAttribute('aria-selected') === 'true');
const previousTab = await TM.create(null);
await flush();
const previousActive = TM.active;
$('.ht-tab.ht-active').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
await flush();
ok('Q8 左箭头切换标签并聚焦新标签', TM.active !== previousActive
  && document.activeElement === $('.ht-tab.ht-active'));
$('.ht-split').click();
await flush();
ok('Q9 顶栏分屏入口保留两个方向', $('.ht-menu').textContent.includes('向右分屏')
  && $('.ht-menu').textContent.includes('向下分屏'));
window.TabBar.closeMenu();
if (T.s.dockVisible) UI.toggleDock();
$('.tb-sidebar').click();
ok('Q10 顶栏侧栏入口展开并同步按钮状态', !$('#dock').hidden
  && $('.tb-sidebar').getAttribute('aria-expanded') === 'true');
$('.ab-collapse').click();
ok('Q11 收起侧栏恢复完整终端视图', $('#dock').hidden
  && $('.tb-sidebar').getAttribute('aria-expanded') === 'false');
await TM.close(previousTab.id);
ok('Q12 主页具备本地、机器、设置快捷入口', $$('#home .ht-home-action').length === 3);
window.Profiles.openManager();
ok('Q13 机器管理作为主区全页视图展示', $('.ht-pm-overlay').parentElement === $('#main-area') && window.Profiles.isOpen());
TM.activate(TM.active);
await flush();
ok('Q14 切回终端标签关闭机器编辑视图', !window.Profiles.isOpen() && $('.ht-pm-overlay').hidden);
window.Profiles.openManager();
window.Settings.open('terminal');
ok('Q15 打开设置时关闭机器编辑视图', !window.Profiles.isOpen() && window.Settings.isOpen());
window.Settings.close();

/* ============ R. 全页机器管理退出后的数据与焦点回归 ============ */
window.Home.show();
window.Profiles.edit(null);
$('.ht-pm-form [data-k="name"]').value = 'ui-regression-machine';
$('.ht-pm-form [data-k="host"]').value = 'regression.example';
$('.ht-pm-save').click();
await flush();
$('.ht-pm-x').click();
ok('R1 保存新机器后返回主页立即更新机器列表', !$('#home').hidden
  && $('#home').textContent.includes('ui-regression-machine'));

window.Settings.open('profiles');
UI.setDockPane('explorer');
const savedMachine = T.s.sessions.find((s) => s.name === 'ui-regression-machine');
window.Profiles.edit(savedMachine);
$('.ht-pm-form [data-k="name"]').value = 'ui-regression-renamed';
$('.ht-pm-save').click();
await flush();
$('.ht-pm-x').click();
ok('R2 修改机器后返回设置立即更新名称', window.Settings.isOpen()
  && !!$('#settings [data-edit="ui-regression-renamed"]')
  && !$('#settings [data-edit="ui-regression-machine"]'));
ok('R3 退出管理器同步刷新可见侧栏机器列表', !$('#dock').hidden
  && $('#dock-body').textContent.includes('ui-regression-renamed')
  && !$('#dock-body').textContent.includes('ui-regression-machine'));

window.Settings.close();
UI.toggleDock();
TM.activate(TM.active);
await flush();
const terminalInput = TM.activeTab().term._input;
window.Profiles.openManager();
$('.ht-pm-overlay').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
ok('R4 Esc 关闭机器管理后恢复活动终端键盘焦点', !window.Profiles.isOpen()
  && document.activeElement === terminalInput);
$('.tb-sidebar').focus();
window.Profiles.close();
ok('R5 重复关闭已隐藏管理器不会抢走当前控件焦点', document.activeElement === $('.tb-sidebar'));

// 报告
console.log(results.map(([s, n]) => `${s} ${n}`).join('\n'));
if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
console.log(`\n合计 ${results.filter((r) => r[0] === 'PASS').length}/${results.length} PASS，JS 错误 ${errors.length} 个`);
process.exit(results.every((r) => r[0] === 'PASS') && errors.length === 0 ? 0 : 1);
