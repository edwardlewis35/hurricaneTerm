// Production connection/split menus and toolbar, with a controlled terminal
// boundary. No connections, shell commands or network requests are made.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const source = fileURLToPath(new URL('../src/', import.meta.url));
const checks = [], errors = [], calls = [];
const vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
const dom = new JSDOM(readFileSync(source + 'index.html', 'utf8'), {
  runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://tauri.localhost/', virtualConsole: vc,
});
const w = dom.window, d = w.document;
const style = d.createElement('style'); style.textContent = readFileSync(source + 'style.css', 'utf8'); d.head.append(style);
w.WT = { s: { sessions: [], theme: 'dige-black', tooltips: false }, persistSettings() {}, invoke: () => Promise.resolve(null),
  term: { tabs: {}, order: [], active: null, activeTab() { return null; }, statusInfo() { return {}; },
    create(session) { calls.push(['create', session]); }, newLocal() { calls.push(['local']); }, openHome() { calls.push(['home']); },
    splitActive(direction) { calls.push(['split', direction]); }, unsplit() { calls.push(['unsplit']); } },
};
for (const file of ['icons.js', 'tabbar.js', 'actbar.js', 'ui.js']) w.eval(readFileSync(source + file, 'utf8'));
w.TabBar.mount(d.querySelector('#tabbar')); w.ActBar.mount(d.querySelector('#actbar'));
const q = selector => d.querySelector(selector), qa = selector => [...d.querySelectorAll(selector)];
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS ' + name); };
const frame = () => new Promise(resolve => setTimeout(resolve, 25));
const pointer = target => { for (const type of ['mousedown', 'mouseup', 'click']) target.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })); };
const key = (target, value, options = {}) => target.dispatchEvent(new w.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options }));
const split = () => q('#actbar .ht-split'), caret = () => q('.ht-caret');
const menuItem = label => qa('.ht-menu > .mi').find(node => node.querySelector('.lab')?.textContent === label);
const connections = group => qa('.ht-menu > [data-connection-group' + (group ? '="' + group + '"' : '') + ']');
const labels = group => connections(group).map(node => node.querySelector('.lab').textContent);
const openConnections = async () => { w.TabBar.closeMenu(); pointer(caret()); await frame(); };
const openSplit = async () => { w.TabBar.closeMenu(); pointer(split()); await frame(); };
const createCount = () => calls.filter(([name]) => name === 'create').length;

try {
  check('C01 Tab row retains only new-tab and connection actions', qa('#tabbar .ht-actions button').length === 2 && !q('#tabbar .ht-split'));
  check('C02 Split is exactly one second-row tool with the same button and icon geometry', qa('#actbar .ht-split').length === 1 && split().classList.contains('ab-btn') && w.getComputedStyle(split()).width === '32px' && w.getComputedStyle(split()).height === '30px' && w.getComputedStyle(split()).alignItems === 'center' && w.getComputedStyle(split().querySelector('svg')).width === w.getComputedStyle(q('#actbar [data-ai-toggle] svg')).width);
  await openSplit();
  check('C03 Split tool opens the shared menu with both directions and shortcut hints', w.TabBar.menuOpen() && split().getAttribute('aria-expanded') === 'true' && split().classList.contains('on') && !!menuItem('向右分屏') && !!menuItem('向下分屏') && q('.ht-menu').textContent.includes('Ctrl+Shift+E') && q('.ht-menu').textContent.includes('Ctrl+Shift+D'));
  pointer(split()); await frame();
  check('C04 A second full pointer click closes split without immediately reopening it', !w.TabBar.menuOpen() && split().getAttribute('aria-expanded') === 'false' && !split().classList.contains('on'));
  await openSplit(); key(d.body, 'Escape');
  check('C05 Escape closes split and returns focus to its second-row anchor', !w.TabBar.menuOpen() && d.activeElement === split());
  await openSplit(); pointer(d.body);
  check('C06 Outside pointer closes split and resets accessible expanded state', !w.TabBar.menuOpen() && split().getAttribute('aria-expanded') === 'false');
  await openConnections(); pointer(split()); await frame();
  check('C07 Opening split replaces the connection menu rather than retaining two overlays', qa('body > .ht-menu').length === 1 && !!menuItem('向右分屏') && caret().getAttribute('aria-expanded') === 'false');
  menuItem('向右分屏').click();
  check('C08 Right split executes the existing right-direction action exactly once', calls.at(-1)[0] === 'split' && calls.at(-1)[1] === 'right' && !w.TabBar.menuOpen());
  await openSplit(); menuItem('向下分屏').click();
  check('C09 Down split preserves the existing direction action', calls.at(-1)[0] === 'split' && calls.at(-1)[1] === 'down');
  await openSplit(); menuItem('恢复独立标签').click();
  check('C10 Split menu preserves restoring independent tabs', calls.at(-1)[0] === 'unsplit');
  split().focus(); key(split(), 'ArrowDown'); await frame();
  check('C11 ArrowDown opens split and focuses its first enabled menu item', w.TabBar.menuOpen() && d.activeElement === menuItem('向右分屏'));
  key(d.activeElement, 'Enter');
  check('C12 Keyboard Enter selects focused split without leaving the overlay open', calls.at(-1)[0] === 'split' && calls.at(-1)[1] === 'right' && !w.TabBar.menuOpen());
  key(split(), 'ArrowDown'); await frame(); key(d.activeElement, 'End'); key(d.activeElement, ' ');
  check('C13 End and Space allow selecting restore without pointer input', calls.at(-1)[0] === 'unsplit' && !w.TabBar.menuOpen());
  key(d.body, 'e', { ctrlKey: true, shiftKey: true }); key(d.body, 'd', { metaKey: true, shiftKey: true }); key(d.body, 'w', { ctrlKey: true, shiftKey: true });
  check('C14 Existing application split and restore keyboard shortcuts still reach their actions', JSON.stringify(calls.slice(-3)) === JSON.stringify([['split', 'right'], ['split', 'down'], ['unsplit']]));
  w.ActBar.mount(q('#actbar')); w.TabBar.mount(q('#tabbar'));
  check('C15 Repeated toolbar and tabbar mounts keep one split tool and two tab actions', qa('#actbar .ht-split').length === 1 && qa('#tabbar .ht-actions button').length === 2);

  const unused = { name: 'Unused saved machine', protocol: 'ssh', host: 'same.example', user: 'alice' };
  const newest = { id: 'newest', name: 'Newest recent', protocol: 'ssh', host: 'new.example', lastUsed: 300 };
  const older = { name: 'Older recent', protocol: 'telnet', host: 'old.example', lastUsed: 100 };
  const anotherUser = { name: 'Same host different user', protocol: 'ssh', host: 'same.example', user: 'bob' };
  w.WT.s.sessions = [unused, older, newest, anotherUser, newest, { ...newest, name: 'Duplicate ID profile' }, null];
  const storedBefore = JSON.stringify(w.WT.s.sessions); await openConnections();
  check('C16 New connection menu visibly groups recent and saved connections', qa('.ht-menu > .head').map(node => node.textContent).join('|') === '最近使用的机器|已保存的机器');
  check('C17 Recent connections are sorted newest first with no duplicate object or profile ID', labels('recent').join('|') === 'Newest recent|Older recent');
  check('C18 Saved group contains profiles absent from the visible recent group without duplication', labels('saved').join('|') === 'Unused saved machine|Same host different user' && connections().length === 4);
  check('C19 Distinct saved users on the same host remain separate connection targets', connections('saved').length === 2 && unused.host === anotherUser.host && unused.user !== anotherUser.user);
  check('C20 Menu grouping does not mutate persisted profile order or connection fields', JSON.stringify(w.WT.s.sessions) === storedBefore);
  connections('recent')[0].click();
  check('C21 Recent connection action passes its original complete profile object', calls.at(-1)[0] === 'create' && calls.at(-1)[1] === newest && !w.TabBar.menuOpen());
  await openConnections(); connections('saved')[1].click();
  check('C22 Saved connection action passes the selected profile rather than reconstructing host-only settings', calls.at(-1)[0] === 'create' && calls.at(-1)[1] === anotherUser);
  const html = { name: '<img src=x onerror=alert(1)>', protocol: 'ssh', host: 'safe.example' };
  w.WT.s.sessions = [unused, html]; await openConnections();
  check('C23 Empty recent list still exposes every saved machine', connections('recent').length === 0 && connections('saved').length === 2 && !!menuItem('（暂无最近机器）'));
  const beforeEmptyClick = createCount(); menuItem('（暂无最近机器）').click();
  check('C24 Empty-state placeholder is disabled and cannot connect', createCount() === beforeEmptyClick && menuItem('（暂无最近机器）').getAttribute('aria-disabled') === 'true');
  check('C25 Profile labels are safe text and never create markup or scripts', labels('saved').includes(html.name) && !q('.ht-menu img'));
  key(d.body, 'Escape'); caret().focus(); key(caret(), 'ArrowDown'); await frame();
  check('C26 Keyboard connection navigation skips empty headings and disabled recent placeholder', d.activeElement === connections('saved')[0]);
  key(d.activeElement, 'ArrowUp');
  check('C27 ArrowUp wraps to the last actionable item without focusing group headings', d.activeElement === menuItem('打开主页'));
  key(d.activeElement, 'Home'); key(d.activeElement, 'Enter');
  check('C28 Keyboard Home and Enter connect the first saved profile with empty recents', calls.at(-1)[0] === 'create' && calls.at(-1)[1] === unused && !w.TabBar.menuOpen());
  w.WT.s.sessions = Array.from({ length: 13 }, (_, index) => ({ name: 'machine-' + index, protocol: 'ssh', host: index + '.example', lastUsed: index + 1 }));
  await openConnections();
  check('C29 Ten recent entries remain bounded while older saved profiles stay discoverable', connections('recent').length === 10 && connections('saved').length === 3 && connections().length === 13 && labels('recent')[0] === 'machine-12' && labels('saved').join('|') === 'machine-0|machine-1|machine-2');
  check('C30 Long connection menus scroll inside a viewport-bounded popup', q('.ht-menu').classList.contains('ht-connections') && w.getComputedStyle(q('.ht-menu')).overflowY === 'auto' && !!w.getComputedStyle(q('.ht-menu')).maxHeight);
  w.WT.s.sessions = []; await openConnections();
  check('C31 Fully empty connection list retains explicit placeholders and creation/manager/home actions', connections().length === 0 && !!menuItem('（暂无最近机器）') && !!menuItem('（暂无已保存机器）') && !!menuItem('新建本地会话') && !!menuItem('添加机器…') && !!menuItem('打开主页'));
  w.WT.s.sessions = [{ name: 'Added after open', protocol: 'ssh', host: 'fresh.example' }]; await openConnections();
  check('C32 Reopening reads updated saved sessions without requiring a tabbar remount', labels('saved').join('|') === 'Added after open');
  check('C33 Popup and actionable connection rows expose menu accessibility roles', q('.ht-menu').getAttribute('role') === 'menu' && connections().every(node => node.getAttribute('role') === 'menuitem'));
  w.TabBar.closeMenu(); q('.ht-plus').click(); key(d.body, 't', { ctrlKey: true });
  check('C34 Plus button and existing new-local keyboard action remain available beside the tabs', calls.slice(-2).every(([name]) => name === 'local'));
  check('C35 Complete connection and relocated split menu integration has no JavaScript errors', errors.length === 0);
  console.log(`\nRESULT ${checks.length} passed, ${errors.length} JavaScript errors`);
} finally { w.TabBar.dispose(); dom.window.close(); }
