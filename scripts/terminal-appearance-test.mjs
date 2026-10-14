// Open the real xterm DOM renderer, then inspect actual background layers and
// rendered text. FakeTerm.options alone cannot catch a CSS paint override.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = fileURLToPath(new URL('../', import.meta.url));
const checks = [], errors = [], windows = [];
const source = name => readFileSync(root + 'src/' + name, 'utf8');
function check(name, condition) { assert.ok(condition, name); checks.push(name); console.log('PASS ' + name); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition) {
  const deadline = Date.now() + 2500;
  while (!condition()) { if (Date.now() > deadline) throw new Error('renderer deadline'); await sleep(5); }
}
function makeWindow(saved, render = false) {
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><body><div id="workspace"><main id="main-area"><div id="settings" hidden></div><div id="groups"><section class="group" data-g="0"><div class="term-host"></div></section><section class="group" data-g="1" hidden><div class="term-host"></div></section></div></main></div></body>', {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://tauri.localhost/', virtualConsole: vc,
  });
  const w = dom.window; windows.push(w);
  const add = w.document.addEventListener.bind(w.document);
  // Exercise init explicitly, without running unrelated bootstrap timers/services.
  Object.defineProperty(w.document, 'readyState', { value: 'loading', configurable: true });
  w.document.addEventListener = (type, listener, options) => { if (type !== 'DOMContentLoaded') add(type, listener, options); };
  w.calls = []; let next = 0;
  w.__TAURI__ = { core: { invoke(command, args) {
    w.calls.push([command, args]);
    if (w.interceptor) { const result = w.interceptor(command, args); if (result) return result; }
    return Promise.resolve(command === 'ui_state_load' ? saved && JSON.stringify(saved)
      : command === 'sessions_load' ? [] : command === 'spawn' ? 'appearance-' + ++next : null);
  } }, event: { listen: () => Promise.resolve(() => {}) } };
  w.eval(source('core.js'));
  if (render) {
    for (const css of ['node_modules/@xterm/xterm/css/xterm.css', 'src/style.css', 'src/terminal-appearance.css']) {
      const el = w.document.createElement('style'); el.textContent = readFileSync(root + css, 'utf8'); w.document.head.appendChild(el);
    }
    // The real renderer uses DOM spans; font metrics are deterministic here.
    // CSS colors in the production themes do not require a canvas color parser.
    w.HTMLCanvasElement.prototype.getContext = () => null;
    Object.defineProperty(w.HTMLElement.prototype, 'offsetWidth', { get() { return this.classList.contains('xterm-char-measure-element') ? this.textContent.length * 8 : 640; } });
    Object.defineProperty(w.HTMLElement.prototype, 'offsetHeight', { get() { return this.classList.contains('xterm-char-measure-element') ? 16 : 384; } });
    w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
    w.eval(readFileSync(root + 'node_modules/@xterm/xterm/lib/xterm.js', 'utf8'));
    w.FitAddon = { FitAddon: class { activate() {} fit() {} dispose() {} } };
    w.SearchAddon = { SearchAddon: class { activate() {} dispose() {} } };
    w.WebLinksAddon = { WebLinksAddon: class { activate() {} dispose() {} } };
    w.UI = { status() {}, log() {}, renderOutline() {} };
    for (const module of ['icons.js', 'appearance.js', 'term.js', 'settings.js']) w.eval(source(module));
  }
  return w;
}
const paint = (w, el) => w.getComputedStyle(el).backgroundColor;
const transparent = color => color === 'rgba(0, 0, 0, 0)' || color === 'transparent' || color === '';
const persisted = w => w.calls.filter(([c, a]) => c === 'ui_state_save' && a.name === 'settings').map(([, a]) => JSON.parse(a.value));

try {
  const fresh = makeWindow(null); await fresh.WT.init();
  check('A1 新用户界面与终端背景默认100%', fresh.WT.s.backgroundOpacity === 100 && fresh.WT.s.terminalOpacity === 100);
  const legacy = makeWindow({ backgroundOpacity: 57 }); await legacy.WT.init(); legacy.WT.persistSettings();
  check('A2 旧用户缺省terminalOpacity迁移已有57%，并写入设置', legacy.WT.s.terminalOpacity === 57 && persisted(legacy).at(-1).terminalOpacity === 57);
  const saved = makeWindow({ backgroundOpacity: 77, terminalOpacity: 34 }); await saved.WT.init();
  check('A3 已有独立终端不透明度保持34%，不被界面77%覆盖', saved.WT.s.terminalOpacity === 34 && saved.WT.s.backgroundOpacity === 77);
  const oldDefault = makeWindow({ theme: 'tabby-dark' }); await oldDefault.WT.init();
  check('A4 更早设置未保存任何不透明度时仍默认100%', oldDefault.WT.s.terminalOpacity === 100);

  const w = makeWindow({ backgroundOpacity: 83, terminalOpacity: 60 }, true), T = w.WT, TM = T.term;
  await T.init(); TM.applyTheme('tabby-dark');
  const first = await TM.create(null);
  const write = text => new Promise(resolve => first.term.write(text, resolve));
  await write('plain text \x1b[41mANSI\x1b[0m\r\n');
  await until(() => first.wrap.querySelector('.xterm-rows')?.textContent.includes('plain text'));
  const rows = first.wrap.querySelector('.xterm-rows');
  check('B1 生产create实际打开xterm DOM renderer并渲染文本', !!rows && rows.textContent.includes('ANSI'));
  check('B2 60%终端由完整wrapper实际绘制rgba背景', paint(w, first.wrap) === 'rgba(23, 23, 23, 0.6)');
  check('B3 viewport/screen/rows/xterm不叠加默认背景alpha', ['.xterm', '.xterm-viewport', '.xterm-screen', '.xterm-rows'].every(selector => transparent(paint(w, first.wrap.querySelector(selector)))));
  check('B4 workspace/group/host祖先不垫界面83%的背景', ['#workspace', '#main-area', '#groups', '#groups .group', '.term-host'].every(selector => transparent(paint(w, w.document.querySelector(selector)))));
  check('B5 渲染的默认文字保留不透明前景色且祖先未设置opacity', w.getComputedStyle(rows).color === 'rgb(202, 202, 202)' && [first.wrap, rows, ...first.wrap.querySelectorAll('.xterm, .xterm-screen')].every(el => !el.style.opacity));
  const ansi = [...rows.querySelectorAll('span')].find(el => el.textContent === 'ANSI');
  check('B6 ANSI字符显式背景保持真实色彩，不受整体opacity影响', !!ansi && paint(w, ansi) === 'rgb(255, 97, 90)');

  w.Settings.mount(w.document.querySelector('#settings')); w.Settings.open('appearance');
  const uiSlider = w.document.querySelector('[data-opacity]'), termSlider = w.document.querySelector('[data-terminal-opacity]');
  check('C1 两个独立滑块的名称、范围和保存值明确', uiSlider.getAttribute('aria-label') === '界面背景不透明度' && termSlider.getAttribute('aria-label') === '终端背景不透明度' && uiSlider.value === '83' && termSlider.value === '60' && termSlider.min === '20' && termSlider.max === '100');
  const saves = persisted(w).length;
  termSlider.value = '38'; termSlider.dispatchEvent(new w.Event('input', { bubbles: true }));
  check('C2 终端滑块input即时改变实际背景层，界面83%不变', paint(w, first.wrap) === 'rgba(23, 23, 23, 0.38)' && T.s.backgroundOpacity === 83 && T.s.terminalOpacity === 38);
  check('C3 拖动中仅同步百分比，不逐帧保存', w.document.querySelector('[data-terminal-opacity-value]').textContent === '38%' && persisted(w).length === saves);
  termSlider.dispatchEvent(new w.Event('change', { bubbles: true }));
  check('C4 终端滑块change持久化两个独立不透明度', persisted(w).at(-1).terminalOpacity === 38 && persisted(w).at(-1).backgroundOpacity === 83);
  uiSlider.value = '25'; uiSlider.dispatchEvent(new w.Event('input', { bubbles: true }));
  check('C5 界面滑块input不再改变终端38%的实际背景', T.s.backgroundOpacity === 25 && paint(w, first.wrap) === 'rgba(23, 23, 23, 0.38)');
  w.Settings.close();
  const second = await TM.create(null);
  check('C6 已有与新建终端同步独立38%，包含包装背景和xterm主题', paint(w, second.wrap) === paint(w, first.wrap) && second.term.options.theme.background === first.term.options.theme.background);
  TM.applyTheme('tabby-light');
  check('C7 切换浅色主题后重新绘制背景且保持两个不透明度', paint(w, first.wrap) === 'rgba(255, 255, 255, 0.38)' && paint(w, second.wrap) === paint(w, first.wrap) && T.s.terminalOpacity === 38 && T.s.backgroundOpacity === 25);
  w.Appearance.setTerminalOpacity(100); w.Appearance.setOpacity(100);
  check('C8 两个恢复100%后终端实际绘制实色且浏览器棋盘关闭', paint(w, first.wrap) === 'rgb(255, 255, 255)' && !w.document.documentElement.classList.contains('transparency-preview'));
  w.Appearance.setTerminalOpacity(60);
  check('C9 界面100%时单独降低终端仍开启浏览器透明预览', w.document.documentElement.classList.contains('transparency-preview') && T.s.backgroundOpacity === 100);
  w.Appearance.setTerminalOpacity(-1); check('C10 终端低值钳制20%', T.s.terminalOpacity === 20 && paint(w, second.wrap) === 'rgba(255, 255, 255, 0.2)');
  w.Appearance.setTerminalOpacity(140); check('C11 终端高值钳制100%', T.s.terminalOpacity === 100);
  w.Appearance.setTerminalOpacity('invalid'); check('C12 非数值终端设置恢复100%', T.s.terminalOpacity === 100);

  // A real new terminal can wait for backend authentication while settings change.
  let resolveSpawn;
  w.interceptor = command => command === 'spawn' ? new Promise(resolve => { resolveSpawn = resolve; }) : null;
  const pending = TM.create(null);
  await until(() => !!resolveSpawn);
  w.Appearance.setTerminalOpacity(45); TM.applyTheme('tabby-dark'); resolveSpawn('appearance-delayed');
  const delayed = await pending;
  check('D1 创建期间更改主题/不透明度，连接完成后按最新45%绘制', paint(w, delayed.wrap) === 'rgba(23, 23, 23, 0.45)' && delayed.term.options.theme.background === 'rgba(23,23,23,0.45)');
  const before = paint(w, first.wrap); first._closing = true; w.Appearance.setTerminalOpacity(30);
  check('D2 已关闭中的终端不再访问渲染器或重写背景', paint(w, first.wrap) === before && paint(w, delayed.wrap) === 'rgba(23, 23, 23, 0.3)');
  w.__TAURI__.window = { getCurrentWindow() {} }; w.Appearance.apply();
  check('D3 原生Tauri模式禁用浏览器棋盘，保留终端实际alpha', !w.document.documentElement.classList.contains('transparency-preview') && paint(w, delayed.wrap) === 'rgba(23, 23, 23, 0.3)');

  // Finish xterm's initial asynchronous viewport measurement before fixture teardown.
  await sleep(35);
  for (const tab of Object.values(TM.tabs)) { tab._closing = true; tab.term.dispose(); }
  await sleep(30);
  if (errors.length) console.log(errors);
  check('E1 真实xterm.open/render/切主题/滑块回归没有JS错误', errors.length === 0);
  console.log(`\n${checks.length}/${checks.length} checks passed; ${errors.length} JS errors`);
} finally { for (const w of windows) w.close(); }
