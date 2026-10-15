// Real xterm parser/DOM keyboard path, production core events and workspace IDs.
// Native connections are controlled promises; no real server is contacted.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = file => readFileSync(root + 'src/' + file, 'utf8');
const errors = [], checks = [], calls = [], callbacks = new Map(), connectionChanges = [];
const vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
const dom = new JSDOM(source('index.html'), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://tauri.localhost/', virtualConsole: vc });
const w = dom.window, d = w.document;
w.HTMLCanvasElement.prototype.getContext = () => null;
Object.defineProperty(w.HTMLElement.prototype, 'offsetWidth', { get() { return this.classList.contains('xterm-char-measure-element') ? this.textContent.length * 8 : 640; } });
Object.defineProperty(w.HTMLElement.prototype, 'offsetHeight', { get() { return this.classList.contains('xterm-char-measure-element') ? 16 : 384; } });
w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
w.HTMLElement.prototype.scrollIntoView = function () {};
let bootstrap, serial = 0, interceptor = null, listenCount = 0;
const addListener = d.addEventListener.bind(d);
Object.defineProperty(d, 'readyState', { value: 'loading', configurable: true });
d.addEventListener = (type, listener, options) => { if (type === 'DOMContentLoaded') bootstrap = listener; else addListener(type, listener, options); };
const protocols = ['spawn', 'connect_ssh', 'connect_telnet', 'connect_tcp', 'connect_serial'];
w.__TAURI__ = { core: { invoke(command, args) {
  calls.push([command, args]);
  const result = interceptor?.(command, args); if (result) return result;
  return Promise.resolve(command === 'ui_state_load' ? JSON.stringify({ lastUpdateCheck: Date.now(), tooltips: false })
    : command === 'sessions_load' ? [] : protocols.includes(command) ? 'native-' + ++serial
    : command === 'complete_input' ? { items: [], start: 0 } : null);
} }, event: { listen(type, callback) { listenCount++; callbacks.set(type, callback); return Promise.resolve(() => callbacks.delete(type)); } } };
w.Home = { mount() {}, show() { d.querySelector('#home').hidden = false; }, hide() { d.querySelector('#home').hidden = true; }, isOpen() { return !d.querySelector('#home').hidden; } };
w.Settings = { mount() {}, isOpen() { return false; }, close() {} };
w.Profiles = { isOpen() { return false; }, close() {} };
w.SftpPanel = { mount() {}, onSessionChange() {}, onConnectionChange(tab) { connectionChanges.push([tab.id, tab.ptyId, tab.exited]); }, syncCwd() {} };
w.eval(readFileSync(root + 'node_modules/@xterm/xterm/lib/xterm.js', 'utf8'));
w.FitAddon = { FitAddon: class { activate() {} fit() {} dispose() {} } };
w.SearchAddon = { SearchAddon: class { activate() {} dispose() {} } };
w.WebLinksAddon = { WebLinksAddon: class { activate() {} dispose() {} } };
for (const file of ['core.js', 'icons.js', 'term.js', 'tabbar.js', 'ui.js']) w.eval(source(file));
const T = w.WT, TM = T.term;
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log('PASS ' + name); };
const frame = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(condition) { const end = Date.now() + 3000; while (!condition()) { if (Date.now() > end) throw Error('reconnect test deadline'); await new Promise(resolve => setTimeout(resolve, 3)); } }
const text = tab => Array.from({ length: tab.term.buffer.active.length }, (_, i) => tab.term.buffer.active.getLine(i)?.translateToString(true) || '').join('\n');
const event = (type, id, data) => callbacks.get(type)({ payload: { id, data } });
const exit = tab => event('pty-exit', TM.ptyId(tab));
const count = command => calls.filter(([c]) => c === command).length;
const writes = () => calls.filter(([c]) => c === 'write');
function key(tab, name, extra = {}) {
  const codes = { ArrowUp: 38, F1: 112, Enter: 13, Tab: 9, x: 88, w: 87, a: 65 };
  const ev = new w.KeyboardEvent('keydown', { key: name, code: name.length === 1 ? 'Key' + name.toUpperCase() : name, keyCode: codes[name] || 0, which: codes[name] || 0, bubbles: true, cancelable: true, ...extra });
  tab.term.textarea.dispatchEvent(ev); return ev;
}
function release(tab, name) { tab.term.textarea.dispatchEvent(new w.KeyboardEvent('keyup', { key: name, code: name.length === 1 ? 'Key' + name.toUpperCase() : name, bubbles: true })); }
const ssh = { name: 'Test SSH', protocol: 'ssh', host: 'server.invalid', user: 'tester', port: 2222, password: 'fixture-only', identityFile: '/tmp/fixture-key', jumpHost: 'gateway.invalid:22' };
try {
  await bootstrap();
  const initialListeners = listenCount;
  let tab = await TM.create({ ...ssh });
  const stable = tab.id, firstNative = tab.ptyId, wrap = tab.wrap, terminal = tab.term, originalSubscriptions = tab._inputSubscriptions.length;
  TM.renameTab(stable, 'Pinned session'); TM.togglePin(stable); TM.setTabColor(stable, '#ffffff');
  event('pty-output', firstNative, 'retained output\r\n'); await until(() => text(tab).includes('retained output'));
  exit(tab); await until(() => text(tab).includes('按任意键重新连接'));
  check('R01 Core exit marks a remote pane disconnected and keeps its output/view', tab.exited && tab.ptyId === null && tab.wrap === wrap && text(tab).includes('retained output'));
  check('R02 Disconnected PTY is no longer live or addressable by its old ID', !TM.isLive(tab) && TM.findByPty(firstNative) === null);
  check('R03 Exit wording does not invent a timeout cause', text(tab).includes('已退出或断开') && !text(tab).includes('超时'));
  check('R04 Exit invalidates SFTP context and releases the old native entry once', connectionChanges.at(-1)[1] === null && calls.filter(([c, a]) => c === 'kill' && a.id === firstNative).length === 1);
  const beforeDuplicate = text(tab); event('pty-exit', firstNative); event('pty-output', firstNative, 'stale output'); await frame();
  check('R05 Duplicate exit and late output from the old PTY are ignored', text(tab) === beforeDuplicate);

  let resolveConnect;
  interceptor = command => command === 'connect_ssh' ? new Promise(resolve => { resolveConnect = resolve; }) : null;
  const beforeKeyWrites = writes().length, beforeConnect = count('connect_ssh');
  key(tab, 'ArrowUp');
  check('R06 Arrow key without onData starts reconnect in the same pane', tab._reconnecting && count('connect_ssh') === beforeConnect + 1 && tab.id === stable);
  key(tab, 'x'); tab.term.input('pasted\rcommands', true);
  check('R07 Multiple keys/paste while connecting do not start duplicate connects or send input', count('connect_ssh') === beforeConnect + 1 && writes().length === beforeKeyWrites);
  await until(() => text(tab).includes('正在重新连接'));
  const connectArgs = calls.filter(([c]) => c === 'connect_ssh').at(-1)[1];
  check('R08 Retry reuses the original host/user/port/key/jump settings and current dimensions', connectArgs.host === ssh.host && connectArgs.user === ssh.user && connectArgs.port === 2222 && connectArgs.keyPath === ssh.identityFile && connectArgs.jumpHost === ssh.jumpHost && connectArgs.rows === tab.term.rows && connectArgs.cols === tab.term.cols);
  resolveConnect('replacement-ssh'); await until(() => !tab._reconnecting); interceptor = null;
  await until(() => text(tab).includes('已重新连接'));
  check('R09 Successful reconnect changes only native identity and preserves workspace/tab metadata', tab.id === stable && tab.ptyId === 'replacement-ssh' && tab.term === terminal && tab.wrap === wrap && tab.pinned && tab.title === 'Pinned session' && tab.color === '#ffffff' && TM.displayOrder().length === 1);
  check('R10 New native events map to the existing pane and old events stay rejected', TM.findByPty('replacement-ssh') === tab && TM.findByPty(firstNative) === null && TM.isLive(tab));
  check('R11 Reconnect refreshes SFTP with new native identity without registering new IPC/input listeners', connectionChanges.at(-1)[1] === 'replacement-ssh' && listenCount === initialListeners && tab._inputSubscriptions.length === originalSubscriptions);
  key(tab, 'ArrowUp', { repeat: true });
  check('R12 Held triggering key cannot leak auto-repeat into a fast replacement connection', writes().length === beforeKeyWrites);
  release(tab, 'ArrowUp'); tab.term.input('after-reconnect', true);
  check('R13 Later intentional input is sent to the replacement PTY', writes().at(-1)[1].id === 'replacement-ssh' && writes().at(-1)[1].data === 'after-reconnect');
  tab.term.resize(91, 31); await frame();
  check('R14 Resize uses dynamic native ID while UI IDs remain stable', calls.filter(([c]) => c === 'resize').at(-1)[1].id === 'replacement-ssh');
  event('pty-output', 'replacement-ssh', 'replacement output\r\n'); await until(() => text(tab).includes('replacement output'));
  check('R15 Original and replacement output share the retained xterm scrollback', text(tab).includes('retained output') && text(tab).includes('replacement output'));

  exit(tab); interceptor = command => command === 'connect_ssh' ? Promise.reject(new Error('fixture private failure')) : null;
  tab.term.input('retry-trigger-not-forwarded', true); await until(() => !tab._reconnecting);
  await until(() => text(tab).includes('重新连接失败'));
  check('R16 Failed reconnect stays disconnected and offers another key retry without raw private error', tab.exited && tab.ptyId === null && text(tab).includes('按任意键重试') && !text(tab).includes('fixture private failure'));
  interceptor = null; key(tab, 'F1'); await until(() => !tab._reconnecting);
  check('R17 A function key retries successfully after a failed attempt', TM.isLive(tab) && tab.id === stable);
  release(tab, 'F1');
  const newNative = tab.ptyId;
  await TM.close(stable);
  check('R18 Close releases current native PTY and explicitly disposes per-pane subscriptions', !TM.tabs[stable] && tab._inputSubscriptions.length === 0 && calls.filter(([c, a]) => c === 'kill' && a.id === newNative).length === 1);
  const closedCount = count('connect_ssh'); await TM.reconnect(tab); tab.term.input?.('late', true);
  check('R19 Closed pane cannot start reconnect or resurrect a tab', count('connect_ssh') === closedCount && !TM.tabs[stable]);

  tab = await TM.create({ ...ssh }); exit(tab);
  let pendingResolve; interceptor = command => command === 'connect_ssh' ? new Promise(resolve => { pendingResolve = resolve; }) : null;
  key(tab, 'x'); const pending = tab._reconnectPromise; await TM.closeTab(tab.id); pendingResolve('late-native'); await pending; interceptor = null;
  check('R20 Closing during authentication kills a late replacement instead of restoring the tab', !TM.tabs[tab.id] && !TM.findByPty('late-native') && calls.some(([c, a]) => c === 'kill' && a.id === 'late-native'));

  const parent = await TM.create({ ...ssh }); const sibling = await TM.splitActive('right');
  const workspace = parent.workspaceId, siblingNative = sibling.ptyId, parentId = parent.id;
  TM.workspaceState().ratio = 63; exit(parent);
  const writesBeforeSync = writes().length; T.s.sync = true; T.s.mode = 'Remote';
  parent.term.input('trigger', true); await until(() => !parent._reconnecting);
  check('R21 Split reconnect preserves one top-level tab, both panes, ratio and sibling session', TM.workspaceTabs(parentId).length === 2 && TM.displayOrder().length === 1 && parent.workspaceId === workspace && sibling.ptyId === siblingNative && TM.workspaceState(parent).ratio === 63);
  check('R22 Reconnect-trigger input is never broadcast into a live sibling', writes().length === writesBeforeSync);
  sibling.term.input('broadcast', true);
  check('R23 Later synchronized input uses both current native IDs', writes().slice(-2).some(([, a]) => a.id === parent.ptyId) && writes().slice(-2).some(([, a]) => a.id === siblingNative));
  exit(parent); const beforeLiveInput = count('connect_ssh'); sibling.term.input('live-only', true);
  check('R24 Broadcast skips an exited sibling without automatically reconnecting it', writes().at(-1)[1].id === siblingNative && count('connect_ssh') === beforeLiveInput);
  T.s.sync = false;
  const beforeCtrlW = count('connect_ssh'); TM.activate(parentId); key(parent, 'w', { ctrlKey: true }); await frame();
  check('R25 Ctrl+W closes the workspace without starting a reconnect', count('connect_ssh') === beforeCtrlW && !TM.tabs[parentId] && !TM.tabs[sibling.id]);

  for (const [protocol, session, command] of [
    ['telnet', { host: 'telnet.invalid', port: 2323 }, 'connect_telnet'],
    ['tcp', { host: 'tcp.invalid', port: 8080, proxyType: 'http', proxyHost: 'proxy.invalid', proxyPort: 3128 }, 'connect_tcp'],
    ['serial', { target: '/dev/ttyFixture', baudRate: 57600, dataBits: 7, stopBits: 2, parity: 'even', flowControl: 'RTS/CTS' }, 'connect_serial'],
  ]) {
    const item = await TM.create({ name: protocol, protocol, ...session }); const native = item.ptyId, before = count(command);
    exit(item); item.term.input('trigger', true); await until(() => !item._reconnecting);
    const args = calls.filter(([c]) => c === command).at(-1)[1];
    check('R26 ' + protocol + ' reuses protocol settings in its original pane', TM.isLive(item) && item.id === native && item.ptyId !== native && count(command) === before + 1 && Object.entries(session).every(([k, v]) => args[k] === v));
    await TM.close(item.id);
  }
  const local = await TM.create(null), beforeSpawn = count('spawn'); exit(local); local.term.input('ignored', true); await frame();
  check('R27 Local exit stays read-only with explicit new-tab guidance instead of unexpected restart', local.exited && count('spawn') === beforeSpawn && text(local).includes('新建标签'));
  await TM.close(local.id);
  const pendingCompletion = await TM.create({ ...ssh }); let complete;
  interceptor = command => command === 'complete_input' ? new Promise(resolve => { complete = resolve; }) : null;
  key(pendingCompletion, 'Tab'); exit(pendingCompletion); const beforeStaleCompletion = writes().length;
  complete({ start: 0, items: [{ value: 'stale-completion', info: '' }] }); await frame(); interceptor = null;
  check('R28 Completion from a previous connection generation cannot write to the dead or replacement PTY', writes().length === beforeStaleCompletion && pendingCompletion.wrap.querySelector('.complete-pop').style.display === 'none');
  await TM.close(pendingCompletion.id);
  interceptor = command => command === 'connect_ssh' ? Promise.resolve().then(() => {
    event('pty-output', 'early-initial', 'early initial output\r\n'); event('pty-exit', 'early-initial'); return 'early-initial';
  }) : null;
  const early = await TM.create({ ...ssh }); interceptor = null;
  await until(() => text(early).includes('early initial output') && text(early).includes('按任意键重新连接'));
  check('R30 Output/exit arriving before initial connect IPC resolves are assigned to the retained pane', early.exited && early.ptyId === null && TM.tabs[early.id] === early);
  interceptor = command => command === 'connect_ssh' ? Promise.resolve().then(() => {
    event('pty-output', 'early-retry', 'early retry output\r\n'); event('pty-exit', 'early-retry'); return 'early-retry';
  }) : null;
  key(early, 'F1'); await until(() => !early._reconnecting); interceptor = null;
  await until(() => text(early).includes('early retry output'));
  check('R31 Very fast replacement exit cannot leave a dead backend marked connected', early.exited && early.ptyId === null && !TM.isLive(early) && TM.findByPty('early-retry') === null);
  check('R32 Pending handoff events are released after all connect attempts finish', !TM._pendingConnections && TM._earlyPtyEvents.size === 0);
  const beforeModifier = count('connect_ssh'); key(early, 'Shift');
  check('R33 Modifier-only key does not reconnect while the user prepares an app shortcut', count('connect_ssh') === beforeModifier && early.exited);
  let backgroundResolve;
  interceptor = command => command === 'connect_ssh' ? new Promise(resolve => { backgroundResolve = resolve; }) : null;
  const background = TM.reconnect(early); const foreground = await TM.create(null);
  backgroundResolve('background-replacement'); await background; interceptor = null; await frame();
  check('R34 Finishing reconnect after switching tabs does not steal foreground focus or visibility', TM.active === foreground.id && early.wrap.style.display === 'none' && d.activeElement === foreground.term.textarea && TM.isLive(early));
  await TM.startLog(early); event('pty-output', early.ptyId, 'logged after retry\r\n'); T.flushLogs(early);
  check('R35 Session logging keeps stable UI identity while remote I/O uses replacement identity', calls.some(([c, a]) => c === 'session_log_append' && a.id === early.id && a.data.includes('logged after retry')));
  await TM.close(early.id); await TM.close(foreground.id);
  event('pty-output', 'unknown-no-connect', 'ignored'); event('pty-exit', 'unknown-no-connect');
  check('R36 Unknown events outside connection handoff cannot accumulate stale session mappings', !TM._pendingConnections && TM._earlyPtyEvents.size === 0);
  const triggered = await TM.create({ ...ssh }); let completeTrigger;
  T.s.triggers = [{ pattern: 'unsafe', action: 'send', arg: 'old-generation-command' }];
  interceptor = (command, args) => command === 'triggers_feed' && args.data === 'unsafe' ? new Promise(resolve => { completeTrigger = resolve; }) : null;
  TM.runTriggers(triggered, 'unsafe'); exit(triggered); await TM.reconnect(triggered);
  const beforeLateTrigger = writes().length; completeTrigger([{ action: 'send', text: 'old-generation-command' }]); await frame();
  check('R37 Old asynchronous trigger results cannot inject commands into a replacement connection', writes().length === beforeLateTrigger);
  let rejectTrigger;
  interceptor = (command, args) => command === 'triggers_feed' && args.data === 'unsafe' ? new Promise((_, reject) => { rejectTrigger = reject; }) : null;
  TM.runTriggers(triggered, 'unsafe'); exit(triggered); await TM.reconnect(triggered);
  const beforeLateFallback = writes().length; rejectTrigger(new Error('previous backend disconnected')); await frame();
  check('R38 Old trigger failures cannot fall back into sending commands on the replacement connection', writes().length === beforeLateFallback);
  interceptor = null; T.s.triggers = []; await TM.close(triggered.id);
  check('R29 No JavaScript errors or duplicate core subscriptions after repeated reconnects', errors.length === 0 && listenCount === initialListeners);
  console.log(`\nRESULT ${checks.length} passed, ${errors.length} JavaScript errors`);
} catch (error) { console.error('FAIL ' + (error.stack || error)); process.exitCode = 1; }
finally { interceptor = null; for (const id of [...TM.order]) await TM.close(id); dom.window.close(); }
