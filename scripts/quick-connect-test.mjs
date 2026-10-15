// Exercise the production new-connection page through input/click/key events.
// The terminal boundary is deferred explicitly to test duplicate requests and retries.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
const source = name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8');
const errors = [], results = [];
const check = (name, condition) => results.push([!!condition, name]);
const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
const dom = new JSDOM('<!doctype html><html><body><div id="home" hidden></div></body></html>', {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://tauri.localhost/', virtualConsole: vc,
});
const w = dom.window, d = w.document;
w.addEventListener('error', e => errors.push(e.message));
w.Element.prototype.scrollIntoView = function () {};
const calls = [], messages = [], edits = [], logs = [];
let result = () => Promise.resolve(null), persists = 0, focuses = 0, managerCalls = 0;
w.WT = {
  s: { sessions: [
    { name: 'Production gateway', protocol: 'ssh', host: 'gateway.example.com', user: 'deployer', port: 2222, folder: 'Production', lastUsed: 10 },
    { name: 'Lab console', protocol: 'serial', target: '/dev/ttyUSB0', folder: 'Lab', lastUsed: 30 },
    { name: 'Router', protocol: 'telnet', host: '192.168.8.1', folder: 'Lab', lastUsed: 20 },
    { name: 'Local shell', protocol: '', command: '/bin/zsh' },
  ] },
  persistSessions() { persists++; },
  term: { order: [], activeTab() { return { term: { focus() { focuses++; } } }; }, create(s) { calls.push(s); return result(s); } },
  ui: { log(s) { logs.push(s); } },
};
w.UI = { toast(s) { messages.push(s); } };
w.Profiles = { isOpen() { return false; }, openManager() { managerCalls++; }, edit(s) { edits.push(s); } };
w.Settings = { open() {}, isOpen() { return false; } };
w.eval(source('common-controls.js')); w.eval(source('home.js'));
const H = w.Home;
H.mount(d.getElementById('home')); H.show();
const q = s => d.querySelector(s);
const rows = () => Array.from(d.querySelectorAll('.ht-home-row'));
const input = (element, value) => { element.value = value; element.dispatchEvent(new w.Event('input', { bubbles: true })); };
const key = (element, keyName, extra = {}) => element.dispatchEvent(new w.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...extra }));
const protocol = name => q('[data-protocol="' + name + '"]').click();
const submit = () => q('.ht-home-quick').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await Promise.resolve(); };
const resetFields = () => { input(H.inputEl, ''); input(H.userEl, ''); input(H.portEl, ''); };
await settle();

check('Q01 New connection heading and compact Huricano identity', q('h1').textContent === '新建连接' && q('.ht-home-mascot').width === 40);
check('Q02 Five accessible protocol choices share one selected tab', d.querySelectorAll('.ht-home-protocol').length === 5 && d.querySelectorAll('.ht-home-protocol[aria-selected="true"]').length === 1);
check('Q03 Protocol data select remains compatible without a duplicate dropdown', H.protoEl.tagName === 'SELECT' && H.protoEl.value === 'ssh' && !q('.wt-select'));
check('Q04 Initial page focuses connection address and lists saved machines once', d.activeElement === H.inputEl && rows().length === 4);

const blankCalls = calls.length; submit(); await settle();
check('Q05 Empty SSH input cannot create a terminal and gets a focused inline error', calls.length === blankCalls && H.inputEl.getAttribute('aria-invalid') === 'true' && H.hintEl.textContent.includes('请输入连接地址'));
input(H.inputEl, 'alice@server.example:2222'); key(H.inputEl, 'Enter'); await settle();
check('Q06 Enter resolves user@host:port through the existing create boundary', calls.at(-1).protocol === 'ssh' && calls.at(-1).user === 'alice' && calls.at(-1).host === 'server.example' && calls.at(-1).port === 2222);
check('Q07 Null connection leaves the page visible with retry feedback', !H.el.hidden && H.hintEl.classList.contains('bad') && !H.connectEl.disabled);
input(H.userEl, 'operator'); input(H.portEl, '2200');
check('Q08 Independent user and port fields explain their precedence in preview', H.hintEl.textContent.includes('operator@server.example:2200') && H.hintEl.textContent.includes('独立字段优先'));
q('.ht-home-save').click();
check('Q09 Save pre-fills the real machine editor contract without storing credentials', edits.at(-1).host === 'server.example' && edits.at(-1).user === 'operator' && edits.at(-1).port === 2200 && !('password' in edits.at(-1)));
input(H.portEl, '65536'); const invalidCalls = calls.length; submit(); await settle();
check('Q10 Out-of-range port blocks connection and marks the exact field', calls.length === invalidCalls && H.portEl.getAttribute('aria-invalid') === 'true');
input(H.portEl, '22junk'); submit(); await settle();
check('Q11 A partially numeric port is rejected instead of being truncated', calls.length === invalidCalls);
input(H.portEl, ''); input(H.userEl, 'bad user'); submit(); await settle();
check('Q12 Username whitespace is rejected before creating a terminal', calls.length === invalidCalls && H.userEl.getAttribute('aria-invalid') === 'true');
input(H.userEl, ''); input(H.inputEl, 'bad user@server.example'); submit(); await settle();
check('Q13 Username validation also covers the compact address syntax', calls.length === invalidCalls && H.inputEl.getAttribute('aria-invalid') === 'true');
input(H.inputEl, 'root@[2001:db8::12]:2022'); submit(); await settle();
check('Q14 IPv6 with brackets keeps the unbracketed host and explicit port', calls.at(-1).host === '2001:db8::12' && calls.at(-1).port === 2022 && calls.at(-1).name === 'root@[2001:db8::12]:2022');
input(H.inputEl, '2001:db8::22'); submit(); await settle();
check('Q15 Bare IPv6 remains a host and does not invent a port', calls.at(-1).host === '2001:db8::22' && calls.at(-1).port === 0);
input(H.inputEl, 'server.example');
check('Q16 Empty explicit port preserves default SSH port semantics', H.hintEl.textContent.includes('默认端口 22'));

input(H.inputEl, 'draft@ssh.example:2222'); input(H.userEl, 'ssh-user'); input(H.portEl, '2255');
protocol('serial'); input(H.inputEl, '/dev/tty.usbserial-1234'); submit(); await settle();
check('Q17 Serial uses target without leaking SSH user or port fields', calls.at(-1).protocol === 'serial' && calls.at(-1).target === '/dev/tty.usbserial-1234' && !('user' in calls.at(-1)) && !('port' in calls.at(-1)) && H.userEl.disabled && H.portEl.disabled);
protocol('ssh');
check('Q18 Switching protocols restores each draft and explicit values', H.inputEl.value === 'draft@ssh.example:2222' && H.userEl.value === 'ssh-user' && H.portEl.value === '2255');
protocol('telnet'); input(H.inputEl, 'router.example');
check('Q19 Telnet hides user field and previews default port 23', H.userFieldEl.hidden && H.hintEl.textContent.includes('默认端口 23'));
input(H.portEl, '2323'); submit(); await settle();
check('Q20 Telnet custom port reaches the terminal boundary', calls.at(-1).protocol === 'telnet' && calls.at(-1).host === 'router.example' && calls.at(-1).port === 2323);
protocol('tcp'); input(H.inputEl, '127.0.0.1:8080'); submit(); await settle();
check('Q21 TCP compact address remains supported', calls.at(-1).protocol === 'tcp' && calls.at(-1).host === '127.0.0.1' && calls.at(-1).port === 8080);
protocol(''); submit(); await settle();
check('Q22 Local connection requires no address and disables remote fields', calls.at(-1).protocol === '' && calls.at(-1).name === '本地终端' && H.inputEl.disabled && H.userEl.disabled && H.portEl.disabled);
const localTab = q('[data-protocol=""]'); key(localTab, 'Home');
check('Q23 Protocol Home key selects SSH and moves focus to selected tab', H.protoEl.value === 'ssh' && d.activeElement === q('[data-protocol="ssh"]'));
key(d.activeElement, 'ArrowRight');
check('Q24 Protocol arrow keys select the next protocol with roving focus', H.protoEl.value === 'telnet' && d.activeElement.getAttribute('aria-selected') === 'true');

protocol('ssh'); const retainedAddress = H.inputEl.value;
H.searchEl.focus(); input(H.searchEl, 'PRODUCTION');
check('Q25 Search matches group names case-insensitively without altering connection draft', rows().length === 1 && rows()[0].textContent.includes('Production gateway') && H.inputEl.value === retainedAddress && d.activeElement === H.searchEl);
input(H.searchEl, '/dev/ttyUSB0');
check('Q26 Search matches serial target addresses', rows().length === 1 && rows()[0].textContent.includes('Lab console'));
input(H.searchEl, 'no matching machine');
check('Q27 No-match state is explicit and clear search restores saved connections', rows().length === 0 && q('.ht-home-empty').textContent.includes('没有匹配')); q('.ht-home-empty button').click();
check('Q28 Clear search restores all machines and focus', rows().length === 4 && H.searchEl.value === '' && d.activeElement === H.searchEl);
q('[data-view="recent"]').click();
check('Q29 Recent view sorts successful connection timestamps without duplicate rows', rows().length === 3 && rows()[0].textContent.includes('Lab console') && rows()[1].textContent.includes('Router') && rows()[2].textContent.includes('Production gateway'));
q('[data-view="saved"]').click(); key(H.searchEl, 'ArrowDown');
check('Q30 Search arrow key focuses the first saved connection', d.activeElement === rows()[0]);
key(d.activeElement, 'ArrowDown'); const selectedProfile = w.WT.s.sessions.find(s => d.activeElement.textContent.includes(s.name));
key(d.activeElement, 'Backspace');
check('Q31 Backspace on a machine row opens that exact saved configuration for editing', edits.at(-1) === selectedProfile);
const selectedKey = d.activeElement.dataset.sessionKey; H.render();
check('Q32 Background list refresh preserves row focus and all draft text', d.activeElement.dataset.sessionKey === selectedKey && H.inputEl.value === retainedAddress && H.userEl.value === 'ssh-user');
input(H.searchEl, 'gateway.example.com'); key(H.searchEl, 'Enter'); await settle();
check('Q33 Enter from search connects the first matching saved object', calls.at(-1) === w.WT.s.sessions[0]);
input(H.searchEl, '');

resetFields(); input(H.inputEl, 'slow.example.com');
let release;
result = () => new Promise(resolve => { release = resolve; });
const beforeBusy = calls.length; submit(); submit(); key(H.inputEl, 'Enter'); rows()[0].click();
check('Q34 Repeated submit, Enter, and saved-row click cannot create duplicate tabs', calls.length === beforeBusy + 1 && H.el.getAttribute('aria-busy') === 'true' && H.connectEl.disabled && H.inputEl.disabled);
H.render();
check('Q35 A list refresh during connection keeps controls and new rows disabled', rows().every(r => r.disabled) && H.connectEl.disabled && H.hintEl.textContent.includes('正在连接'));
release(null); await settle();
check('Q36 Failed pending connection restores editable drafts and permits retry', H.inputEl.value === 'slow.example.com' && !H.inputEl.disabled && !H.connectEl.disabled && !H.el.hidden);
result = () => Promise.reject(new Error('authentication rejected')); submit(); await settle();
check('Q37 Rejected connection is handled with inline error, toast, and reset busy state', messages.at(-1).includes('authentication rejected') && H.hintEl.textContent.includes('authentication rejected') && H.el.getAttribute('aria-busy') === 'false' && !H.connectEl.disabled);
result = () => Promise.resolve({ id: 'new-tab' }); submit(); await settle();
check('Q38 Successful retry hides the page, clears pending hint and logs once', H.el.hidden && !H.hintEl.textContent.includes('正在连接') && logs.at(-1).includes('slow.example.com') && persists > 0);
H.show(); w.WT.term.order = ['existing-tab']; key(H.inputEl, 'Escape');
check('Q39 Escape returns to an existing terminal and restores keyboard focus', H.el.hidden && focuses === 1);
w.WT.term.order = []; H.show(); key(H.inputEl, 'Escape');
check('Q40 Escape with no terminal keeps a usable connection page visible', !H.el.hidden);
H.el.querySelectorAll('.ht-home-action')[1].click();
check('Q41 Manager shortcut remains wired to the existing profile manager', managerCalls === 1);
input(H.inputEl, 'draft-again.example'); input(H.userEl, 'user-again'); input(H.portEl, '2222');
w.WT.s.sessions.push({ name: '<img src=x onerror="window.attacked=1">', protocol: 'ssh', host: 'safe.example', folder: '__proto__', color: 'red;background:url(javascript:alert(1))' });
H.render(); await settle();
check('Q42 Refresh handles arbitrary group names and renders untrusted session labels as text', rows().length === 5 && !q('.ht-home-row img') && !w.attacked && !q('.ht-home-row .ht-home-dot'));
check('Q43 Adding saved machines never replaces address/user/port draft fields', H.inputEl.value === 'draft-again.example' && H.userEl.value === 'user-again' && H.portEl.value === '2222');
const beforeCompose = calls.length; key(H.inputEl, 'Enter', { isComposing: true }); await settle();
check('Q44 IME confirmation does not accidentally start a connection', calls.length === beforeCompose);

result = () => Promise.resolve(null);
protocol('tcp'); resetFields(); input(H.inputEl, 'tcp.example');
const beforeMissingPort = calls.length; submit(); await settle();
check('Q45 TCP without an address or independent port is rejected with a specific required-port hint', calls.length === beforeMissingPort && H.portEl.getAttribute('aria-invalid') === 'true' && H.hintEl.textContent.includes('TCP 连接必须指定端口') && H.portLabelEl.textContent.includes('地址中提供'));
input(H.portEl, '8080'); submit(); await settle();
check('Q46 An independent valid TCP port clears the error and reaches the terminal boundary', calls.at(-1).protocol === 'tcp' && calls.at(-1).host === 'tcp.example' && calls.at(-1).port === 8080 && !H.portEl.hasAttribute('aria-invalid'));
protocol('ssh'); resetFields(); input(H.inputEl, '2001:db8::1'); input(H.userEl, 'deploy'); input(H.portEl, '2200');
check('Q47 IPv6 plus an independent port previews an unambiguous bracketed endpoint', H.hintEl.textContent.includes('deploy@[2001:db8::1]:2200'));
submit(); await settle();
check('Q48 IPv6 display name is bracketed while the backend receives the unchanged host', calls.at(-1).name === 'deploy@[2001:db8::1]:2200' && calls.at(-1).host === '2001:db8::1' && calls.at(-1).port === 2200);
resetFields(); input(H.inputEl, 'ssh.example'); submit(); await settle();
check('Q49 SSH without a port retains backend default semantics', calls.at(-1).protocol === 'ssh' && calls.at(-1).host === 'ssh.example' && calls.at(-1).port === 0);
protocol('telnet'); resetFields(); input(H.inputEl, 'telnet.example'); submit(); await settle();
check('Q50 Telnet without a port retains backend default semantics', calls.at(-1).protocol === 'telnet' && calls.at(-1).host === 'telnet.example' && calls.at(-1).port === 0);

for (const [passed, name] of results) console.log((passed ? 'PASS' : 'FAIL') + ' ' + name);
for (const error of errors) console.log('ERROR ' + error);
console.log(`Quick connection: ${results.filter(r => r[0]).length}/${results.length} passed; ${errors.length} JavaScript errors`);
const failed = results.some(r => !r[0]) || errors.length > 0;
dom.window.close();
process.exitCode = failed ? 1 : 0;
