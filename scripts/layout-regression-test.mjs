// Exercise the production tab row and floating tools. Geometry is deterministic;
// native rendering is checked separately in the browser rather than simulated here.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const source = fileURLToPath(new URL('../src/', import.meta.url));
const errors = [], checks = [], calls = [], observers = [], listeners = [];
const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
const dom = new JSDOM(readFileSync(source + 'index.html', 'utf8'), {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://tauri.localhost', virtualConsole: vc,
});
const w = dom.window, d = w.document;
let viewport = 1000, sftpVisible = false, settingsVisible = false, profilesVisible = false, persisted = 0;
const addListener = w.addEventListener.bind(w);
w.addEventListener = (type, handler, options) => { listeners.push([type, handler]); addListener(type, handler, options); };
w.ResizeObserver = class {
  constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
  observe(element) { this.target = element; }
  disconnect() { this.disconnected = true; }
};
w.WT = {
  s: { dockVisible: true, dockPane: 'sender', theme: 'tabby-dark', sessions: [], tooltips: false },
  persistSettings() { persisted++; },
  invoke: () => Promise.resolve(null),
  term: {
    tabs: {}, order: [], active: null, THEMES: {},
    activeTab() { return this.tabs[this.active]; },
    statusInfo: () => ({ cols: 80, rows: 24 }),
    activate(id) { this.active = id; w.TabBar.render(); },
    close(id) { calls.push(['close', id]); delete this.tabs[id]; this.order = this.order.filter(x => x !== id); w.TabBar.render(); },
    newLocal() { calls.push(['newLocal']); },
    openHome() { calls.push(['home']); },
    splitActive(direction) { calls.push(['split', direction]); },
    unsplit() {},
  },
};
w.SftpPanel = { isOpen: () => sftpVisible, hide() { sftpVisible = false; }, open() { sftpVisible = true; }, close() { sftpVisible = false; }, toggle() { sftpVisible = !sftpVisible; } };
w.Settings = { isOpen: () => settingsVisible, close() { settingsVisible = false; }, toggle() { calls.push(['settings']); settingsVisible = !settingsVisible; }, cycleLightDark() { calls.push(['theme']); } };
w.Profiles = { openManager() { calls.push(['profiles']); profilesVisible = true; }, close() { profilesVisible = false; }, isOpen: () => profilesVisible };
w.Home = { show() { calls.push(['home']); }, hide() {} };
const baseRect = w.Element.prototype.getBoundingClientRect;
w.Element.prototype.getBoundingClientRect = function () {
  let left = 0, width = 0;
  if (this.id === 'titlebar') width = viewport;
  else if (this.id === 'tabbar') width = parseFloat(this.style.width) || 0;
  else if (this.classList.contains('ht-actions')) width = 68;
  else if (this.id === 'tb-actions') width = 46;
  else if (this.classList.contains('tb-drag-fill')) width = 200; // flex whitespace must not reduce the width calculation
  else if (this.classList.contains('tb-drag')) width = 8;
  else if (this.classList.contains('ht-tabs')) width = Math.max(0, (parseFloat(d.querySelector('#tabbar').style.width) || 0) - 68);
  else if (this.classList.contains('ht-tab')) {
    width = parseFloat(d.querySelector('.ht-tabbar').style.getPropertyValue('--ht-tab-width')) || 180;
    left = Array.from(this.parentElement.children).indexOf(this) * width - this.parentElement.scrollLeft;
  } else return baseRect.call(this);
  return { x: left, y: 0, left, top: 0, right: left + width, bottom: 40, width, height: 40 };
};
Object.defineProperty(d.querySelector('#titlebar'), 'clientWidth', { get: () => viewport });
const key = (target, key, options = {}) => target.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
const waitFrame = () => new Promise(r => setTimeout(r, 25));
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS ' + name); };
function populate(count) {
  const term = w.WT.term; term.tabs = {}; term.order = [];
  for (let i = 0; i < count; i++) {
    const id = 'tab-' + i; term.order.push(id);
    term.tabs[id] = { title: i % 2 ? 'Long title with 中文 ' + i : 'x', session: { protocol: 'local' }, pinned: i === 1, fit: { fit() {} }, term: { focus() {} }, outline: [] };
  }
  term.active = count ? 'tab-0' : null; w.TabBar.render();
}
const width = () => parseFloat(d.querySelector('.ht-tabbar').style.getPropertyValue('--ht-tab-width'));

try {
  for (const file of ['icons.js', 'tabbar.js', 'actbar.js', 'ui.js', 'titlebar.js']) w.eval(readFileSync(source + file, 'utf8'));
  w.TitleBar.mount(d.querySelector('#tb-actions'), d.querySelector('#tb-winctl'));
  w.TabBar.mount(d.querySelector('#tabbar')); w.ActBar.mount(d.querySelector('#actbar')); w.UI.buildDock();
  const row = d.querySelector('.ht-tabs');
  Object.defineProperty(row, 'clientWidth', { get: () => row.getBoundingClientRect().width });
  Object.defineProperty(row, 'scrollWidth', { get: () => Math.max(row.clientWidth, row.querySelectorAll('.ht-tab').length * width()) });
  check('L1 toolbar is the second body row, outside the floating dialog', d.querySelector('#actbar').parentElement === d.body && d.querySelector('#actbar').previousElementSibling.id === 'titlebar');
  check('L2 saved legacy sidebar state does not open a fixed panel at startup', d.querySelector('#dock').hidden && d.querySelector('#dock-backdrop').hidden && !w.WT.s.dockVisible);
  check('L3 old sidebar resizer is removed', !d.querySelector('#dock-resizer'));
  check('L4 settings remains in the top right, tools, split and AI are in the second row', d.querySelectorAll('#tb-actions button').length === 1 && d.querySelector('#tb-actions .tb-settings') && d.querySelectorAll('#actbar button').length === 13 && d.querySelector('#actbar .ht-split') && d.querySelector('#actbar [data-ai-toggle]').getAttribute('aria-controls') === 'ai-panel');
  const paneButton = d.querySelector('[data-pane="sender"]'); paneButton.focus(); paneButton.click();
  check('L5 tool click opens an accessible floating dialog and backdrop', !d.querySelector('#dock').hidden && !d.querySelector('#dock-backdrop').hidden && d.querySelector('#dock').getAttribute('aria-modal') === 'true');
  check('L6 selected tool is expanded and window title describes it', paneButton.getAttribute('aria-expanded') === 'true' && d.querySelector('#dock-title').textContent === '发送');
  check('L7 production sender UI and close button are inside the floating window', !!d.querySelector('#dock-body textarea') && d.activeElement.id === 'dock-close');
  const focusable = Array.from(d.querySelector('#dock').querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled])'));
  focusable.at(-1).focus(); key(focusable.at(-1), 'Tab');
  check('L8 Tab wraps from the final action to the dialog close control', d.activeElement.id === 'dock-close');
  key(d.activeElement, 'Tab', { shiftKey: true });
  check('L9 Shift+Tab wraps to the final dialog action', d.activeElement === focusable.at(-1));
  key(d.activeElement, 'Escape');
  check('L10 Escape closes the tool window and returns focus', d.querySelector('#dock').hidden && d.activeElement === paneButton && paneButton.getAttribute('aria-expanded') === 'false');
  paneButton.click(); paneButton.click(); check('L11 clicking the same tool toggles the window closed', d.querySelector('#dock').hidden);
  paneButton.click(); d.querySelector('[data-pane="output"]').click();
  check('L12 another tool changes the same floating window without inserting a sidebar', !d.querySelector('#dock').hidden && d.querySelector('#dock-title').textContent === '日志' && d.querySelector('#main-area').previousElementSibling.id === 'dock');
  d.querySelector('#main-area').dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  check('L13 outside pointer dismisses the window', d.querySelector('#dock').hidden);
  key(d.body, '3', { ctrlKey: true }); check('L14 existing Ctrl+3 opens the floating sender', !d.querySelector('#dock').hidden && w.WT.s.dockPane === 'sender');
  d.querySelector('#dock-close').click(); check('L15 explicit close hides the backdrop too', d.querySelector('#dock-backdrop').hidden);
  paneButton.click(); d.querySelector('[data-pane="filer"]').click();
  check('L16 SFTP tool preserves its full file manager and closes other tools', sftpVisible && d.querySelector('#dock').hidden);
  w.UI.setDockPane('transfer'); check('L17 opening another tool closes the SFTP overlay', !sftpVisible && w.WT.s.dockPane === 'transfer');
  d.querySelector('.tb-settings').click(); check('L18 settings click closes the tool window', d.querySelector('#dock').hidden && calls.some(x => x[0] === 'settings'));
  paneButton.click(); w.UI.openProfiles(); check('L19 machine manager entry preserves its action and dismisses the old tool', d.querySelector('#dock').hidden && calls.some(x => x[0] === 'profiles'));

  populate(3); check('L20 short and long titles share a single fixed 180px width', width() === 180 && d.querySelectorAll('.ht-tab').length === 3);
  check('L21 pinned tabs retain a title and the same width', row.firstElementChild.dataset.id === 'tab-1' && !!row.firstElementChild.querySelector('.ht-title') && !!row.firstElementChild.querySelector('.ht-pin'));
  populate(6); check('L22 tabs uniformly compress between 110 and 180 pixels', width() >= 110 && width() < 180);
  populate(18); check('L23 many tabs keep a readable 110px minimum and overflow one row', width() === 110 && row.scrollWidth > row.clientWidth);
  check('L24 add and connection remain beside tabs while split moves to the second row', !row.contains(d.querySelector('.ht-plus')) && d.querySelectorAll('.ht-actions button').length === 2 && d.querySelector('#actbar .ht-split') && !d.querySelector('#tabbar .ht-split'));
  const wheel = new w.WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true }); row.dispatchEvent(wheel);
  check('L25 vertical wheel scrolls tabs horizontally', wheel.defaultPrevented && row.scrollLeft === 200);
  row.dispatchEvent(new w.WheelEvent('wheel', { deltaX: 70, deltaY: 4, bubbles: true, cancelable: true }));
  check('L26 trackpad uses the dominant horizontal delta', row.scrollLeft === 270);
  const pinch = new w.WheelEvent('wheel', { deltaY: 90, ctrlKey: true, bubbles: true, cancelable: true }); row.dispatchEvent(pinch);
  check('L27 trackpad pinch is not intercepted as tab scrolling', !pinch.defaultPrevented && row.scrollLeft === 270);
  row.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -3, deltaMode: 1, bubbles: true, cancelable: true }));
  check('L28 line-mode wheel deltas convert to pixels', row.scrollLeft === 222);
  w.WT.term.activate('tab-17'); await waitFrame();
  check('L29 activation reveals an offscreen tab in the row', row.scrollLeft > 900);
  const active = row.querySelector('[data-id="tab-17"]'); active.focus(); key(active, 'Home'); await waitFrame();
  check('L30 Home activates and reveals the first pinned tab', w.WT.term.active === 'tab-1' && row.scrollLeft === 0 && d.activeElement.dataset.id === 'tab-1');
  key(d.activeElement, 'End'); await waitFrame(); check('L31 End reaches the last tab', w.WT.term.active === 'tab-17' && row.scrollLeft > 900);
  row.scrollLeft = 220; w.TabBar.render(); await waitFrame(); check('L32 background renders preserve deliberate manual scrolling', row.scrollLeft === 220);
  viewport = 760; observers.at(-1).callback(); await waitFrame(); check('L33 window resize recomputes width while preserving controls', width() === 110 && parseFloat(d.querySelector('#tabbar').style.width) <= 682);
  d.querySelector('.ht-plus').click(); check('L34 add action still creates a local tab', calls.some(x => x[0] === 'newLocal'));
  key(row.querySelector('[data-id="tab-17"]'), 'ArrowRight'); await waitFrame(); check('L35 arrow navigation wraps from last to first', w.WT.term.active === 'tab-1');
  w.WT.term.activate('tab-17'); await waitFrame();
  w.WT.term.tabs['tab-17'].pinned = true; w.TabBar.render(); await waitFrame();
  check('L49 pinning the active last tab reveals its new position even though its id is unchanged', row.scrollLeft <= 110 && row.querySelector('[data-id="tab-17"]').getBoundingClientRect().left >= 0);
  w.WT.term.tabs['tab-17'].pinned = false; w.TabBar.render(); await waitFrame();
  check('L50 unpinning the active tab reveals its position at the end of the row', row.scrollLeft > 900 && row.querySelector('[data-id="tab-17"]').getBoundingClientRect().right <= row.clientWidth);
  w.WT.term.order = ['tab-0', 'tab-17', ...w.WT.term.order.filter(id => !['tab-0', 'tab-17'].includes(id))];
  w.TabBar.render(); await waitFrame();
  check('L51 reordering the active tab keeps it visible without requiring a new active id', row.querySelector('[data-id="tab-17"]').getBoundingClientRect().left >= 0);
  populate(18); w.WT.term.activate('tab-4'); await waitFrame(); row.scrollLeft = 440;
  w.WT.term.close('tab-0'); await waitFrame();
  check('L52 closing a tab before the active tab reveals the shifted active position', row.scrollLeft === 330 && row.querySelector('[data-id="tab-4"]').getBoundingClientRect().left === 0);
  const observerCount = observers.length; w.TabBar.mount(d.querySelector('#tabbar'));
  check('L36 same-container remount is idempotent', observers.length === observerCount && d.querySelectorAll('.ht-tabbar').length === 1);
  const host = d.createElement('div'); host.id = 'second-tabbar'; d.querySelector('#titlebar').appendChild(host); w.TabBar.mount(host);
  check('L37 moving the tabbar disconnects the old ResizeObserver and removes stale DOM', observers[observerCount - 1].disconnected && d.querySelectorAll('.ht-tabbar').length === 1);
  w.TabBar.dispose(); check('L38 explicit disposal releases its observer and DOM', observers.at(-1).disconnected && !d.querySelector('.ht-tabbar'));
  const before = listeners.length; w.UI.buildDock(); w.ActBar.mount(d.querySelector('#actbar'));
  check('L39 toolbar and dock build do not duplicate long-lived listeners', before === listeners.length && d.querySelectorAll('#actbar button').length === 13);
  check('L40 user window actions persist state', persisted > 10);
  settingsVisible = profilesVisible = sftpVisible = false; w.UI.closeDock(); paneButton.focus();
  const focused = d.activeElement;
  w.UI.onSshConnected({ session: { protocol: 'ssh', host: 'example.test' } });
  check('L42 SSH connection prepares SFTP without opening it or moving focus', !sftpVisible && d.querySelector('#dock').hidden && d.activeElement === focused && w.WT.s.remotePath === '.');
  settingsVisible = profilesVisible = true; paneButton.click();
  check('L43 tool opening closes Settings and Profiles before applying its focus trap', !settingsVisible && !profilesVisible && !d.querySelector('#dock').hidden);
  w.UI.openSearch();
  check('L44 terminal search closes the previous tool dialog and receives focus', d.querySelector('#dock').hidden && d.activeElement.id === 'search-input');
  paneButton.click();
  check('L45 opening a tool dismisses the old search float', d.querySelector('#search-float').hidden && !d.querySelector('#dock').hidden);
  w.UI.openPalette(); await waitFrame();
  check('L46 command palette closes the previous tool dialog before focusing its input', d.querySelector('#dock').hidden && d.activeElement.id === 'palette-input');
  paneButton.click();
  check('L47 opening a tool closes the old command palette', d.querySelector('#palette').hidden && !d.querySelector('#dock').hidden);
  w.UI.closeDock(); w.UI.senderSet('selected text\r', false);
  check('L48 sending selected text reopens its floating window and populates the real textarea', !d.querySelector('#dock').hidden && d.querySelector('#send-text').value === 'selected text' && d.activeElement.id === 'send-text');
  check('L41 no JavaScript errors during keyboard, click, scroll and disposal', errors.length === 0);
  console.log(`\nRESULT ${checks.length} passed, ${errors.length} JavaScript errors`);
} finally { dom.window.close(); }
