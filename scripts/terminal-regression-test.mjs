// Real xterm parser/cells for highlighting; controlled bridge latency for close races.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const errors = [], checks = [], invocations = [];
const vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
const dom = new JSDOM('<!doctype html><body><div id="groups"><div class="group" data-g="0"><div class="term-host"></div></div><div class="group" data-g="1"><div class="term-host"></div></div></div></body>', { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
const w = dom.window;
// No renderer is opened: xterm's parser and buffer need no canvas/font measurement.
w.HTMLCanvasElement.prototype.getContext = () => null;
w.eval(readFileSync(root + 'node_modules/@xterm/xterm/lib/xterm.js', 'utf8'));
let interceptor = null, homes = 0;
w.WT = {
  s: { theme: 'tabby-dark', triggers: [], builtinHighlight: true, fontSize: 13, backgroundOpacity: 100 },
  invoke(command, args) { invocations.push([command, args]); return interceptor?.(command, args) || Promise.resolve(null); },
  persistSettings() {}, flushLogs() {},
};
w.UI = { log() {}, status() {}, renderOutline() {}, beep() { throw new Error('closed tab must not beep'); } };
w.Home = { show() { homes++; }, hide() {} };
w.eval(readFileSync(root + 'src/term.js', 'utf8'));
const T = w.WT, TM = T.term;
let sequence = 0;
function check(name, condition) { assert.ok(condition, name); checks.push(name); console.log('PASS ' + name); }
function tab(cols = 20, rows = 8) {
  const term = new w.Terminal({ cols, rows, allowProposedApi: true, scrollback: 10000 });
  const calls = [], decorate = term.registerDecoration.bind(term);
  term.registerDecoration = options => { calls.push(options); return decorate(options); };
  const wrap = w.document.createElement('div'); w.document.querySelector('.term-host').appendChild(wrap);
  const result = { id: 'test-' + ++sequence, term, wrap, group: 0, fit: { fit() {} }, calls, outline: [] };
  TM.tabs[result.id] = result; TM.order.push(result.id); TM.active = result.id; return result;
}
const write = (t, text) => new Promise(resolve => t.term.write(text, resolve));
async function until(condition) {
  const deadline = Date.now() + 2000;
  while (!condition()) { if (Date.now() >= deadline) throw new Error('test deadline'); await new Promise(r => setTimeout(r, 2)); }
}

try {
  let t = tab();
  await write(t, '中文\x1b[31mError\x1b[0m'); TM.runHighlights(t);
  check('T1 ANSI/CJK部分行按实际字符单元定位，首行不偏到上一行', t.calls.length === 1 && t.calls[0].marker.line === 0 && t.calls[0].x === 4 && t.calls[0].width === 5);
  check('关键词只设置字体前景色，不设置背景色', t.calls[0].foregroundColor === '#d9534f' && !Object.hasOwn(t.calls[0], 'backgroundColor'));
  TM.runHighlights(t);
  check('T2 未变化的可见行不重复创建装饰', t.calls.length === 1);
  const faded = t._highlightEntries[0]; faded.expires = 0; TM.expireHighlights(t); TM.runHighlights(t);
  check('T3 已消退关键词不因后续扫描重新亮起', t._hls.length === 0 && t.calls.length === 1);
  await write(t, '\r\x1b[2Kplain'); TM.runHighlights(t);
  check('T4 进度行原位改写后清除旧关键词与marker', t._highlightEntries.length === 0 && t.term.markers.length === 0);
  await TM.close(t.id);

  t = tab(12);
  await write(t, '0123456789 Error\r\n'); TM.runHighlights(t);
  check('T5 跨视觉行的Error只高亮5个字符', t.calls.length === 2 && t.calls[0].x === 11 && t.calls[0].width === 1 && t.calls[1].x === 0 && t.calls[1].width === 4);
  await TM.close(t.id);
  t = tab(12);
  const url = 'https://example.com/abc';
  await write(t, 'go ' + url + '\r\n'); TM.runHighlights(t);
  check('T6 超长URL按真实换行分段，不画整行蓝带', t.calls.length === 3 && t.calls.reduce((n, options) => n + options.width, 0) === url.length && t.calls[0].x === 3);
  check('URL各段统一改字色且保留原背景', t.calls.every(o => o.foregroundColor === '#5aa9ff' && !Object.hasOwn(o, 'backgroundColor')));
  await TM.close(t.id);
  t = tab();
  await write(t, 'plain\r\nError on second row\r\n\x1b[H'); TM.runHighlights(t);
  check('T7 ANSI光标移回顶部仍高亮屏幕下方内容', t.calls.some(options => options.marker.line === 1));
  await write(t, '\x1b[?1049hError'); TM.runHighlights(t);
  check('T8 vim等备用屏幕不保留输出装饰', t._hls.length === 0 && t._highlightEntries.length === 0);
  await TM.close(t.id);
  t = tab(80, 24);
  await write(t, ('Error 192.168.1.1\r\n').repeat(5000)); TM.runHighlights(t);
  check('T9 大量输出只扫描有界viewport，不为5000行创建marker', t.calls.length <= 24 && t.term.markers.length <= 48);
  T.s.builtinHighlight = false; TM.runHighlights(t);
  check('T10 关闭内置高亮立即释放所有装饰和跟踪marker', t._hls.length === 0 && t.term.markers.length === 0);
  T.s.builtinHighlight = true; await TM.close(t.id);

  t = tab(); const callbacks = [], chunks = [];
  t.term.write = (text, callback) => { chunks.push(text); callbacks.push(callback); };
  const input = 'a'.repeat(65535) + '🙂' + 'b'.repeat(120000);
  TM.receiveOutput(t, input);
  await until(() => chunks.length === 1);
  check('T11 单个大IPC包拆成最多64KiB且不切断emoji', chunks[0].length <= 65536 && !/[\uD800-\uDBFF]$/.test(chunks[0]));
  for (let i = 0; i < 1000; i++) TM.receiveOutput(t, String(i) + ',');
  check('T12 等待xterm解析时不重复并发write', chunks.length === 1);
  while (chunks.join('').length < input.length + Array.from({ length: 1000 }, (_, i) => String(i).length + 1).reduce((a, b) => a + b, 0)) {
    callbacks.shift()(); await until(() => callbacks.length > 0);
  }
  callbacks.shift()();
  check('T13 合并1000个短包保持全部字节和顺序，减少write次数', chunks.join('') === input + Array.from({ length: 1000 }, (_, i) => i + ',').join('') && chunks.length < 10 && chunks.every(s => s.length <= 65536));
  await TM.close(t.id);

  t = tab(); let finishKill;
  interceptor = command => command === 'kill' ? new Promise(r => { finishKill = r; }) : null;
  const pending = TM.close(t.id);
  check('T14 native kill未返回时标签和终端视图已移除', !TM.tabs[t.id] && !t.wrap.isConnected && homes > 0);
  await TM.close(t.id);
  TM.receiveOutput(t, 'late output');
  check('T15 重复关闭与迟到输出不会再次kill或复活renderer', invocations.filter(([command, args]) => command === 'kill' && args.id === t.id).length === 1 && t._outputParts.length === 0);
  finishKill(); await pending; interceptor = null;

  t = tab(); let completeLog;
  interceptor = command => command === 'session_log_start' ? new Promise(r => { completeLog = r; }) : null;
  const openingLog = TM.startLog(t); await TM.close(t.id); completeLog('/tmp/test-only.log'); await openingLog;
  check('T16 开启日志未返回时关闭标签仍释放后续打开的文件句柄', !t.logging && invocations.some(([command, args]) => command === 'session_log_stop' && args.id === t.id));
  interceptor = null;
  t = tab(); let rejectTrigger;
  T.s.triggers = [{ pattern: 'late', action: 'bell' }];
  interceptor = command => command === 'triggers_feed' ? new Promise((_, reject) => { rejectTrigger = reject; }) : null;
  TM.runTriggers(t, 'late'); await TM.close(t.id); rejectTrigger(new Error('closed backend')); await new Promise(r => setTimeout(r, 5));
  check('T17 异步触发器失败回退不对已关闭标签执行动作', t._closing && !TM.tabs[t.id]);
  interceptor = null; T.s.triggers = [];

  t = tab(80, 24); T.s.triggers = [{ pattern: 'AGENT', action: 'send', send: 'unsafe\r' }];
  const triggerCount = invocations.filter(([command]) => command === 'triggers_feed').length;
  interceptor = command => command === 'triggers_feed' ? Promise.resolve([]) : null;
  TM.receiveOutput(t, 'AGENT' + 'a'.repeat(70000) + '🙂', { triggers: false });
  await until(() => !t._outputTimer && !t._outputWriting && !t._outputParts.length);
  check('T22 Agent大输出分块显示但不会进入自动发送触发器', invocations.filter(([command]) => command === 'triggers_feed').length === triggerCount);
  const beforeMixed = invocations.length;
  TM.receiveOutput(t, 'REAL'); TM.receiveOutput(t, 'AGENT', { triggers: false }); TM.receiveOutput(t, 'TAIL');
  await until(() => !t._outputTimer && !t._outputWriting && !t._outputParts.length);
  const genuine = invocations.slice(beforeMixed).filter(([command]) => command === 'triggers_feed');
  check('T23 混合输出保留真实PTY触发器且不把Agent数据传给引擎', genuine.length === 1 && genuine[0][1].data === 'REAL\nTAIL');
  interceptor = null; T.s.triggers = []; await TM.close(t.id);

  t = tab(); TM.highlightHit(t);
  check('T18 自定义触发器高亮有独立可回收marker', t.term.markers.length === 1);
  check('自定义触发器高亮同样只改字色', t.calls[0].foregroundColor === '#f0ad4e' && !Object.hasOwn(t.calls[0], 'backgroundColor'));
  TM.clearHighlights(t);
  check('T19 清理同时释放触发器计时器与marker', t.term.markers.length === 0 && t._hitHighlights.size === 0);
  await TM.close(t.id);
  check('T20 Tabby默认颜色与原版终端palette一致', TM.THEMES['tabby-dark'].vars['--accent'] === '#4fadff' && TM.THEMES['tabby-dark'].term.background === '#171717' && TM.THEMES['tabby-dark'].term.selectionBackground === '#0059a559');
  check('T21 所有异步测试无JS错误', errors.length === 0);
  console.log(`\n合计 ${checks.length}/${checks.length} PASS，JS 错误 ${errors.length} 个`);
} catch (error) {
  console.error('FAIL ' + (error.stack || error)); process.exitCode = 1;
} finally {
  interceptor = null;
  for (const id of [...TM.order]) await TM.close(id);
  dom.window.close();
}
