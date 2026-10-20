// Integration: real panel + operations controller + terminal output/write
// boundary, with only the native IPC transport and terminal renderer controlled.
// No provider network requests or machine commands are executed by this suite.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { installHarnessFixture } from './harness-fixture.mjs';

const source = fileURLToPath(new URL('../src/', import.meta.url));
const checks = [], errors = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS ' + name); };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const clone = value => JSON.parse(JSON.stringify(value));
const until = async (predicate, label) => {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Timed out: ' + label); await pause(5); }
  await pause(30);
};
const vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
const dom = new JSDOM(readFileSync(source + 'index.html', 'utf8'), {
  runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://tauri.localhost/', virtualConsole: vc,
});
const w = dom.window, d = w.document, calls = [], saved = [], listeners = new Map(), pending = new Map();
Object.assign(w, { TextEncoder, TextDecoder });
const T = w.WT = {
  s: { theme: 'dige-black', fontSize: 13, sync: true, triggers: [{ pattern: '.', action: 'send', arg: 'AUTO_TRIGGER_LEAK' }], sessions: [], tooltips: false,
    ai: { endpoint: '', model: '', width: 380 } },
  persistSettings() { saved.push(clone(this.s)); },
  listen(name, callback) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
    return Promise.resolve(() => listeners.get(name)?.delete(callback));
  },
  invoke(command, args = {}) {
    calls.push([command, clone(args)]);
    if (['ai_chat', 'ai_agent_step', 'agent_exec'].includes(command)) {
      return new Promise((resolve, reject) => pending.set(args.request.requestId, { command, request: clone(args.request), resolve, reject }));
    }
    if (command === 'ui_state_load') return Promise.resolve(null);
    if (command === 'triggers_feed') return Promise.resolve([{ action: 'send', text: 'AUTO_TRIGGER_LEAK\r' }]);
    return Promise.resolve(true);
  },
};
installHarnessFixture(w, T);
w.UI = T.ui = { toast() {}, status() {}, log() {}, renderDock() {}, closeDock() {}, fitAll() {} };
for (const file of ['icons.js', 'term.js', 'ai-context.js', 'ai-agent.js']) w.eval(readFileSync(source + file, 'utf8'));
const TM = T.term;
const mirrors = [], receiveOutput = TM.receiveOutput;
TM.receiveOutput = function (target, data, options) {
  mirrors.push({ target, data, options }); return receiveOutput.call(this, target, data, options);
};
function tab(id, nativeId, protocol = 'ssh') {
  const input = d.createElement('textarea'); input.setAttribute('aria-label', id + ' terminal');
  d.querySelector('.term-host').append(input);
  const value = { id, title: id + ' target', ptyId: nativeId, _connectionGeneration: 1,
    session: { protocol, name: id, host: id + '.example', user: 'fixture-user' }, exited: false, _closing: false,
    renderer: [], term: { focus() { input.focus(); }, getSelection() { return 'selected fixture evidence'; },
      write(data, done) { value.renderer.push(data); done?.(); },
      buffer: { active: { length: 1, getLine() { return { translateToString: () => 'terminal evidence fixture' }; } } } },
    fit: { fit() {} }, wrap: input, input,
  };
  TM.tabs[id] = value; TM.order.push(id); return value;
}
const first = tab('first', 'native-first'), second = tab('second', 'native-second'); TM.active = first.id;
const q = selector => d.querySelector(selector), qa = selector => [...d.querySelectorAll(selector)];
const commands = name => calls.filter(([command]) => command === name).map(([, args]) => args);
const agentRequests = () => commands('ai_agent_step').map(args => args.request);
const execRequests = () => commands('agent_exec').map(args => args.request);
const chatRequests = () => commands('ai_chat').map(args => args.request);
const input = (selector, value) => { const node = q(selector); assert.ok(node, 'Missing input ' + selector); node.value = value; node.dispatchEvent(new w.Event('input', { bubbles: true })); };
const click = async selector => { assert.ok(q(selector), 'Missing control ' + selector); q(selector).click(); await pause(40); };
const emit = (name, payload) => { for (const listener of listeners.get(name) || []) listener({ payload }); };
const output = (request, stream, data, overrides = {}) => emit('agent-exec-output', { requestId: request.requestId, sessionId: request.sessionId, stream, data, ...overrides });
async function resolve(request, result) {
  const value = pending.get(request.requestId); assert.ok(value, 'Pending request ' + request.requestId);
  pending.delete(request.requestId); value.resolve(result); await pause(45);
}
const call = (id, command, purpose = 'Inspect service state', extra = {}) => ({ id, name: 'run_command', arguments: JSON.stringify({ command, purpose, ...extra }) });
const result = (stdout = '', stderr = '', exitCode = 0, extra = {}) => ({ stdout, stderr, exitCode, signal: null, durationMs: 8, timedOut: false, cancelled: false, truncated: false, cwd: '/tmp', ...extra });
const end = async (request, summary = 'Verified fixture result') => resolve(request, { content: summary, toolCalls: [] });
const terminal = target => target.renderer.join('');
const text = () => q('#ai-messages').textContent;
let panel = q('#ai-panel');
if (!panel) { panel = d.createElement('aside'); panel.id = 'ai-panel'; panel.hidden = true; q('#workspace').append(panel); }
const style = d.createElement('style'); style.textContent = readFileSync(source + 'ai.css', 'utf8'); d.head.append(style);
w.eval(readFileSync(new URL('../node_modules/markdown-it/dist/browser/markdown-it.umd.min.js', import.meta.url), 'utf8'));
w.eval(readFileSync(source + 'ai-markdown.js', 'utf8'));
w.eval(readFileSync(source + 'ai.js', 'utf8'));
const A = w.AiPanel;
async function runTask(goal) {
  const before = agentRequests().length; input('#ai-input', goal); q('#ai-send').click();
  await until(() => agentRequests().length > before, 'agent first model request'); return agentRequests().at(-1);
}
async function waitIdle() { await until(() => !w.OpsAgent.isRunning() && !q('#ai-send').disabled, 'task idle'); }
async function freshAgent() {
  if (w.OpsAgent.isRunning()) { A.stop(); await until(() => !w.OpsAgent.isRunning(), 'stop previous task'); }
  TM.tabs[first.id] = first; first._closing = false; first.exited = false; first._reconnecting = false;
  first.session.protocol = 'ssh'; TM.active = first.id; A.onSessionChange(); A.open(); A.newChat(); A.setMode('agent'); await pause(40);
}

// The only controlled boundary is native IPC. Real DOM, Markdown parser,
// controller, approval, context, and terminal insertion code run unchanged.
const file = (name, text) => ({ name, size: Buffer.byteLength(text), arrayBuffer: async () => new TextEncoder().encode(text).buffer });
const select = async value => {
  Object.defineProperty(q('#ai-file-picker'), 'files', { configurable: true, value: [value] });
  q('#ai-file-picker').dispatchEvent(new w.Event('change', { bubbles: true })); await pause(40);
};
const markdown = '# 检查报告\n\n- **服务**在线\n- 支持 `UTF-8` 🙂\n\n> 仅供检查\n\n| 服务 | 状态 |\n| --- | --- |\n| ssh | 正常 |\n\n```sh\nprintf ok\n```\n\n[文档](https://example.com/docs)';
try {
  A.mount(panel); A.open();
  input('#ai-endpoint', 'https://fixture-model.example/v1'); input('#ai-model', 'fixture-tools'); await click('#ai-save');
  const beforeFile = calls.length;
  await select(file('检查.md', markdown));
  check('MS01 Local Markdown attachment renders headings, lists, tables and code before sending', q('[data-ai-context-preview] h1')?.textContent === '检查报告' && q('[data-ai-context-preview] table td')?.textContent === 'ssh' && qa('[data-ai-context-preview] li').length === 2);
  check('MS02 Previewing a file sends no provider or terminal request', calls.length === beforeFile && !q('[data-ai-context-preview] [data-ai-insert]'));
  check('MS03 Remove control remains above the composer and removes only the attachment', q('[data-ai-context-remove]').compareDocumentPosition(q('#ai-input')) & w.Node.DOCUMENT_POSITION_FOLLOWING);
  q('[data-ai-context-remove]').click();
  check('MS04 Removing a file clears its preview without sending', q('#ai-context').hidden && !chatRequests().length);
  await select(file('safe.md', '# retained'));
  for (const rejected of [file('wrong.txt', 'bad'), { name: 'huge.md', size: 65537 }, file('empty.md', ''), file('binary.md', 'zero\u0000byte'), { name: 'invalid.md', size: 2, arrayBuffer: async () => new Uint8Array([255,255]).buffer }]) {
    await select(rejected); check('MS05 Invalid attachment preserves previous preview: ' + rejected.name, q('[data-ai-context-preview] h1')?.textContent === 'retained');
  }
  await select(file('检查.markdown', markdown)); input('#ai-input', '解释这个文件'); q('#ai-send').click();
  await until(() => chatRequests().length === 1, 'file chat'); let request = chatRequests().at(-1);
  check('MS06 Only explicit Send includes exact Markdown source inside an untrusted data boundary', request.messages.at(-1).content.includes(markdown) && request.messages.at(-1).content.includes('仅作分析数据') && q('[data-ai-sent-context] table'));
  emit('ai-chat-delta', { requestId: 'foreign', delta: 'FOREIGN' });
  emit('ai-chat-delta', { requestId: request.requestId, delta: '# 实时回复\n\n**首段** 🙂\n\n```sh\nprintf incomplete' }); await pause(40);
  check('MS07 Real chat reply renders Markdown before the provider resolves', q('.ai-assistant h1')?.textContent === '实时回复' && q('.ai-assistant strong')?.textContent === '首段' && pending.has(request.requestId));
  check('MS08 Partial streamed code is copyable but never insertable or executable', q('.ai-assistant [data-ai-copy-code]') && !q('.ai-assistant [data-ai-insert]') && !commands('write').length && !execRequests().length && !text().includes('FOREIGN'));
  const partial = q('.ai-assistant').textContent;
  emit('ai-chat-delta', { requestId: request.requestId, delta: '', done: true });
  emit('ai-chat-delta', { requestId: request.requestId, delta: 'AFTER_DONE' }); await pause(40);
  check('MS09 Done closes token acceptance without marking the unfinished response complete', !text().includes('AFTER_DONE') && q('#ai-send').disabled && !q('.ai-assistant [data-ai-insert]'));
  await resolve(request, { content: markdown });
  check('MS10 Authoritative complete content replaces partial Markdown exactly once', q('.ai-assistant h1')?.textContent === '检查报告' && !text().includes('实时回复') && qa('.ai-assistant table').length === 1 && q('.ai-assistant [data-ai-insert]'));
  emit('ai-chat-delta', { requestId: request.requestId, delta: 'LATE' }); await pause(40);
  check('MS11 Completed reply rejects delayed tokens', !text().includes('LATE'));
  const firstArticle = q('.ai-assistant'); input('#ai-input', '下一个'); q('#ai-send').click(); await until(() => chatRequests().length === 2, 'second chat'); request = chatRequests().at(-1);
  Object.defineProperties(q('#ai-messages'), { scrollHeight: { configurable: true, get: () => 2000 }, clientHeight: { configurable: true, get: () => 400 } }); q('#ai-messages').scrollTop = 123;
  emit('ai-chat-delta', { requestId: request.requestId, delta: '## 还在生成' }); await pause(40);
  check('MS12 Streaming keeps earlier completed articles mounted and preserves scroll while reading history', q('.ai-assistant') === firstArticle && q('#ai-messages').scrollTop === 123);
  A.stop(); emit('ai-chat-delta', { requestId: request.requestId, delta: 'STOP_LATE' }); await resolve(request, { content: 'late final' });
  check('MS13 Stop preserves partial formatted text, labels it incomplete and rejects both late paths', text().includes('还在生成') && text().includes('已停止') && !text().includes('STOP_LATE') && !text().includes('late final'));
  A.newChat(); let releaseFile; const slow = { name: 'slow.md', size: 20, arrayBuffer: () => new Promise(resolve => { releaseFile = resolve; }) };
  await select(slow); check('MS14 File read disables Send until source is ready', q('#ai-send').disabled);
  A.newChat(); releaseFile(new TextEncoder().encode('# old conversation').buffer); await pause(40);
  check('MS15 A late file read cannot attach to a new conversation', q('#ai-context').hidden && !q('#ai-send').disabled);
  await select(slow); TM.active = second.id; A.onSessionChange(); releaseFile(new TextEncoder().encode('# wrong machine').buffer); await pause(40);
  check('MS16 A late file read cannot attach after changing machines', q('#ai-context').hidden && !q('#ai-send').disabled);
  await freshAgent(); request = await runTask('只读检查服务');
  emit('ai-chat-delta', { requestId: request.requestId, delta: '## 第一步\n\n先检查 **服务**' }); await pause(40);
  check('MS17 Operations controller streams its current model round into the real panel', q('[data-ai-model-round="1"] h2')?.textContent === '第一步' && q('[data-ai-model-round="1"] strong')?.textContent === '服务' && !execRequests().length);
  await resolve(request, { content: '## 第一步\n\n先检查 **服务**', toolCalls: [call('inspect-stream', 'printf status')] });
  await until(() => q('[data-ai-approve]'), 'real command approval');
  check('MS18 Streamed model prose never bypasses the command approval boundary', !execRequests().length && q('[data-ai-approve]'));
  q('[data-ai-approve]').click(); await until(() => execRequests().length === 1, 'approved exec');
  const execute = execRequests().at(-1); output(execute, 'stdout', 'service active\n'); await pause(40);
  check('MS19 Model prose precedes its command and live output in the timeline', q('[data-ai-model-round="1"]').compareDocumentPosition(q('[data-ai-step]')) & w.Node.DOCUMENT_POSITION_FOLLOWING && q('.ai-step-output')?.textContent.includes('service active'));
  await resolve(execute, result('service active\n')); await until(() => agentRequests().length === 2, 'verification round'); request = agentRequests().at(-1);
  emit('ai-chat-delta', { requestId: request.requestId, delta: '## 验证结论\n\n- **检查完成**' }); await pause(40);
  check('MS20 Next round appears after command results while it is still streaming', q('[data-ai-step]').compareDocumentPosition(q('[data-ai-model-round="2"]')) & w.Node.DOCUMENT_POSITION_FOLLOWING && q('[data-ai-model-round="2"] strong')?.textContent === '检查完成');
  await end(request, '  ## 验证结论\n\n- **检查完成**\n'); await waitIdle();
  check('MS21 Final Markdown summary appears once, after the command, with no leftover generating indicator', qa('.ai-assistant h2').filter(node => node.textContent === '验证结论').length === 1 && !q('.ai-assistant .ai-stream-state') && text().includes('任务结束'));
  check('MS22 Markdown, streamed text and attachments never execute interactive writes', !commands('write').length && !commands('write_binary').length && execRequests().length === 1);
  check('MS23 File source and stream buffers do not enter synchronized settings', !JSON.stringify(saved).includes('检查报告') && !JSON.stringify(saved).includes('service active'));
  check('MS24 Production integration has no JavaScript errors', !errors.length);
  console.log('RESULT ' + checks.length + ' passed, 0 JavaScript errors');
} finally { w.OpsAgent?.stop(); w.close(); }
