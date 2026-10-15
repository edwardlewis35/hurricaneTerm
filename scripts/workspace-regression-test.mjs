// Exercise workspace membership and asynchronous PTY teardown with production DOM/controllers.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../src/', import.meta.url));
const errors = [], checks = [], calls = [];
const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
const dom = new JSDOM(readFileSync(source + 'index.html', 'utf8'), { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
const w = dom.window, d = w.document;
let serial = 0, interceptor = null, profiles = false, sftp = false;
w.WT = {
  s: { theme: 'tabby-dark', fontSize: 13, triggers: [], sessions: [], tooltips: false },
  persistSettings() {}, persistSessions() {}, flushLogs() {},
  invoke(command, args) { calls.push([command, args]); const intercepted = interceptor?.(command, args); return intercepted || Promise.resolve(command === 'spawn' || command === 'connect_ssh' ? 'pty-' + ++serial : null); },
};
class Terminal {
  constructor(options) { this.options = options; this.rows = 24; this.cols = 80; this.buffer = { active: { baseY: 0, cursorY: 0 } }; }
  open(host) { this.input = d.createElement('textarea'); host.append(this.input); }
  loadAddon() {} onData() {} onResize() {} onSelectionChange() {} onTitleChange() {} attachCustomKeyEventHandler() {}
  focus() { this.input.focus(); } dispose() { this.disposed = true; } getSelection() { return ''; }
}
w.Terminal = Terminal;
w.FitAddon = { FitAddon: class { fit() { this.count = (this.count || 0) + 1; } } };
w.SearchAddon = { SearchAddon: class {} }; w.WebLinksAddon = { WebLinksAddon: class {} };
w.Home = { hide() { d.querySelector('#home').hidden = true; }, show() { d.querySelector('#home').hidden = false; }, isOpen() { return !d.querySelector('#home').hidden; } };
w.Settings = { isOpen() { return false; }, close() {}, cycleLightDark() {} };
w.Profiles = { isOpen() { return profiles; }, openManager() { profiles = true; }, close() { profiles = false; } };
w.SftpPanel = { isOpen() { return sftp; }, toggle() { sftp = !sftp; }, close() { sftp = false; }, onSessionChange() {} };
for (const file of ['icons.js', 'term.js', 'tabbar.js', 'actbar.js', 'ui.js']) w.eval(readFileSync(source + file, 'utf8'));
const TM = w.WT.term, UI = w.UI;
w.TabBar.mount(d.querySelector('#tabbar')); w.ActBar.mount(d.querySelector('#actbar')); UI.buildDock();
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log('PASS ' + name); };
const frame = () => new Promise(r => setTimeout(r, 25));
const pointerClick = el => { el.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true })); el.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true })); el.click(); };
const visible = () => Object.values(TM.tabs).filter(t => t.wrap.style.display !== 'none');
try {
  const first = await TM.create({ name: 'alpha', protocol: 'ssh', host: 'example.test' });
  const second = await TM.create({ name: 'beta' });
  TM.activate(first.id); const pane = await TM.splitActive('right'); await frame();
  check('W1 two native PTYs share one top-level tab after split', TM.order.length === 3 && TM.displayOrder().length === 2 && d.querySelectorAll('.ht-tab').length === 2 && first.workspaceId === pane.workspaceId);
  check('W2 pane focus maps to its owning top-level selected tab', TM.active === pane.id && d.querySelector('.ht-tab.ht-active').dataset.id === first.id);
  check('W3 both split panes have named close buttons', d.querySelectorAll('.pane-controls:not([hidden]) .pane-close').length === 2 && d.querySelector('.pane-close').getAttribute('aria-label').includes('alpha'));
  TM.workspaceState().ratio = 64; TM.renderWorkspace();
  TM.activate(second.id);
  check('W4 switching top-level tab hides both old panes and divider', visible().length === 1 && visible()[0] === second && TM.groupEl(1).hidden && d.querySelector('#gutter').hidden);
  const secondPane = await TM.splitActive('down'); TM.workspaceState().ratio = 35; TM.renderWorkspace();
  check('W5 another tab owns independent split axis and ratio', TM.splitDir === 'v' && TM.groupEl(0).style.flex.includes('35%'));
  TM.activateTab(first.id); await frame();
  check('W6 returning restores first tab axis, ratio and last focused pane', TM.active === pane.id && TM.splitDir === 'h' && TM.groupEl(0).style.flex.includes('64%') && visible().length === 2);
  TM.focusNextGroup(); await frame();
  check('W7 cycling pane focus preserves both visible terminals', TM.active === first.id && visible().length === 2 && first.fit.count > 0 && pane.fit.count > 0);
  TM.togglePin(pane.id); TM.renameTab(pane.id, 'workspace'); TM.setTabColor(pane.id, '#ffffff');
  check('W8 pin rename and color target the owning workspace tab', first.pinned && first.title === 'workspace' && first.color === '#ffffff');
  TM.moveTab(secondPane.id, 0);
  check('W9 reorder keeps workspace panes contiguous and does not drop PTYs', TM.order.length === 4 && TM.workspaceTabs(secondPane.id).length === 2 && new Set(TM.order).size === 4);
  const firstClose = d.querySelector('.pane-close[data-id="' + first.id + '"]'); pointerClick(firstClose); await frame();
  check('W10 pane close kills only its PTY and keeps sibling session alive', !TM.tabs[first.id] && TM.tabs[pane.id] && !pane.term.disposed && calls.filter(([name, args]) => name === 'kill' && args.id === first.id).length === 1);
  check('W11 surviving pane becomes full single pane with tab metadata retained', pane.group === 0 && !TM.splitDir && TM.groupEl(1).hidden && TM.displayOrder().length === 2 && pane.pinned && pane.title === 'workspace' && pane.color === '#ffffff');
  TM.activateTab(second.id);
  let kills = [];
  interceptor = name => name === 'kill' ? new Promise(resolve => kills.push(resolve)) : null;
  const closing = TM.closeTab(secondPane.id);
  check('W12 closing split tab removes all sibling views before native cleanup resolves', !TM.tabs[second.id] && !TM.tabs[secondPane.id] && kills.length === 2 && TM.tabs[pane.id]);
  kills.forEach(resolve => resolve()); await closing; interceptor = null;
  TM.activate(pane.id); const pendingSource = pane;
  let resolveConnect;
  interceptor = name => name === 'spawn' || name === 'connect_ssh' ? new Promise(resolve => { resolveConnect = resolve; }) : null;
  const connecting = TM.splitActive('left');
  check('W13 source pane stays visible while split SSH authentication is pending', pendingSource.group === 0 && pendingSource.wrap.style.display !== 'none' && !TM.splitDir);
  await TM.closeTab(pendingSource.id); resolveConnect('late-ssh'); await connecting; interceptor = null;
  check('W14 closing parent during split connect releases late PTY without resurrecting tab', !TM.tabs['late-ssh'] && !TM.order.length && calls.some(([name, args]) => name === 'kill' && args.id === 'late-ssh'));
  const active = await TM.create(null); let rejects;
  interceptor = name => name === 'spawn' ? new Promise((_, reject) => { rejects = reject; }) : null;
  const failure = TM.splitActive('up'); rejects(new Error('test connection failure')); await failure; interceptor = null;
  check('W15 failed split preserves original pane and clears split transaction guard', TM.active === active.id && active.group === 0 && !TM.splitDir && !TM.workspaceState().connecting);
  const another = await TM.splitActive('left'); TM.unsplit();
  check('W16 restoring independent tabs preserves both live native sessions', TM.displayOrder().length === 2 && TM.tabs[active.id] && TM.tabs[another.id] && !TM.splitDir && visible().length === 1);
  await TM.closeTab(active.id); await TM.closeTab(another.id);
  check('W17 closing last pane returns home and leaves no orphan workspace', !TM.order.length && !Object.keys(TM.workspaces).length && !d.querySelector('#home').hidden);
  const orphanSource = await TM.create(null); const orphanPane = await TM.splitActive('right');
  await TM.close(orphanSource.id); TM.unsplit(); await TM.close(orphanPane.id);
  check('W27 restoring tabs after original pane closed leaves no orphan workspace metadata', !Object.keys(TM.workspaces).length);
  const left = await TM.create(null); const leftPane = await TM.splitActive('right');
  const middle = await TM.create(null); const middlePane = await TM.splitActive('down');
  const right = await TM.create(null); const rightPane = await TM.splitActive('right');
  await TM.closeRight(middlePane.id);
  check('W28 close-right closes an entire right workspace without touching target sibling', !TM.tabs[right.id] && !TM.tabs[rightPane.id] && TM.tabs[middle.id] && TM.tabs[middlePane.id]);
  await TM.closeLeft(middlePane.id);
  check('W29 close-left closes both left panes while preserving target workspace', !TM.tabs[left.id] && !TM.tabs[leftPane.id] && TM.workspaceTabs(middle.id).length === 2);
  const spare = await TM.create(null); await TM.closeOthers(middlePane.id);
  check('W30 close-others preserves both panes of the specified workspace', !TM.tabs[spare.id] && TM.order.length === 2 && TM.workspaceTabs(middlePane.id).length === 2);
  const selectedTab = d.querySelector('.ht-tab.ht-active .ht-x'); pointerClick(selectedTab); await frame();
  check('W31 top-level close button closes every pane of its workspace', !TM.order.length && !Object.keys(TM.workspaces).length);
  await TM.create(null);
  for (const id of ['explorer', 'sender', 'transfer', 'outline', 'output', 'filer']) {
    const button = d.querySelector('[data-pane="' + id + '"]'); pointerClick(button); pointerClick(button);
    check('W18 ' + id + ' tool opens then closes with complete pointer event sequence', id === 'filer' ? !sftp : !w.WT.s.dockVisible);
  }
  const profileButton = d.querySelector('.ab-profiles'); pointerClick(profileButton); pointerClick(profileButton);
  check('W19 machine manager toolbar button toggles closed on second click', !profiles && profileButton.getAttribute('aria-expanded') === 'false');
  for (const [label, id] of [['查找', 'search-float'], ['命令面板', 'palette']]) {
    const button = d.querySelector('#actbar [aria-label="' + label + '"]'); pointerClick(button); pointerClick(button); await frame();
    check('W20 ' + label + ' second click closes and delayed autofocus cannot reopen it', d.querySelector('#' + id).hidden);
  }
  const caret = d.querySelector('.ht-caret'); pointerClick(caret); await frame(); pointerClick(caret);
  check('W21 recent machines caret closes on second click despite document outside listener', !w.TabBar.menuOpen() && caret.getAttribute('aria-expanded') === 'false');
  pointerClick(caret); await frame(); d.body.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
  check('W22 recent dropdown still dismisses on a different outside pointer', !w.TabBar.menuOpen());
  const split = d.querySelector('.ht-split'); pointerClick(split); await frame(); pointerClick(split);
  check('W23 split menu also toggles closed', !w.TabBar.menuOpen());
  UI.transfers = [{ name: 'a', dir: 'up', done: 1, total: 2 }]; UI.setDockPane('transfer');
  check('W24 transfer count shares dialog title row without a second hidden header', d.querySelector('#dock-title').textContent === '传输1 项' && !d.querySelector('#dock-body .pane-head'));
  const css = readFileSync(source + 'workspace.css', 'utf8');
  check('W25 divider paints the terminal alpha surface only in its own footprint', /#gutter\s*\{\s*background:\s*var\(--window-term-bg, var\(--term-bg\)\)/.test(css) && !/#groups\s*\{[^}]*background/.test(css));
  check('W26 complete interaction suite has no JavaScript errors', errors.length === 0);
  console.log(`\nRESULT ${checks.length} passed, ${errors.length} JavaScript errors`);
} finally { interceptor = null; for (const id of [...TM.order]) await TM.close(id); dom.window.close(); }
