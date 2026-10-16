// Production core/term/ui and real xterm; clipboard and native connection events
// use controlled test doubles. No real clipboard, password, or server is used.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = file => readFileSync(root + 'src/' + file, 'utf8');
const checks = [], errors = [], calls = [], callbacks = new Map(), browserCopies = [], legacyCopies = [], observedOutput = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log('PASS ' + name); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(condition) { const end = Date.now() + 3500; while (!condition()) { if (Date.now() > end) throw Error('Connection feedback test deadline'); await pause(3); } }
const vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
const dom = new JSDOM(source('index.html'), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://tauri.localhost/', virtualConsole: vc });
const w = dom.window, d = w.document;
w.HTMLCanvasElement.prototype.getContext = () => null;
Object.defineProperty(w.HTMLElement.prototype, 'offsetWidth', { get() { return this.classList.contains('xterm-char-measure-element') ? this.textContent.length * 8 : 640; } });
Object.defineProperty(w.HTMLElement.prototype, 'offsetHeight', { get() { return this.classList.contains('xterm-char-measure-element') ? 16 : 384; } });
w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
w.HTMLElement.prototype.scrollIntoView = function () {};
let bootstrap, serial = 0, interceptor, browserFailure = false, legacySuccess = true;
const addListener = d.addEventListener.bind(d);
Object.defineProperty(d, 'readyState', { value: 'loading', configurable: true });
d.addEventListener = (type, listener, options) => { if (type === 'DOMContentLoaded') bootstrap = listener; else addListener(type, listener, options); };
Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: {
  async writeText(text) { browserCopies.push(text); if (browserFailure) throw Error('fixture clipboard denied'); },
  async readText() { return 'fixture paste'; },
} });
d.execCommand = command => { if (command === 'copy') legacyCopies.push(d.activeElement?.value ?? d.getSelection()?.toString()); return legacySuccess; };
w.__TAURI_INTERNALS__ = {};
const protocols = ['spawn', 'connect_ssh', 'connect_telnet', 'connect_tcp', 'connect_serial'];
w.__TAURI__ = { core: { invoke(command, args) {
  calls.push([command, args]);
  const intercepted = interceptor?.(command, args); if (intercepted !== undefined) return intercepted;
  return Promise.resolve(command === 'ui_state_load' ? JSON.stringify({ lastUpdateCheck: Date.now(), tooltips: false })
    : command === 'sessions_load' ? [] : protocols.includes(command) ? 'native-' + ++serial
      : command === 'complete_input' ? { items: [], start: 0 } : command === 'triggers_feed' ? [] : null);
} }, event: { listen(type, callback) { callbacks.set(type, callback); return Promise.resolve(() => callbacks.delete(type)); } } };
w.Home = { mount() {}, show() { d.querySelector('#home').hidden = false; }, hide() { d.querySelector('#home').hidden = true; }, isOpen() { return !d.querySelector('#home').hidden; } };
w.Settings = { mount() {}, isOpen() { return false; }, close() {} };
w.Profiles = { isOpen() { return false; }, close() {} };
w.SftpPanel = { mount() {}, onSessionChange() {}, onConnectionChange() {}, syncCwd() {} };
w.eval(readFileSync(root + 'node_modules/@xterm/xterm/lib/xterm.js', 'utf8'));
w.FitAddon = { FitAddon: class { activate() {} fit() {} dispose() {} } };
w.SearchAddon = { SearchAddon: class { activate() {} dispose() {} } };
w.WebLinksAddon = { WebLinksAddon: class { activate() {} dispose() {} } };
for (const file of ['core.js', 'icons.js', 'term.js', 'tabbar.js', 'ui.js']) w.eval(source(file));
const T = w.WT, TM = T.term, UI = w.UI;
const toastMessages = [], showToast = UI.toast.bind(UI);
UI.toast = (...args) => { toastMessages.push(String(args[0])); return showToast(...args); };
const receive = TM.receiveOutput.bind(TM);
TM.receiveOutput = (tab, text, options) => { observedOutput.push({ tab, text, options }); return receive(tab, text, options); };
const session = { name: 'Connection fixture', protocol: 'ssh', host: 'fixture.invalid', port: 2222, user: 'tester', password: 'fixture-password-782',
  proxyType: 'http', proxyHost: 'proxy.fixture.invalid', proxyPort: 7890, proxyUser: 'fixture-proxy-user', proxyPassword: 'fixture-proxy-92', proxyCommand: '/usr/bin/fixture-proxy --host %host --port %port' };
const proxyFields = ['proxyType', 'proxyHost', 'proxyPort', 'proxyUser', 'proxyPassword', 'proxyCommand'];
const count = command => calls.filter(([name]) => name === command).length;
const clipboardCalls = () => calls.filter(([name]) => name === 'plugin:clipboard-manager|write_text');
const termText = tab => Array.from({ length: tab.term.buffer.active.length }, (_, i) => tab.term.buffer.active.getLine(i)?.translateToString(true) || '').join('\n');
const event = (name, payload) => { assert.ok(callbacks.has(name), 'Production listener registered: ' + name); callbacks.get(name)({ payload }); };
const dialog = () => [...d.querySelectorAll('[role="alertdialog"]')].find(node => !node.hidden && node.getAttribute('aria-hidden') !== 'true');
const button = pattern => [...(dialog()?.querySelectorAll('button') || [])].find(node => pattern.test(node.textContent + ' ' + (node.getAttribute('aria-label') || '')));
const closeDialog = async () => { if (dialog()) { const close = button(/关闭|取消|close/i); assert.ok(close, 'Error dialog has a close action'); close.click(); await until(() => !dialog()); } };
const write = (tab, text) => new Promise(resolve => tab.term.write(text, resolve));

try {
  await bootstrap();
  check('F01 Production bootstrap registers connection-error listener', callbacks.has('connection-error'));
  check('F02 Production core exposes one shared clipboard writer', typeof T.copyText === 'function');

  const initialBrowser = browserCopies.length;
  await T.copyText('native 中文 clipboard');
  check('F03 Native copy uses official clipboard-manager IPC with exact text', clipboardCalls().at(-1)?.[1]?.text === 'native 中文 clipboard');
  check('F04 Native success does not also overwrite through browser clipboard', browserCopies.length === initialBrowser);
  delete w.__TAURI_INTERNALS__;
  const nativeBeforeBrowser = clipboardCalls().length;
  await T.copyText('browser selected text');
  check('F05 Ordinary browser copy uses navigator.clipboard and avoids native plugin', browserCopies.at(-1) === 'browser selected text' && clipboardCalls().length === nativeBeforeBrowser);
  browserFailure = true;
  const legacyBefore = legacyCopies.length;
  await T.copyText('legacy fallback 中文');
  check('F06 Denied browser clipboard falls back to a selectable temporary field', legacyCopies.length === legacyBefore + 1 && legacyCopies.at(-1) === 'legacy fallback 中文');
  check('F07 Legacy clipboard fallback removes its temporary element', ![...d.querySelectorAll('textarea')].some(node => node.value === 'legacy fallback 中文'));
  legacySuccess = false;
  let rejected = false; try { rejected = await T.copyText('unavailable clipboard') === false; } catch (_) { rejected = true; }
  check('F08 Complete clipboard failure is reported instead of claimed successful', rejected);
  browserFailure = false; legacySuccess = true; w.__TAURI_INTERNALS__ = {};
  const blockingCopy = deferred();
  interceptor = (name, args) => name === 'plugin:clipboard-manager|write_text' && args.text === 'blocking clipboard fixture' ? blockingCopy.promise : undefined;
  const blocking = T.copyText('blocking clipboard fixture');
  await until(() => clipboardCalls().at(-1)?.[1]?.text === 'blocking clipboard fixture');
  let allowStale = true;
  const staleQueued = T.copyText('stale queued selection', { shouldWrite: () => allowStale });
  allowStale = false;
  const callsWhileBlocked = clipboardCalls().length; await pause(10);
  check('F08a Shared clipboard serializes writes instead of racing native promises', clipboardCalls().length === callsWhileBlocked);
  blockingCopy.resolve(null); await blocking;
  const staleResult = await staleQueued; interceptor = null;
  check('F08b Queued copy rechecks selection ownership before overwriting clipboard', staleResult === false && !clipboardCalls().some(([, args]) => args.text === 'stale queued selection'));

  const tab = await TM.create({ ...session });
  check('F09 A successful SSH connection creates a live terminal without success toast', TM.isLive(tab) && ![...d.querySelectorAll('#toasts .toast')].some(node => /已连接|连接成功/.test(node.textContent)) && !dialog());
  check('F09a SSH connect forwards every configured proxy field unchanged', proxyFields.every(key => calls.filter(([name]) => name === 'connect_ssh').at(-1)[1][key] === session[key]));
  await write(tab, 'selection fixture 中文\r\n');
  const autoBefore = clipboardCalls().length;
  tab.term.select(0, 0, 9);
  await until(() => clipboardCalls().length > autoBefore);
  check('F10 Real xterm selection automatically copies through the native shared API', clipboardCalls().at(-1)[1].text === 'selection');
  tab.term.clearSelection();
  const clearBefore = clipboardCalls().length; await pause(120);
  check('F11 Empty or cleared selection never overwrites clipboard', clipboardCalls().length === clearBefore);
  T.s.copyOnSelect = false;
  tab.term.select(10, 0, 7); await pause(120);
  check('F12 Disabling copy-on-select preserves clipboard while still allowing selection', tab.term.getSelection() && clipboardCalls().length === clearBefore);
  T.s.copyOnSelect = true; tab.term.clearSelection();
  const raceBefore = clipboardCalls().length;
  tab.term.select(0, 0, 5); tab.term.clearSelection(); await pause(120);
  check('F13 Clearing a selection before its deferred copy suppresses stale text', clipboardCalls().length === raceBefore);
  const mouseupBefore = clipboardCalls().length;
  tab.term.select(0, 0, 4); d.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }));
  await Promise.resolve(); await Promise.resolve();
  check('F13a Mouse release commits the current selection before the 60 ms timer', clipboardCalls().length === mouseupBefore + 1 && clipboardCalls().at(-1)[1].text === 'sele');
  tab.term.clearSelection();
  const afterMouseup = clipboardCalls().length;
  tab.term.select(0, 0, 9); await until(() => clipboardCalls().length > afterMouseup);
  const beforeManual = clipboardCalls().length;
  await UI.copy();
  check('F14 Manual terminal copy shares the native clipboard path', clipboardCalls().length === beforeManual + 1 && clipboardCalls().at(-1)[1].text === 'selection');
  browserFailure = true; legacySuccess = false;
  interceptor = name => name === 'plugin:clipboard-manager|write_text' ? Promise.reject(Error('fixture native clipboard denied')) : undefined;
  await UI.copy();
  check('F14a Manual clipboard failure displays failure rather than a false success', /复制失败|无法复制/.test(d.querySelector('#toasts .toast:last-child')?.textContent || ''));
  interceptor = null; browserFailure = false; legacySuccess = true;
  const autoNotices = () => toastMessages.filter(text => /自动复制失败/.test(text)).length;
  const failureBaseline = autoNotices();
  const selectAndRelease = async length => {
    tab.term.clearSelection(); tab.term.select(0, 0, length);
    d.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }));
    await T._clipboardQueue; await Promise.resolve(); await Promise.resolve();
  };
  interceptor = name => name === 'plugin:clipboard-manager|write_text' ? Promise.reject(Error('fixture automatic clipboard denied')) : undefined;
  await selectAndRelease(4); const afterFirstFailure = autoNotices();
  await selectAndRelease(5); const afterSecondFailure = autoNotices();
  interceptor = null;
  await selectAndRelease(7); const recoveryValue = clipboardCalls().at(-1)[1].text;
  interceptor = name => name === 'plugin:clipboard-manager|write_text' ? Promise.reject(Error('fixture automatic clipboard denied again')) : undefined;
  await selectAndRelease(8); const afterRecoveryFailure = autoNotices();
  check('F14b Automatic native copy failure reports once, avoids repeat notices, and recovers after success', afterFirstFailure === failureBaseline + 1 && afterSecondFailure === afterFirstFailure && recoveryValue === 'selecti' && afterRecoveryFailure === failureBaseline + 2);
  interceptor = null; tab.term.clearSelection();
  const closing = await TM.create({ ...session, name: 'Closing selection fixture' }); await write(closing, 'closing stale selection');
  const closeBefore = clipboardCalls().length;
  closing.term.select(0, 0, 7); await TM.close(closing.id); await pause(120);
  check('F15 Closing a terminal cancels deferred selection copying and disposes subscriptions', clipboardCalls().length === closeBefore && !TM.tabs[closing.id] && closing._inputSubscriptions.length === 0);

  const tabsBeforeFailedCreate = Object.keys(TM.tabs).length;
  interceptor = name => name === 'connect_ssh' ? Promise.reject(Error('Connection refused at fixture.invalid:2222; password=' + session.password)) : undefined;
  const failed = await TM.create({ ...session });
  await until(dialog);
  check('F16 Direct native connect failure opens a persistent error dialog', failed === null && dialog().textContent.includes('Connection refused'));
  check('F17 Failed create removes its terminal without adding a ghost tab', Object.keys(TM.tabs).length === tabsBeforeFailedCreate);
  check('F18 Connection error displays the concrete network cause and hides session password', dialog().textContent.includes('fixture.invalid') && !dialog().textContent.includes(session.password));
  UI.status(); await pause(120);
  check('F19 Status refresh does not dismiss the connection failure dialog', !!dialog() && !!button(/重试|重新连接|retry/i));
  const beforeErrorCopy = clipboardCalls().length;
  assert.ok(button(/复制|copy/i), 'Dialog has copy action'); button(/复制|copy/i).click();
  await until(() => clipboardCalls().length > beforeErrorCopy);
  check('F20 Copying connection details uses shared native clipboard without credentials', clipboardCalls().at(-1)[1].text.includes('Connection refused') && !clipboardCalls().at(-1)[1].text.includes(session.password));
  interceptor = null;
  const beforeRetryCreate = count('connect_ssh');
  button(/重试|重新连接|retry/i).click();
  await until(() => count('connect_ssh') === beforeRetryCreate + 1 && Object.keys(TM.tabs).length === tabsBeforeFailedCreate + 1);
  check('F21 Retrying an initial failure uses its original connection settings', calls.filter(([name]) => name === 'connect_ssh').at(-1)[1].host === session.host && calls.filter(([name]) => name === 'connect_ssh').at(-1)[1].port === session.port);
  await closeDialog();

  const pending = deferred();
  interceptor = name => name === 'connect_ssh' ? pending.promise : undefined;
  const creating = TM.create({ ...session, name: 'Early failure fixture' });
  event('connection-error', { id: 'early-failure-native', error: 'Early authentication rejected', protocol: 'ssh', stage: 'authentication' });
  event('pty-exit', { id: 'early-failure-native' });
  pending.resolve('early-failure-native'); const early = await creating; interceptor = null;
  await until(() => dialog()?.textContent.includes('Early authentication rejected'));
  check('F22 Error arriving before native connect result is retained with early exit', early.exited && early.ptyId === null && dialog().textContent.includes('Early authentication rejected'));
  await until(() => termText(early).includes('Early authentication rejected'));
  check('F23 Early concrete failure reason is retained inside the same xterm scrollback', termText(early).includes('Early authentication rejected') && termText(early).includes('按任意键'));
  await closeDialog();

  const live = await TM.create({ ...session, name: 'Asynchronous failure fixture' }), originalNative = live.ptyId;
  T.s.triggers = [{ enabled: true, pattern: 'Connection', action: 'send', value: 'should-not-run' }];
  const beforeTriggerProbe = count('triggers_feed');
  event('pty-output', { id: originalNative, data: 'real output probe\r\n' });
  await until(() => count('triggers_feed') > beforeTriggerProbe);
  const triggersBeforeError = count('triggers_feed'), outputsBeforeError = observedOutput.length;
  event('connection-error', { id: originalNative, data: JSON.stringify({ error: 'Connection reset by peer', protocol: 'ssh', stage: 'read' }) });
  await until(() => dialog()?.textContent.includes('Connection reset by peer') && termText(live).includes('Connection reset by peer'));
  check('F24 JSON-encoded asynchronous native error displays the real cause', dialog().textContent.includes('Connection reset by peer'));
  check('F25 Error banners explicitly disable automatic terminal triggers', observedOutput.slice(outputsBeforeError).some(value => value.tab === live && value.text.includes('Connection reset by peer') && value.options?.triggers === false) && count('triggers_feed') === triggersBeforeError);
  await closeDialog(); T.s.triggers = [];

  const unsafe = await TM.create({ ...session, name: 'Unsafe error text fixture' });
  event('connection-error', { id: unsafe.ptyId, error: '\x1b[2J\x1b]0;unsafe-title\x07Auth failed <img src=x onerror="window.feedbackInjected=1"> password=' + session.password + ' proxyPassword=' + session.proxyPassword, protocol: 'ssh', stage: 'authentication' });
  await until(() => dialog()?.textContent.includes('Auth failed'));
  check('F26 Error text is rendered as text rather than HTML or script', !dialog().querySelector('img,script,iframe') && !w.feedbackInjected);
  check('F27 Error presentation strips ANSI/OSC control sequences', !/[\x00-\x08\x0b-\x1f\x7f]/.test(dialog().textContent) && !dialog().textContent.includes('unsafe-title'));
  check('F28 Known connection and proxy passwords are redacted in error presentation', !dialog().textContent.includes(session.password) && !dialog().textContent.includes(session.proxyPassword));
  await closeDialog(); await TM.close(unsafe.id);

  event('pty-exit', { id: originalNative });
  const priorNative = originalNative;
  interceptor = name => name === 'connect_ssh' ? Promise.reject(Error('Host key verification failed at fixture.invalid; password=' + session.password)) : undefined;
  await TM.reconnect(live); interceptor = null; await until(dialog);
  check('F29 Reconnect failure retains the specific reason and leaves pane retryable', live.exited && !live._reconnecting && dialog().textContent.includes('Host key verification failed'));
  await until(() => termText(live).includes('Host key verification failed'));
  check('F30 Reconnect error reason is also visible in retained terminal output', termText(live).includes('Host key verification failed') && !termText(live).includes(session.password));
  const reconnectBefore = count('connect_ssh');
  button(/重试|重新连接|retry/i).click();
  await until(() => TM.isLive(live) && count('connect_ssh') === reconnectBefore + 1);
  check('F31 Dialog retry reconnects inside the original pane with a fresh native identity and original proxy', live.ptyId !== priorNative && TM.tabs[live.id] === live && proxyFields.every(key => calls.filter(([name]) => name === 'connect_ssh').at(-1)[1][key] === session[key]));
  await closeDialog();
  await until(() => !live._outputTimer && !live._outputWriting && !live._outputParts?.length);
  const beforeLateText = termText(live);
  event('connection-error', { id: priorNative, error: 'LATE OLD CONNECTION ERROR', protocol: 'ssh', stage: 'read' });
  await pause(60);
  check('F32 Late error from old native connection cannot pollute a replacement connection', !dialog() && termText(live) === beforeLateText);
  const closedNative = live.ptyId; await TM.close(live.id);
  event('connection-error', { id: closedNative, error: 'LATE CLOSED CONNECTION ERROR', protocol: 'ssh', stage: 'read' });
  await pause(60);
  check('F33 Closing a pane suppresses its delayed failure event and cannot resurrect it', !dialog() && !TM.tabs[live.id]);
  event('connection-error', { id: 'unknown-native', data: '{malformed-json' });
  event('connection-error', { id: 'unknown-native', error: 'UNKNOWN CONNECTION ERROR', protocol: 'ssh' });
  await pause(30);
  check('F34 Unrelated or malformed native failures do not open a global error dialog', !dialog());
  check('F35 Native connection feedback and clipboard integration has no DOM/JS errors', errors.length === 0);
} finally {
  interceptor = null;
  for (const tab of Object.values(TM.tabs)) await TM.close(tab.id);
  dom.window.close();
}
console.log('\nRESULT ' + checks.length + ' passed, 0 JavaScript errors; mocked native transport and clipboard.');
