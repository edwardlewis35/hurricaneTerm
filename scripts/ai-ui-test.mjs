// Exercise the production AI panel with its real DOM, terminal write boundary,
// and a controllable native IPC/event bridge. No network requests are made.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const source = fileURLToPath(new URL('../src/', import.meta.url));
const errors = [], checks = [], calls = [], saved = [], clipboard = [], listeners = new Map(), pending = new Map();
const vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
const dom = new JSDOM(readFileSync(source + 'index.html', 'utf8'), {
  runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://tauri.localhost/', virtualConsole: vc,
});
const w = dom.window, d = w.document;
let selectionReads = 0, outputReads = 0, fits = 0;
let holdWrite = false, releaseWrite;
const terminalLines = ['ordinary terminal output', 'explicit output context <img src=x onerror=alert(1)>'];
const T = w.WT = {
  s: { theme: 'dige-black', fontSize: 13, sync: true, triggers: [], sessions: [], tooltips: false,
    ai: { endpoint: '', model: '', width: 380 } },
  persistSettings() { saved.push(JSON.parse(JSON.stringify(this.s))); },
  listen(name, callback) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
    return Promise.resolve(() => listeners.get(name)?.delete(callback));
  },
  invoke(command, args = {}) {
    calls.push([command, args]);
    if (command === 'ai_chat') return new Promise((resolve, reject) => pending.set(args.request.requestId, { resolve, reject, request: args.request }));
    if (command === 'ai_cancel') return Promise.resolve(true);
    if (command === 'write' && holdWrite) return new Promise(resolve => { releaseWrite = resolve; });
    if (command === 'ui_state_load') return Promise.resolve(null);
    return Promise.resolve(true);
  },
};
Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async text => { clipboard.push(text); } }, configurable: true });
w.UI = T.ui = { toast() {}, status() {}, renderDock() {}, closeDock() {}, fitAll() { fits++; } };
for (const file of ['icons.js', 'term.js']) w.eval(readFileSync(source + file, 'utf8'));
const TM = T.term;
function tab(id, nativeId) {
  const input = d.createElement('textarea'); input.setAttribute('aria-label', id + ' terminal');
  d.querySelector('.term-host').append(input);
  const value = {
    id, ptyId: nativeId, session: { protocol: 'ssh', name: id, host: id + '.example' }, exited: false, _closing: false,
    term: {
      focus() { input.focus(); }, getSelection() { selectionReads++; return 'explicit selection context'; },
      buffer: { active: { length: terminalLines.length, baseY: 0, cursorY: 1,
        getLine(index) { outputReads++; return terminalLines[index] === undefined ? undefined : { translateToString: () => terminalLines[index] }; } } },
    },
    fit: { fit() {} }, wrap: input, input,
  };
  TM.tabs[id] = value; TM.order.push(id); return value;
}
const first = tab('first', 'native-first'), second = tab('second', 'native-second'); TM.active = first.id;
const q = selector => d.querySelector(selector), qa = selector => [...d.querySelectorAll(selector)];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log('PASS ' + name); };
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 25)); };
const input = (selector, value) => { const el = q(selector); assert.ok(el, 'Missing input ' + selector); el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
const click = async selector => { assert.ok(q(selector), 'Missing control ' + selector); q(selector).click(); await settle(); };
const emit = (requestId, delta, done = false) => {
  for (const listener of listeners.get('ai-chat-delta') || []) listener({ payload: { requestId, delta, done } });
};
const chats = () => calls.filter(([name]) => name === 'ai_chat').map(([, args]) => args.request);
const writes = () => calls.filter(([name]) => name === 'write');
const answer = async (request, content) => { pending.get(request.requestId).resolve({ content }); pending.delete(request.requestId); await settle(); };

let panel = q('#ai-panel');
if (!panel) { panel = d.createElement('aside'); panel.id = 'ai-panel'; panel.hidden = true; q('#workspace').append(panel); }
for (const file of ['ai.css']) { const style = d.createElement('style'); style.textContent = readFileSync(source + file, 'utf8'); style.dataset.file = file; d.head.append(style); }
w.eval(readFileSync(source + 'ai.js', 'utf8'));
const A = w.AiPanel;
const send = async value => { input('#ai-input', value); await click('#ai-send'); return chats().at(-1); };
const text = () => q('#ai-messages').textContent;
try {
  A.mount(panel); await settle();
  check('A01 Mount leaves assistant closed and starts no provider or terminal read', !A.isOpen() && chats().length === 0 && selectionReads === 0 && outputReads === 0);
  A.open();
  check('A02 First open shows configuration and focuses service address', A.isOpen() && !q('#ai-config').hidden && d.activeElement === q('#ai-endpoint'));
  check('A03 API key field is masked and marked against ordinary autocomplete', q('#ai-key').type === 'password' && q('#ai-key').autocomplete === 'new-password');
  input('#ai-endpoint', 'https://model.example/v1'); input('#ai-model', 'fixture-chat'); input('#ai-key', 'fixture-key-do-not-persist');
  await click('#ai-save');
  check('A04 Save retains only endpoint, model and width in persistent AI settings', Object.keys(T.s.ai).sort().join(',') === 'endpoint,model,width' && T.s.ai.endpoint === 'https://model.example/v1' && T.s.ai.model === 'fixture-chat');
  check('A05 Persistent settings contain neither API key nor conversation state', saved.length === 1 && !JSON.stringify(saved).includes('fixture-key-do-not-persist') && !('messages' in T.s.ai));
  check('A06 Saving configuration focuses composer and closes configuration form', q('#ai-config').hidden && d.activeElement === q('#ai-input'));
  const fitBefore = fits; A.toggle();
  check('A07 Closing the panel restores active terminal focus and refits layout', !A.isOpen() && d.activeElement === first.input && fits > fitBefore);
  A.toggle(); A.mount(panel);
  check('A08 Reopening preserves in-memory key without remounting duplicate controls', A.isOpen() && qa('#ai-send').length === 1);

  const firstRequest = await send('Explain this command <img src=x onerror=alert(1)>');
  check('A09 Send uses the configured endpoint, model and in-memory key', firstRequest.endpoint === 'https://model.example/v1' && firstRequest.model === 'fixture-chat' && firstRequest.apiKey === 'fixture-key-do-not-persist');
  check('A10 Plain prompt sends no automatic terminal context', firstRequest.messages.length === 2 && firstRequest.messages[1].role === 'user' && selectionReads === 0 && outputReads === 0);
  check('A11 User HTML-like content is rendered as text with no created image', text().includes('<img src=x onerror=alert(1)>') && !q('#ai-messages img'));
  check('A12 Pending send disables duplicate sends and exposes cancellation', q('#ai-send').disabled && !q('#ai-stop').hidden && q('#ai-save').disabled);
  const started = chats().length; await A.send();
  check('A13 Direct repeated send cannot create another pending request', chats().length === started);
  emit('unrelated-request', 'foreign stream'); emit(firstRequest.requestId, 'First **streamed** <svg onload=alert(1)>'); await settle();
  check('A14 Streaming routes only matching request and safely renders text emphasis', !text().includes('foreign stream') && text().includes('First streamed <svg onload=alert(1)>') && !!q('[data-ai-message="assistant"] strong') && !q('#ai-messages svg'));
  await answer(firstRequest, 'First **streamed** <svg onload=alert(1)>');
  check('A15 Final response replaces stream without duplication and restores sending', qa('[data-ai-message="assistant"]').length === 1 && !q('#ai-send').disabled && q('#ai-stop').hidden && (text().match(/First streamed/g) || []).length === 1);
  check('A16 Native delta subscription is registered once across a conversation', listeners.get('ai-chat-delta')?.size === 1);
  const followup = await send('Follow up');
  check('A17 Follow-up includes completed user/assistant turns once', followup.messages.length === 4 && followup.messages[2].role === 'assistant' && followup.messages.at(-1).content === 'Follow up');
  emit(followup.requestId, 'unfinished response'); await settle(); await click('#ai-stop');
  check('A18 Stop cancels the exact native request and marks partial response', calls.some(([command, args]) => command === 'ai_cancel' && args.requestId === followup.requestId) && text().includes('已停止') && !q('#ai-send').disabled);
  const cancelledText = text(); emit(followup.requestId, ' late delta', true); await answer(followup, 'late final after cancellation');
  check('A19 Cancelled request ignores late stream and late promise completion', text() === cancelledText);
  const afterCancel = await send('After cancelled request');
  check('A20 Cancelled exchange never enters later request history', !JSON.stringify(afterCancel.messages).includes('unfinished response') && !afterCancel.messages.some(message => message.content === 'Follow up'));
  emit(followup.requestId, 'old delta during new request'); emit(afterCancel.requestId, 'new response'); await settle();
  check('A21 A newer request cannot receive a cancelled request delta', !text().includes('old delta during new request') && text().includes('new response'));
  input('#ai-input', 'preserved draft'); await click('#ai-new');
  check('A22 New conversation cancels work and clears turns and input draft', qa('[data-ai-message]').length === 0 && q('#ai-input').value === '' && calls.some(([command, args]) => command === 'ai_cancel' && args.requestId === afterCancel.requestId));
  emit(afterCancel.requestId, 'old new-chat delta'); await answer(afterCancel, 'old new-chat final');
  check('A23 Late completion after new conversation cannot resurrect old messages', qa('[data-ai-message]').length === 0 && !text().includes('old new-chat'));

  const contextCalls = chats().length;
  await click('#ai-context-selection');
  check('A24 Selection is read only on explicit attach and is previewed before sending', selectionReads === 1 && q('[data-ai-context-preview]').textContent === 'explicit selection context' && chats().length === contextCalls);
  await click('[data-ai-context-remove]');
  check('A25 Removing context clears its preview without a provider request', q('#ai-context').hidden && !q('[data-ai-context-preview]') && chats().length === contextCalls);
  await click('#ai-context-output');
  check('A26 Recent output is explicitly previewed as safe text', outputReads === terminalLines.length && q('[data-ai-context-preview]').textContent.includes('<img src=x onerror=alert(1)>') && !q('#ai-context img') && chats().length === contextCalls);
  const withContext = await send('Explain explicit output');
  check('A27 Only the previewed attachment enters the sent user message with a data boundary', withContext.messages.length === 2 && withContext.messages[1].content.includes('用户主动附加的最近输出') && withContext.messages[1].content.includes('ordinary terminal output') && withContext.messages[1].content.endsWith('[附加内容结束]') && q('#ai-context').hidden);
  check('A52 Sent context remains inspectable in a collapsed text preview', !!q('[data-ai-sent-context]') && !q('[data-ai-sent-context]').open && q('[data-ai-sent-context] pre').textContent.includes('ordinary terminal output') && !q('[data-ai-sent-context] img'));
  pending.get(withContext.requestId).reject(new Error('HTTP 401 provider echoed fixture-key-do-not-persist')); pending.delete(withContext.requestId); await settle();
  check('A28 Failed request restores question and explicit attachment for retry', q('#ai-input').value === 'Explain explicit output' && !!q('[data-ai-context-preview]') && q('[data-ai-message="assistant"] .ai-message-state').textContent === '请求失败');
  check('A29 Provider errors expose status without reflecting API key or response body', q('#ai-status').textContent.includes('HTTP 401') && !q('#ai-status').textContent.includes('fixture-key-do-not-persist') && !q('#ai-status').textContent.includes('provider echoed'));
  const retry = await send('Retry question');
  check('A30 Failed turns are excluded while restored context is attached to retry', retry.messages.length === 2 && retry.messages[1].content.startsWith('Retry question') && retry.messages[1].content.includes('ordinary terminal output'));
  await answer(retry, '```sh\nprintf hello\n```\n\n```sh\nprintf first\nprintf second\n```\n\n```sh\nprintf \u001b[31munsafe\n```');
  check('A31 Only a safe single-line command receives an insert control', qa('[data-ai-copy-code]').length === 3 && qa('[data-ai-insert]').length === 1);
  await click('[data-ai-copy-code]');
  check('A32 Copy uses exact code text and never writes to a terminal', clipboard.at(-1) === 'printf hello' && writes().length === 0);
  TM.active = second.id; await click('[data-ai-insert]');
  check('A33 Insertion targets current native PTY only without Enter or sync broadcast', writes().length === 1 && writes()[0][1].id === 'native-second' && writes()[0][1].data === 'printf hello' && !/[\r\n]/.test(writes()[0][1].data));
  check('A34 Insertion returns focus to the chosen terminal', d.activeElement === second.input);
  second.exited = true; second.ptyId = null; await click('[data-ai-insert]');
  check('A35 Disconnected terminal rejects insertion without any native write', writes().length === 1 && q('#ai-status').textContent.includes('已连接'));
  second.exited = false; second.ptyId = 'native-reconnected'; await click('[data-ai-insert]');
  check('A36 Reconnected terminal insertion uses its new PTY identity', writes().length === 2 && writes().at(-1)[1].id === 'native-reconnected');
  delete TM.tabs[second.id]; await click('[data-ai-insert]');
  check('A37 Closing a tab prevents stale UI buttons writing to its old PTY', writes().length === 2 && q('#ai-status').textContent.includes('已连接'));
  TM.active = first.id;

  A.newChat(); const closing = await send('Close while generating'); A.close(); emit(closing.requestId, 'hidden late delta'); await answer(closing, 'hidden late answer');
  check('A38 Closing the panel cancels generation and ignores all late content', !A.isOpen() && !text().includes('hidden late') && calls.some(([command, args]) => command === 'ai_cancel' && args.requestId === closing.requestId));
  A.open(); A.newChat(); await click('#ai-settings');
  input('#ai-endpoint', 'https://user:password@service.example/v1'); input('#ai-model', 'fixture-chat'); const savesBeforeInvalid = saved.length; await click('#ai-save');
  check('A39 Credential-bearing endpoint is rejected before settings persistence', saved.length === savesBeforeInvalid && q('#ai-status').textContent.includes('HTTP/HTTPS'));
  input('#ai-endpoint', 'http://127.0.0.1:11434/v1/chat/completions'); input('#ai-key', ''); await click('#ai-save');
  const noKey = await send('Local unauthenticated service');
  check('A40 Local HTTP full endpoint is supported and optional key uses IPC-compatible empty string', noKey.endpoint === 'http://127.0.0.1:11434/v1/chat/completions' && noKey.apiKey === '');
  await answer(noKey, 'Local service response');
  const saveCount = saved.length; A.setWidth(999); A.setWidth(1);
  check('A41 Width persists inside supported bounds without adding secret fields', T.s.ai.width === 300 && saved.length === saveCount + 2 && Object.keys(T.s.ai).sort().join(',') === 'endpoint,model,width');
  const grip = q('#ai-resize'); grip.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  check('A42 Keyboard width adjustment updates the panel and does not reach terminal input', T.s.ai.width === 320 && panel.style.getPropertyValue('--ai-width') === '320px' && writes().length === 2);
  const savedJSON = JSON.stringify(saved);
  check('A43 Configuration saves never contain prompts, responses, attachments or key', !['fixture-key-do-not-persist', 'Explain explicit output', 'Local service response', 'ordinary terminal output'].some(value => savedJSON.includes(value)));
  A.newChat();
  const huge = await send('A question before a large response');
  await answer(huge, '中文'.repeat(50000));
  const budgeted = await send('Small follow-up after oversized history');
  const requestBytes = new w.Blob(budgeted.messages.map(message => message.content)).size;
  check('A44 UTF-8 budget removes whole oversized exchanges and keeps the new question usable', requestBytes <= 224 * 1024 && budgeted.messages.length === 2 && budgeted.messages.at(-1).content === 'Small follow-up after oversized history');
  check('A45 History trimming is disclosed while generating', q('#ai-status').textContent.includes('较早对话未附加'));
  await answer(budgeted, '```python\nprint("hello")\n```\n\n```bash\nprintf safe\n```');
  check('A46 Single-line non-shell code remains copyable without a terminal insert control', qa('[data-ai-copy-code]').length === 2 && qa('[data-ai-insert]').length === 1);
  const beforeKey = chats().length;
  input('#ai-input', 'draft\nsecond line');
  q('#ai-input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
  await settle();
  check('A47 Shift+Enter preserves the draft without sending or reaching terminal input', chats().length === beforeKey && writes().length === 2);
  first.term.focus(); holdWrite = true; await click('[data-ai-insert]');
  q('#ai-input').focus(); releaseWrite(true); holdWrite = false; await settle();
  check('A48 A delayed terminal write cannot steal focus after the user returns to the composer', d.activeElement === q('#ai-input') && writes().at(-1)[1].id === 'native-first');
  const widths = T.s.ai.width;
  A.newChat(); await click('#ai-settings'); input('#ai-endpoint', 'https://another.example/v1'); await click('#ai-save');
  check('A49 Changing provider starts a clean chat and preserves panel width', qa('[data-ai-message]').length === 0 && T.s.ai.width === widths && chats().length === beforeKey);
  const coreDom = new JSDOM('<!doctype html><html><body></body></html>', {runScripts:'outside-only', url:'http://tauri.localhost/'});
  const cw = coreDom.window, nativeSaved = [];
  const add = cw.document.addEventListener.bind(cw.document);
  cw.document.addEventListener = (type, ...args) => type === 'DOMContentLoaded' ? undefined : add(type, ...args);
  cw.__TAURI__ = {core:{invoke(command,args){if(command==='ui_state_save') nativeSaved.push(args); return Promise.resolve(null);}},event:{listen(){return Promise.resolve(()=>{});}}};
  cw.eval(readFileSync(source+'core.js','utf8'));
  cw.WT.s.ai = {endpoint:'http://localhost:11434/v1',model:'fixture-chat',width:380,apiKey:'secret-should-not-save',messages:['private question'],attachment:'private terminal output'};
  cw.WT.persistSettings();
  const persisted = nativeSaved.find(item=>item.name==='settings').value, parsed = JSON.parse(persisted);
  check('A50 Production core persistence allowlist excludes injected secret and conversation fields', Object.keys(parsed.ai).sort().join(',')==='endpoint,model,width' && !['secret-should-not-save','private question','private terminal output'].some(value=>persisted.includes(value)));
  coreDom.window.close();
  check('A51 Complete integration has no JavaScript or DOM errors', errors.length === 0);
  console.log(`\nRESULT ${checks.length} passed, ${errors.length} JavaScript errors`);
} finally {
  A.stop(); for (const value of pending.values()) value.resolve({ content: 'test cleanup' }); await settle(); dom.window.close();
}
