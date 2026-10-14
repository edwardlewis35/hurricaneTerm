import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const source = readFileSync(src + 'titlebar.js', 'utf8');
const css = readFileSync(src + 'mac-window-controls.css', 'utf8');
const results = [], errors = [];
const check = (label, value) => results.push([!!value, label]);
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function fixture(platform, native = true) {
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <header id="titlebar"><div id="mac-lights">
      <span class="ml ml-close" data-act="close" title="关闭"></span>
      <span class="ml ml-min" data-act="minimize" title="最小化"></span>
      <span class="ml ml-max" data-act="maximize" title="最大化"></span>
    </div><div id="blank"></div><div id="tb-actions"></div><div id="tb-winctl"></div></header>
  </body></html>`, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window, d = w.document, calls = [];
  Object.defineProperty(w.navigator, 'userAgent', { value: platform });
  w.WT = { s: { dockVisible: false } };
  w.Icons = { svg: () => '<svg aria-hidden="true"></svg>' };
  w.close = () => calls.push('browser.close');
  if (native) {
    const nativeWindow = Object.fromEntries(['close', 'minimize', 'toggleMaximize', 'startDragging'].map(name => [name, async () => { calls.push(name); }]));
    nativeWindow.isMaximized = async () => false;
    w.__TAURI__ = { window: { getCurrentWindow: () => nativeWindow } };
  }
  const style = d.createElement('style'); style.textContent = css; d.head.appendChild(style);
  w.eval(source);
  w.TitleBar.mount(d.querySelector('#tb-actions'), d.querySelector('#tb-winctl'));
  return { dom, w, d, calls, style };
}

const mac = fixture('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)');
const { w, d, calls, style } = mac;
const controls = Array.from(d.querySelectorAll('#mac-lights button'));
check('Native macOS enables only left-side traffic controls', d.body.classList.contains('no-native-lights') && d.querySelector('#tb-winctl').hidden);
check('Traffic controls are a labelled accessible group', d.querySelector('#mac-lights').getAttribute('role') === 'group' && d.querySelector('#mac-lights').getAttribute('aria-label') === '窗口控制');
check('All three controls are real non-submit keyboard buttons', controls.length === 3 && controls.every(b => b.type === 'button' && !b.disabled && b.tabIndex === 0));
check('Each button describes its own native action', controls.map(b => b.getAttribute('aria-label')).join('|') === '关闭窗口|最小化窗口|放大或还原窗口');
check('All three controls contain decorative scalable glyphs', controls.every(b => b.querySelector('svg')?.getAttribute('viewBox') === '0 0 12 12' && b.querySelector('svg')?.getAttribute('aria-hidden') === 'true'));
check('Close contains crossing strokes', controls[0].querySelector('path').getAttribute('d') === 'M4 4l4 4M8 4L4 8');
check('Minimize contains a horizontal stroke', controls[1].querySelector('path').getAttribute('d') === 'M3 6h6');
check('Zoom contains the two native-style diagonal triangles', controls[2].querySelector('path').classList.contains('ml-expand'));
const rules = Array.from(style.sheet.cssRules);
const rule = selector => rules.find(r => r.selectorText === selector)?.style;
const state = rules.find(r => r.selectorText?.includes('#mac-lights:hover .ml-glyph') && r.selectorText?.includes('#mac-lights:focus-within .ml-glyph'));
check('Idle glyphs are hidden while colored circles remain visible', rule('#mac-lights .ml-glyph')?.opacity === '0' && rule('#mac-lights .ml-close')?.background === 'rgb(255, 95, 87)');
check('Hovering any area of traffic-light group reveals all glyphs', state?.style.opacity === '1' && !state.selectorText.includes('.ml:hover'));
check('Keyboard focus anywhere in traffic-light group also reveals all glyphs', state?.selectorText.includes('#mac-lights:focus-within .ml-glyph'));
check('Keyboard focus has a distinct outline outside the small circle', rule('#mac-lights .ml:focus-visible')?.getPropertyValue('outline-offset') === '2px' && rule('#mac-lights .ml:focus-visible')?.outline.includes('var(--accent)'));
check('All button circles and glyphs use identical 12 px geometry', rule('#mac-lights .ml')?.width === '12px' && rule('#mac-lights .ml')?.height === '12px' && rule('#mac-lights .ml-glyph')?.width === '12px');
check('Old hover dark overlay no longer conceals symbols', rule('#mac-lights:hover .ml::after')?.content === 'none');
let titlebarClicks = 0;
d.querySelector('#titlebar').addEventListener('click', () => titlebarClicks++);
controls[0].click(); controls[1].click(); controls[2].click();
await flush();
check('Clicks invoke native close, minimize and zoom exactly once', calls.join('|') === 'close|minimize|toggleMaximize');
check('Window control clicks do not propagate into titlebar handlers', titlebarClicks === 0);
controls[1].focus();
check('Control can receive keyboard focus without a hidden helper', d.activeElement === controls[1]);
calls.length = 0;
controls[0].querySelector('path').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, button: 0 }));
controls[0].querySelector('path').dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
await flush();
check('Dragging or double-clicking nested glyph never drags or zooms window', calls.length === 0);
d.querySelector('#blank').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, button: 0 }));
await flush();
check('Empty titlebar still starts native window dragging', calls.join('|') === 'startDragging');
calls.length = 0;
w.TitleBar.mount(d.querySelector('#tb-actions'), d.querySelector('#tb-winctl'));
d.querySelector('[data-act="minimize"]').click();
await flush();
check('Repeated mount cannot accumulate control click listeners', calls.join('|') === 'minimize');

const preview = fixture('Macintosh', false);
check('Browser preview never exposes fake native controls', !preview.d.body.classList.contains('no-native-lights') && preview.d.querySelector('#tb-winctl').hidden && preview.d.querySelectorAll('#mac-lights button').length === 0);
const windows = fixture('Windows NT 10.0');
check('Other platforms retain right-side native controls', !windows.d.body.classList.contains('no-native-lights') && !windows.d.querySelector('#tb-winctl').hidden && windows.d.querySelectorAll('#tb-winctl .wc').length === 3);
check('Interactions cause no script errors', errors.length === 0);
for (const [pass, label] of results) console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
console.log(`\n${results.filter(r => r[0]).length}/${results.length} PASS; ${errors.length} JS errors`);
for (const fixture of [mac, preview, windows]) fixture.dom.window.close();
if (results.some(([pass]) => !pass) || errors.length) process.exitCode = 1;
