// Real xterm DOM keyboard/composition/paste path + production core/term/ui.
// Only the native bridge, clipboard and unrelated panels are controlled fixtures.
// No SSH server, real credentials, clipboard or filesystem is accessed.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = file => readFileSync(root + 'src/' + file, 'utf8');
const errors = [], checks = [], failures = [], calls = [], callbacks = new Map();
const consoleMessages = [];
const deadline = setTimeout(() => {
  console.error('FAIL fixture: terminal-input-safety test exceeded its 30-second deadline');
  process.exit(1);
}, 30000);
const vc = new VirtualConsole();
vc.on('jsdomError', error => errors.push(error.message));
for (const level of ['log', 'warn', 'error', 'info', 'debug']) vc.on(level, (...args) => consoleMessages.push(args.join(' ')));
const dom = new JSDOM(source('index.html'), {
  runScripts: 'dangerously', pretendToBeVisual: true,
  url: 'http://tauri.localhost/', virtualConsole: vc,
});
const w = dom.window, d = w.document;
w.HTMLCanvasElement.prototype.getContext = () => null;
Object.defineProperty(w.HTMLElement.prototype, 'offsetWidth', {
  get() { return this.classList.contains('xterm-char-measure-element') ? this.textContent.length * 8 : 640; },
});
Object.defineProperty(w.HTMLElement.prototype, 'offsetHeight', {
  get() { return this.classList.contains('xterm-char-measure-element') ? 16 : 384; },
});
w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
w.HTMLElement.prototype.scrollIntoView = function () {};
let bootstrap, serial = 0, interceptor = null;
let clipboardText = '', clipboardRead = null;
Object.defineProperty(w.navigator, 'clipboard', { value: {
  readText() { return clipboardRead ? clipboardRead() : Promise.resolve(clipboardText); },
  writeText() { return Promise.resolve(); },
} });
const addListener = d.addEventListener.bind(d);
Object.defineProperty(d, 'readyState', { value: 'loading', configurable: true });
d.addEventListener = (type, listener, options) => {
  if (type === 'DOMContentLoaded') bootstrap = listener;
  else addListener(type, listener, options);
};
const protocols = ['spawn', 'connect_ssh', 'connect_telnet', 'connect_tcp', 'connect_serial'];
w.__TAURI__ = {
  core: { invoke(command, args) {
    calls.push([command, args]);
    const result = interceptor?.(command, args);
    if (result) return result;
    return Promise.resolve(command === 'ui_state_load'
      ? JSON.stringify({ lastUpdateCheck: Date.now(), tooltips: false })
      : command === 'sessions_load' ? []
      : protocols.includes(command) ? 'input-native-' + ++serial
      // Return a dangerous candidate so an accidental client completion cannot
      // pass by falling back to sending Tab after an empty result.
      : command === 'complete_input' ? { start: 0, items: [{ value: 'UNSAFE-LOCAL-CANDIDATE', info: '' }] }
      : null);
  } },
  event: { listen(type, callback) { callbacks.set(type, callback); return Promise.resolve(() => callbacks.delete(type)); } },
};
w.Home = { mount() {}, show() { d.querySelector('#home').hidden = false; }, hide() { d.querySelector('#home').hidden = true; }, isOpen() { return !d.querySelector('#home').hidden; } };
w.Settings = { mount() {}, isOpen() { return false; }, close() {}, toggle() {} };
w.Profiles = { isOpen() { return false; }, close() {}, openManager() {} };
w.SftpPanel = { mount() {}, onSessionChange() {}, onConnectionChange() {}, syncCwd() {}, toggle() {} };
w.TransferQueue = { mount() {}, toggle() {} };
const busy = new Set();
w.ModemTransfer = { isBusy(tab) { return busy.has(tab); }, onConnectionChange() {} };
w.eval(readFileSync(root + 'node_modules/@xterm/xterm/lib/xterm.js', 'utf8'));
w.FitAddon = { FitAddon: class { activate() {} fit() {} dispose() {} } };
w.SearchAddon = { SearchAddon: class { activate() {} dispose() {} findNext() { return true; } findPrevious() { return true; } } };
w.WebLinksAddon = { WebLinksAddon: class { activate() {} dispose() {} } };
for (const file of ['core.js', 'icons.js', 'term.js', 'tabbar.js', 'ui.js']) w.eval(source(file));
const T = w.WT, TM = T.term, UI = w.UI;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 3)); };
const writeOutput = (tab, text) => new Promise(resolve => tab.term.write(text, resolve));
const writes = () => calls.filter(([command]) => command === 'write').map(([, args]) => args);
const binaryWrites = () => calls.filter(([command]) => command === 'write_binary').map(([, args]) => ({ id: args.id, data: Array.from(args.data) }));
// Use xterm's real binary event, rather than calling a product helper directly.
// A single legacy mouse-coordinate report cannot contain all four edge bytes.
const binaryInput = (tab, bytes) => tab.term._core.coreService.triggerBinaryEvent(String.fromCharCode(...bytes));
const count = command => calls.filter(([name]) => name === command).length;
const outputText = tab => Array.from({ length: tab.term.buffer.active.length }, (_, i) => tab.term.buffer.active.getLine(i)?.translateToString(true) || '').join('\n');
function check(name, actual, expected = true) {
  try { assert.deepEqual(actual, expected); checks.push(name); console.log('PASS ' + name); }
  catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.message); }
}
const ssh = name => ({ name, protocol: 'ssh', host: name + '.invalid', user: 'fixture', port: 22 });
async function create(name) { const tab = await TM.create(ssh(name)); await settle(); return tab; }
const codes = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Home: 36, End: 35, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, F2: 113, F3: 114, F11: 122, ',': 188, '=': 187, '+': 187, '-': 189, '!': 49, ' ': 32 };
function keyboard(tab, type, key, extra = {}) {
  const keyCode = codes[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const event = new w.KeyboardEvent(type, {
    key, code: key.length === 1 ? (/\d/.test(key) ? 'Digit' : 'Key') + key.toUpperCase() : key,
    keyCode, which: keyCode, charCode: type === 'keypress' && key.length === 1 ? key.charCodeAt(0) : 0,
    bubbles: true, cancelable: true, ...extra,
  });
  tab.term.textarea.dispatchEvent(event);
  return event;
}
function stroke(tab, key, extra = {}) {
  const event = keyboard(tab, 'keydown', key, extra);
  // Browsers suppress keypress when keydown was canceled. Printable keys also
  // generate input, which xterm must not double-send after its keypress path.
  if (!event.defaultPrevented && key.length === 1 && !extra.ctrlKey && !extra.metaKey && !extra.altKey) {
    keyboard(tab, 'keypress', key, extra);
    tab.term.textarea.dispatchEvent(new w.InputEvent('input', { data: key, inputType: 'insertText', composed: true, bubbles: true }));
  }
  keyboard(tab, 'keyup', key, extra);
  return event;
}
async function expectWrites(name, start, expected) {
  await settle();
  check(name, writes().slice(start).map(({ id, data }) => ({ id, data })), expected);
}
function nativePaste(tab, text) {
  const event = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData(type) { assert.equal(type, 'text/plain'); return text; } } });
  tab.term.textarea.dispatchEvent(event);
}
const pasteEntries = {
  toolbar: tab => { TM.activate(tab.id); return UI.paste(); },
  shortcut: tab => { TM.activate(tab.id); stroke(tab, 'V', { ctrlKey: true, shiftKey: true }); },
  middle: tab => tab.wrap.dispatchEvent(new w.MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true })),
  right: tab => tab.wrap.dispatchEvent(new w.MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true })),
};
try {
  await bootstrap();
  const a = await create('machine-a'), b = await create('machine-b');
  TM.activate(a.id); await settle();
  check('I00 synchronization requires an explicit opt-in', T.s.sync, false);
  check('I01 xterm textarea is real, focused and disables native text correction',
    a.term instanceof w.Terminal && d.activeElement === a.term.textarea
    && a.term.textarea.getAttribute('autocapitalize') === 'none'
    && a.term.textarea.getAttribute('autocorrect') === 'off'
    && a.term.textarea.getAttribute('spellcheck') === 'false');
  let start = writes().length;
  for (const char of 'sudo passwd user') stroke(a, char);
  await expectWrites('I02 ordinary letters and spaces preserve case/order without an implicit Enter', start,
    Array.from('sudo passwd user', data => ({ id: a.ptyId, data })));
  start = writes().length; stroke(a, 'Enter');
  await expectWrites('I03 one physical Enter emits exactly one CR', start, [{ id: a.ptyId, data: '\r' }]);
  start = writes().length;
  const beforeCompletion = count('complete_input'); stroke(a, 'Tab'); await settle();
  await expectWrites('I04 Tab goes unchanged to the shell instead of a local candidate', start, [{ id: a.ptyId, data: '\t' }]);
  check('I05 default Tab never invokes the client completion service', count('complete_input'), beforeCompletion);
  const terminalKeys = [
    ['ArrowUp', '\x1b[A'], ['ArrowDown', '\x1b[B'], ['ArrowRight', '\x1b[C'], ['ArrowLeft', '\x1b[D'],
    ['Home', '\x1b[H'], ['End', '\x1b[F'], ['Delete', '\x1b[3~'], ['Backspace', '\x7f'],
  ];
  for (const [key, data] of terminalKeys) {
    start = writes().length; stroke(a, key);
    await expectWrites('I06 ' + key + ' preserves the xterm control sequence', start, [{ id: a.ptyId, data }]);
  }
  for (const [key, data] of [['c', '\x03'], ['d', '\x04'], ['z', '\x1a'], ['u', '\x15'], ['w', '\x17'], ['r', '\x12'], ['t', '\x14'], ['b', '\x02'], ['f', '\x06'], ['m', '\r']]) {
    start = writes().length; stroke(a, key, { ctrlKey: true });
    await expectWrites('I07 Ctrl+' + key.toUpperCase() + ' remains a shell control key', start, [{ id: a.ptyId, data }]);
  }
  start = writes().length; stroke(a, 'Tab', { shiftKey: true });
  await expectWrites('I08 Shift+Tab remains the native reverse-tab sequence', start, [{ id: a.ptyId, data: '\x1b[Z' }]);
  for (const [key, data] of [['F3', '\x1bOR'], ['F11', '\x1b[23~']]) {
    start = writes().length; stroke(a, key);
    await expectWrites('I08 ' + key + ' remains a native function key while the terminal has focus', start, [{ id: a.ptyId, data }]);
  }

  start = writes().length;
  a.term.textarea.dispatchEvent(new w.InputEvent('input', { data: '中文🙂é', inputType: 'insertText', bubbles: true, composed: true }));
  await expectWrites('I09 Unicode/emoji insertText arrives unchanged once', start, [{ id: a.ptyId, data: '中文🙂é' }]);
  start = writes().length;
  const textarea = a.term.textarea; textarea.value = '';
  textarea.dispatchEvent(new w.CompositionEvent('compositionstart', { bubbles: true }));
  keyboard(a, 'keydown', 'Process', { keyCode: 229, which: 229, isComposing: true });
  textarea.value = '输入法';
  textarea.dispatchEvent(new w.CompositionEvent('compositionupdate', { data: '输入法', bubbles: true }));
  textarea.dispatchEvent(new w.InputEvent('input', { data: '输入法', inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
  await settle();
  await expectWrites('I10 incomplete IME composition emits neither text nor Enter', start, []);
  keyboard(a, 'keydown', 'Enter', { keyCode: 229, which: 229, isComposing: true });
  await expectWrites('I10 Enter used to confirm IME composition does not submit the shell line', start, []);
  textarea.dispatchEvent(new w.CompositionEvent('compositionend', { data: '输入法', bubbles: true }));
  await settle(); keyboard(a, 'keyup', 'Process', { keyCode: 229, which: 229 });
  await expectWrites('I11 committed IME text is sent exactly once without a newline', start, [{ id: a.ptyId, data: '输入法' }]);
  // Some IMEs use keyCode 229 for a digit/punctuation without a composition
  // sequence. xterm intentionally detects the subsequent textarea mutation.
  // First prove this event trace against a reference xterm with no app handler.
  const referenceHost = d.createElement('div'); d.body.append(referenceHost);
  const reference = new w.Terminal({ cols: 80, rows: 24 }); reference.open(referenceHost);
  const referenceData = []; reference.onData(data => referenceData.push(data));
  reference.textarea.value = '';
  keyboard({ term: reference }, 'keydown', 'Process', { keyCode: 229, which: 229, isComposing: false });
  reference.textarea.value = '7';
  keyboard({ term: reference }, 'keyup', 'Process', { keyCode: 229, which: 229 }); await settle();
  check('I11 reference xterm preserves a non-composing IME digit through textarea fallback', referenceData, ['7']);
  reference.dispose(); referenceHost.remove();
  textarea.value = ''; start = writes().length;
  keyboard(a, 'keydown', 'Process', { keyCode: 229, which: 229, isComposing: false });
  textarea.value = '7'; keyboard(a, 'keyup', 'Process', { keyCode: 229, which: 229 });
  await expectWrites('I11 app key handling preserves xterm non-composing IME textarea fallback', start, [{ id: a.ptyId, data: '7' }]);

  await writeOutput(a, '\r\nNew password: ');
  const secret = 'Fixture-NoEcho-Pa55!'; start = writes().length;
  for (const char of secret) stroke(a, char);
  await expectWrites('I12 password prompt receives literal typing without an automatic submission', start,
    Array.from(secret, data => ({ id: a.ptyId, data })));
  stroke(a, 'Enter'); UI.renderOutline();
  check('I13 no-echo input is absent from outline, UI logs, terminal output and saved state',
    !JSON.stringify(a.outline).includes(secret) && !JSON.stringify(UI.logs).includes(secret)
    && !outputText(a).includes(secret)
    && !calls.filter(([command]) => ['ui_state_save', 'sessions_save', 'session_log_append'].includes(command)).some(([, args]) => JSON.stringify(args).includes(secret)));
  check('I14 typing never creates speculative raw-input outline entries', a.outline.length, 0);
  const publicCommand = 'printf public-command';
  for (const char of publicCommand) stroke(a, char);
  await writeOutput(a, '\r\nfixture$ ' + publicCommand);
  stroke(a, 'Enter');
  check('I14 a command already echoed publicly can still enter the outline',
    a.outline.some(entry => entry.text === publicCommand));

  // A binary transfer owns its PTY. Test both source and broadcast-target guards.
  busy.add(a); start = writes().length;
  const busyBinaryStart = binaryWrites().length;
  stroke(a, 'x'); stroke(a, 'Enter'); a.term.input('\x00\x01\x02', true); binaryInput(a, [0, 127, 128, 255]); nativePaste(a, 'blocked');
  clipboardText = 'blocked-clipboard';
  for (const invoke of Object.values(pasteEntries)) await invoke(a);
  await settle();
  await expectWrites('I15 binary-transfer ownership blocks keyboard, binary data and every paste path', start, []);
  check('I15 binary-transfer ownership also blocks every write_binary invocation', binaryWrites().slice(busyBinaryStart), []);
  T.s.sync = true; T.s.mode = 'Remote'; start = writes().length; stroke(a, 'y');
  await expectWrites('I16 a busy source cannot broadcast user input into another machine', start, []);
  start = writes().length; stroke(b, 'z');
  await expectWrites('I17 synchronized input skips a busy target', start, [{ id: b.ptyId, data: 'z' }]);
  busy.clear(); T.s.sync = false; start = writes().length; stroke(a, 'a');
  await expectWrites('I18 synchronization is disabled by default and after explicitly disabling it', start, [{ id: a.ptyId, data: 'a' }]);
  T.s.sync = true; T.s.mode = 'Local'; start = writes().length; stroke(a, 'b');
  await expectWrites('I19 Local mode does not broadcast even with sync enabled', start, [{ id: a.ptyId, data: 'b' }]);
  T.s.mode = 'Remote'; start = writes().length; stroke(a, 'c');
  await settle();
  check('I20 explicitly enabled Remote synchronization sends once to each current PTY',
    writes().slice(start).map(({ id, data }) => id + ':' + data).sort(), [a.ptyId + ':c', b.ptyId + ':c'].sort());
  const binaryStart = binaryWrites().length;
  binaryInput(a, [0, 127, 128, 255]); await settle();
  check('I20 binary mouse data preserves all 8-bit bytes and never broadcasts to another pane',
    binaryWrites().slice(binaryStart), [{ id: a.ptyId, data: [0, 127, 128, 255] }]);
  T.s.sync = false;

  // Bracketed-paste negotiation must be obeyed by browser, toolbar, shortcut,
  // middle-click and right-click entry points, with no appended CR.
  const pasted = 'echo first\n中文🙂\r\nlast';
  for (const enabled of [false, true]) {
    await writeOutput(a, '\x1b[?2004' + (enabled ? 'h' : 'l'));
    const expected = (enabled ? '\x1b[200~' : '') + 'echo first\r中文🙂\rlast' + (enabled ? '\x1b[201~' : '');
    clipboardText = pasted;
    for (const [entry, invoke] of Object.entries(pasteEntries)) {
      start = writes().length; await invoke(a); await settle();
      await expectWrites('I21 ' + entry + ' paste ' + (enabled ? 'uses negotiated brackets' : 'uses native newline normalization') + ' without added CR', start, [{ id: a.ptyId, data: expected }]);
    }
    start = writes().length; nativePaste(a, pasted);
    await expectWrites('I22 browser paste ' + (enabled ? 'uses negotiated brackets' : 'preserves unbracketed mode') + ' without added CR', start, [{ id: a.ptyId, data: expected }]);
  }
  T.s.rightClickPaste = false; start = writes().length; pasteEntries.right(a); await settle();
  await expectWrites('I23 explicitly disabling right-click paste prevents clipboard writes', start, []);
  T.s.rightClickPaste = true;
  for (const [entry, invoke] of Object.entries(pasteEntries)) {
    clipboardText = ''; start = writes().length; await invoke(a); await settle();
    await expectWrites('I24 empty ' + entry + ' paste sends nothing', start, []);
  }

  for (const [entry, invoke] of Object.entries(pasteEntries)) {
    for (const change of ['switch', 'reconnect', 'close']) {
      const target = await create('race-' + entry + '-' + change);
      await writeOutput(target, '\x1b[?2004h');
      let resolveClipboard;
      clipboardRead = () => new Promise(resolve => { resolveClipboard = resolve; });
      TM.activate(target.id); start = writes().length;
      const operation = invoke(target);
      check('I25 ' + entry + '/' + change + ' starts one pending clipboard read', typeof resolveClipboard, 'function');
      const oldNative = target.ptyId;
      if (change === 'reconnect') {
        TM.handleExit(target, oldNative);
        // Reusing a native ID proves the generation check is also required.
        interceptor = command => command === 'connect_ssh' ? Promise.resolve(oldNative) : null;
        await TM.reconnect(target); interceptor = null;
      } else if (change === 'close') await TM.close(target.id);
      TM.activate(b.id);
      resolveClipboard('ORIGINAL-TARGET-ONLY');
      await operation; await settle(); clipboardRead = null;
      await expectWrites('I26 pending ' + entry + ' paste after ' + change + ' cannot reach another machine or a replacement generation', start,
        change === 'switch' ? [{ id: oldNative, data: '\x1b[200~ORIGINAL-TARGET-ONLY\x1b[201~' }] : []);
      if (change !== 'close') await TM.close(target.id);
    }
  }

  // Weak-network regression: keyboard events may arrive faster than the native
  // bridge can acknowledge them. Never race writes, retry uncertain delivery or
  // replay an old queue into a replacement connection.
  const weak = await create('weak-network-order');
  let resolveSlow, rejectSlow, captured = 0;
  interceptor = (command, args) => command === 'write' && args.id === weak.ptyId && captured++ === 0
    ? new Promise((resolve, reject) => { resolveSlow = resolve; rejectSlow = reject; }) : null;
  start = writes().length;
  stroke(weak, 'a'); stroke(weak, 'b'); stroke(weak, 'Enter');
  await expectWrites('I31 slow ACK keeps only the first native write in flight', start, [{ id: weak.ptyId, data: 'a' }]);
  stroke(b, 'q'); await settle();
  await expectWrites('I31 another PTY remains independent while one ACK is slow', start,
    [{ id: weak.ptyId, data: 'a' }, { id: b.ptyId, data: 'q' }]);
  resolveSlow(); await settle();
  await expectWrites('I32 resolving a slow ACK drains every queued byte once and in order', start,
    [{ id: weak.ptyId, data: 'a' }, { id: b.ptyId, data: 'q' }, { id: weak.ptyId, data: 'b' }, { id: weak.ptyId, data: '\r' }]);
  interceptor = null; await TM.close(weak.id);

  const failed = await create('weak-network-failure'); captured = 0;
  interceptor = (command, args) => command === 'write' && args.id === failed.ptyId && captured++ === 0
    ? new Promise((resolve, reject) => { resolveSlow = resolve; rejectSlow = reject; }) : null;
  start = writes().length;
  stroke(failed, 'a'); stroke(failed, 'b'); stroke(failed, 'Enter'); await settle();
  const backendSecret = 'Fixture-Backend-Secret-Must-Not-Appear';
  rejectSlow(new Error(backendSecret)); await settle();
  await expectWrites('I33 a failed write pauses later queued input without retrying uncertain delivery', start, [{ id: failed.ptyId, data: 'a' }]);
  check('I33 uncertain write failures visibly pause input without exposing backend error details',
    d.querySelector('#toasts').textContent.includes('已暂停')
    && ![outputText(failed), JSON.stringify(UI.logs), consoleMessages.join('\n'), d.querySelector('#toasts').textContent].some(text => text.includes(backendSecret)));
  stroke(failed, 'x'); await settle();
  await expectWrites('I34 later typing cannot silently bypass a failed write queue', start, [{ id: failed.ptyId, data: 'a' }]);
  stroke(failed, 'c', { ctrlKey: true }); await settle();
  await expectWrites('I35 explicit Ctrl+C discards unsent characters and attempts exactly one interrupt', start,
    [{ id: failed.ptyId, data: 'a' }, { id: failed.ptyId, data: '\x03' }]);
  stroke(failed, 'r');
  await expectWrites('I35 fresh typing resumes after Ctrl+C without replaying failed queued input', start,
    [{ id: failed.ptyId, data: 'a' }, { id: failed.ptyId, data: '\x03' }, { id: failed.ptyId, data: 'r' }]);
  interceptor = null; await TM.close(failed.id);

  const abandoned = await create('weak-network-reconnect'), abandonedNative = abandoned.ptyId;
  captured = 0;
  interceptor = (command, args) => command === 'write' && args.id === abandonedNative && captured++ === 0
    ? new Promise(resolve => { resolveSlow = resolve; }) : null;
  start = writes().length;
  stroke(abandoned, 'a'); stroke(abandoned, 'b'); stroke(abandoned, 'Enter'); await settle();
  TM.handleExit(abandoned, abandonedNative); await TM.reconnect(abandoned);
  resolveSlow(); await settle();
  await expectWrites('I36 reconnect never replays the previous connection queue after its late ACK', start, [{ id: abandonedNative, data: 'a' }]);
  stroke(abandoned, 'n'); await settle();
  await expectWrites('I37 a new connection generation accepts only fresh intentional input', start,
    [{ id: abandonedNative, data: 'a' }, { id: abandoned.ptyId, data: 'n' }]);
  interceptor = null; await TM.close(abandoned.id);

  const cancelled = await create('weak-network-interrupt'); captured = 0;
  interceptor = (command, args) => command === 'write' && args.id === cancelled.ptyId && captured++ === 0
    ? new Promise(resolve => { resolveSlow = resolve; }) : null;
  start = writes().length;
  stroke(cancelled, 'a'); stroke(cancelled, 'b'); stroke(cancelled, 'Enter'); await settle();
  stroke(cancelled, 'c', { ctrlKey: true }); resolveSlow(); await settle();
  await expectWrites('I38 Ctrl+C during a slow ACK cancels pending text and Enter before interrupting', start,
    [{ id: cancelled.ptyId, data: 'a' }, { id: cancelled.ptyId, data: '\x03' }]);
  interceptor = null; await TM.close(cancelled.id);

  const closedQueue = await create('weak-network-close'), closedNative = closedQueue.ptyId;
  captured = 0;
  interceptor = (command, args) => command === 'write' && args.id === closedNative && captured++ === 0
    ? new Promise(resolve => { resolveSlow = resolve; }) : null;
  start = writes().length;
  stroke(closedQueue, 'a'); stroke(closedQueue, 'b'); stroke(closedQueue, 'Enter'); await settle();
  await TM.close(closedQueue.id); resolveSlow(); await settle();
  await expectWrites('I39 closing a tab cancels its unsent input even when the old ACK arrives late', start, [{ id: closedNative, data: 'a' }]);
  interceptor = null;

  const mixedQueue = await create('weak-network-binary-order'); captured = 0;
  interceptor = (command, args) => command === 'write' && args.id === mixedQueue.ptyId && captured++ === 0
    ? new Promise(resolve => { resolveSlow = resolve; }) : null;
  const mixedStart = calls.length;
  const mixedCalls = () => calls.slice(mixedStart).filter(([command, args]) => ['write', 'write_binary'].includes(command) && args.id === mixedQueue.ptyId)
    .map(([command, args]) => ({ command, data: command === 'write_binary' ? Array.from(args.data) : args.data }));
  stroke(mixedQueue, 'a'); binaryInput(mixedQueue, [0, 127, 128, 255]); stroke(mixedQueue, 'b'); await settle();
  check('I40 text and binary input share one FIFO while an earlier ACK is pending', mixedCalls(), [{ command: 'write', data: 'a' }]);
  resolveSlow(); await settle();
  check('I41 mixed text/binary FIFO preserves byte boundaries and ordering after ACK', mixedCalls(),
    [{ command: 'write', data: 'a' }, { command: 'write_binary', data: [0, 127, 128, 255] }, { command: 'write', data: 'b' }]);
  interceptor = null; await TM.close(mixedQueue.id);

  const overflow = await create('weak-network-overflow');
  const overflowMarker = 'FIXTURE-OVERSIZE-INPUT-'; start = writes().length;
  const acceptedOverflow = await TM.writeTo(overflow, overflowMarker + 'x'.repeat(1048576));
  await settle();
  check('I42 input exceeding 1 MiB is rejected visibly without leaking its content', acceptedOverflow === false
    && d.querySelector('#toasts').textContent.includes('已暂停')
    && !outputText(overflow).includes(overflowMarker) && !JSON.stringify(UI.logs).includes(overflowMarker));
  stroke(overflow, 'x');
  await expectWrites('I43 oversize input and later typing cannot bypass the paused queue', start, []);
  stroke(overflow, 'c', { ctrlKey: true }); stroke(overflow, 'r');
  await expectWrites('I44 Ctrl+C resumes an oversize-paused queue without replaying rejected text', start,
    [{ id: overflow.ptyId, data: '\x03' }, { id: overflow.ptyId, data: 'r' }]);
  await TM.close(overflow.id);

  const triggered = await create('trigger-ui-failure');
  T.s.triggers = [{ pattern: 'FIXTURE-TRIGGER', action: 'send', arg: 'FALLBACK-MUST-NOT-RUN' }];
  interceptor = command => command === 'triggers_feed'
    ? Promise.resolve([{ action: 'send', text: 'BACKEND-SEND-ONCE', ruleId: 1 }]) : null;
  const originalLog = UI.log;
  UI.log = () => { throw new Error('fixture: UI rendering failed after backend action'); };
  start = writes().length;
  TM.runTriggers(triggered, 'FIXTURE-TRIGGER'); await settle();
  UI.log = originalLog; interceptor = null; T.s.triggers = [];
  await expectWrites('I45 a UI exception after a backend trigger send never invokes fallback or resends input', start,
    [{ id: triggered.ptyId, data: 'BACKEND-SEND-ONCE' }]);
  await TM.close(triggered.id);

  // Keep the actual global listener and xterm custom-key handler. Replace only
  // action bodies to prove the UI action runs once without closing this fixture.
  const shortcutCases = [
    ['P', { ctrlKey: true, shiftKey: true }, UI, 'openPalette'],
    ['E', { ctrlKey: true, shiftKey: true }, TM, 'splitActive'],
    ['D', { ctrlKey: true, shiftKey: true }, TM, 'splitActive'],
    ['W', { ctrlKey: true, shiftKey: true }, TM, 'unsplit'],
    ['C', { ctrlKey: true, shiftKey: true }, UI, 'copy'],
    ['T', { ctrlKey: true, shiftKey: true }, TM, 'newLocal'],
    ['F', { ctrlKey: true, shiftKey: true }, UI, 'openSearch'],
    ['B', { ctrlKey: true, shiftKey: true }, UI, 'toggleDock'],
    ['M', { ctrlKey: true, shiftKey: true }, UI, 'openProfiles'],
    ['w', { metaKey: true }, TM, 'closeTab'],
    ['t', { metaKey: true }, TM, 'newLocal'],
    ['b', { metaKey: true }, UI, 'toggleDock'],
    ['m', { metaKey: true }, UI, 'openProfiles'],
    [',', { metaKey: true }, w.Settings, 'toggle'],
    ['=', { metaKey: true }, TM, 'zoom'],
    ['-', { metaKey: true }, TM, 'zoom'],
    ['1', { metaKey: true }, UI, 'setDockPane'],
    ['2', { metaKey: true }, w.SftpPanel, 'toggle'],
    ['3', { metaKey: true }, UI, 'setDockPane'],
    ['4', { metaKey: true }, w.TransferQueue, 'toggle'],
    ['5', { metaKey: true }, UI, 'setDockPane'],
    ['6', { metaKey: true }, UI, 'setDockPane'],
    ['f', { metaKey: true }, UI, 'openSearch'],
  ];
  for (const [key, modifiers, owner, method] of shortcutCases) {
    const previous = owner[method]; let performed = 0;
    owner[method] = () => { performed++; };
    TM.activate(a.id); start = writes().length;
    const event = stroke(a, key, modifiers); await settle();
    check('I27 ' + (modifiers.ctrlKey ? 'Ctrl+' : modifiers.metaKey ? 'Cmd+' : '') + (modifiers.shiftKey ? 'Shift+' : '') + key + ' runs its UI action once', performed, 1);
    await expectWrites('I28 shortcut ' + key + ' never also sends a control byte or escape sequence to the PTY', start, []);
    check('I29 handled shortcut ' + key + ' prevents the browser default', event.defaultPrevented);
    owner[method] = previous;
  }
  for (const [key, code, keyCode, owner, method, expectedArgs] of [
    ['!', 'Digit1', 49, UI, 'setDockPane', ['explorer']],
    ['@', 'Digit2', 50, w.SftpPanel, 'toggle', []],
    ['_', 'Minus', 189, TM, 'zoom', [-1]],
  ]) {
    const previous = owner[method], performed = [];
    owner[method] = (...args) => { performed.push(args); };
    TM.activate(a.id); start = writes().length;
    const event = stroke(a, key, { ctrlKey: true, shiftKey: true, code, keyCode, which: keyCode });
    await settle();
    check('I46 real shifted Ctrl+Shift+' + key + ' invokes the physical-key action exactly once', performed, [expectedArgs]);
    await expectWrites('I47 shifted shortcut ' + key + ' sends no terminal input', start, []);
    check('I48 shifted shortcut ' + key + ' prevents the browser default', event.defaultPrevented);
    owner[method] = previous;
  }
  check('I30 no JavaScript errors during real xterm input regressions', errors, []);
  console.log(`\nRESULT ${checks.length} passed, ${failures.length} failed, ${errors.length} JavaScript errors`);
  if (failures.length) process.exitCode = 1;
} catch (error) {
  console.error('FAIL fixture: ' + (error.stack || error)); process.exitCode = 1;
} finally {
  interceptor = null; clipboardRead = null; busy.clear();
  for (const id of [...TM.order]) await TM.close(id);
  dom.window.close();
  clearTimeout(deadline);
}
