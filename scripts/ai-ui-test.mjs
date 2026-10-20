// Exercise the production AI panel with its real DOM, terminal write boundary,
// and a controllable native IPC/event bridge. No network requests are made.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const source = fileURLToPath(new URL('../src/', import.meta.url));
const errors = [], checks = [], calls = [], saved = [], clipboard = [], listeners = new Map(), pending = new Map();
const credentials = new Map(); let credentialFailure = false;
let holdCredentialWrite = false, releaseCredentialWrite, summaryMode = 'auto';
const heldSummaries = [];
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
  copyText: async text => { clipboard.push(text); return true; },
  listen(name, callback) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
    return Promise.resolve(() => listeners.get(name)?.delete(callback));
  },
  invoke(command, args = {}) {
    calls.push([command, args]);
    if (command.startsWith('ai_key_')) {
      if (credentialFailure) return Promise.reject(new Error('fixture-key-do-not-persist'));
      if (command === 'ai_key_write' && holdCredentialWrite) return new Promise(resolve => { releaseCredentialWrite = () => { credentials.set(args.endpoint, args.apiKey); resolve(null); }; });
      if (command === 'ai_key_write') credentials.set(args.endpoint, args.apiKey);
      if (command === 'ai_key_delete') credentials.delete(args.endpoint);
      return Promise.resolve(command === 'ai_key_read' ? credentials.get(args.endpoint) || null : null);
    }
    if (command === 'ai_chat' && args.request.messages[0]?.content.includes('摘要器')) {
      if (summaryMode === 'hold') return new Promise((resolve, reject) => heldSummaries.push({ request: args.request, resolve, reject }));
      if (summaryMode === 'fail') return Promise.reject(new Error('private credential details must stay hidden'));
      return Promise.resolve({ content: '先前记录摘要：已完成大段回复，保留用户目标和待办。' });
    }
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
w.TextEncoder = TextEncoder;
for (const file of ['../node_modules/markdown-it/dist/browser/markdown-it.umd.min.js', 'ai-markdown.js', 'ai-context.js', 'ai.js']) w.eval(readFileSync(source + file, 'utf8'));
const A = w.AiPanel;
const send = async value => { input('#ai-input', value); await click('#ai-send'); return chats().at(-1); };
const text = () => q('#ai-messages').textContent;
async function restartPanel(settings, { holdRead = false, holdWrite = false } = {}) {
  // A separate window and freshly evaluated module simulate process restart;
  // only nonsecret settings and the controlled native credential map survive.
  const fresh = new JSDOM('<!doctype html><body><aside id="ai-panel" hidden></aside></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://tauri.localhost/', virtualConsole: vc });
  const fw = fresh.window, fd = fw.document, requests = [], ipc = [], snapshots = [], reads = [], writes = [];
  fw.TextEncoder = TextEncoder;
  fw.WT = { s: { ai: JSON.parse(JSON.stringify(settings)) }, ui: { fitAll() {}, closeDock() {} }, term: { activeTab: () => null, isLive: () => false },
    persistSettings() { snapshots.push(JSON.parse(JSON.stringify(this.s))); }, copyText: async () => true,
    listen: async () => () => {}, invoke: async (command, args = {}) => {
      ipc.push([command, JSON.parse(JSON.stringify(args))]);
      if (command === 'ai_key_read') {
        const value = credentials.get(args.endpoint) || null;
        return holdRead ? new Promise(resolve => reads.push(() => resolve(value))) : value;
      }
      if (command === 'ai_key_write') {
        if (holdWrite) return new Promise(resolve => writes.push(() => { credentials.set(args.endpoint, args.apiKey); resolve(null); }));
        credentials.set(args.endpoint, args.apiKey); return null;
      }
      if (command === 'ai_key_delete') { credentials.delete(args.endpoint); return null; }
      if (command === 'ai_chat') { requests.push(args.request); return { content: 'Restart fixture completed' }; }
      return null;
    } };
  for (const file of ['../node_modules/markdown-it/dist/browser/markdown-it.umd.min.js', 'ai-markdown.js', 'icons.js', 'ai-context.js', 'ai.js']) fw.eval(readFileSync(source + file, 'utf8'));
  const api = fw.AiPanel; api.mount(fd.querySelector('#ai-panel')); api.open(); await settle();
  return { w: fw, d: fd, api, requests, ipc, snapshots,
    async send(value) { fd.querySelector('#ai-input').value = value; await api.send(); await settle(); return requests.at(-1); },
    releaseRead() { assert.ok(reads.length, 'Credential read must be pending'); reads.shift()(); },
    releaseWrite() { assert.ok(writes.length, 'Credential write must be pending'); writes.shift()(); },
    close() { api.stop(); fw.close(); } };
}
try {
  A.mount(panel); await settle();
  check('A01 Mount leaves assistant closed and starts no provider or terminal read', !A.isOpen() && chats().length === 0 && selectionReads === 0 && outputReads === 0);
  A.open();
  check('A02 First open shows configuration and focuses service address', A.isOpen() && !q('#ai-config').hidden && d.activeElement === q('#ai-endpoint'));
  check('A03 API key field is masked and marked against ordinary autocomplete', q('#ai-key').type === 'password' && q('#ai-key').autocomplete === 'new-password');
  input('#ai-endpoint', 'https://model.example/v1'); input('#ai-model', 'fixture-chat'); input('#ai-key', 'fixture-key-do-not-persist');
  await click('#ai-save');
  const settingKeys = 'autoCompact,confirmCommands,contextWindow,endpoint,model,rememberKey,width';
  check('A04 Save persists nonsecret context preferences and writes the key only to credentials', Object.keys(T.s.ai).sort().join(',') === settingKeys && T.s.ai.endpoint === 'https://model.example/v1' && T.s.ai.model === 'fixture-chat' && credentials.get(T.s.ai.endpoint) === 'fixture-key-do-not-persist');
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
  check('A53 Attachment preview and its remove button are above the textarea in the composer', q('#ai-context').parentElement.classList.contains('ai-compose') && !!q('#ai-context [data-ai-context-remove]')
    && !!(q('#ai-context').compareDocumentPosition(q('#ai-input')) & w.Node.DOCUMENT_POSITION_FOLLOWING));
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
  check('A41 Width persists inside supported bounds without adding secret fields', T.s.ai.width === 300 && saved.length === saveCount + 2 && Object.keys(T.s.ai).sort().join(',') === settingKeys);
  const grip = q('#ai-resize'); grip.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  check('A42 Keyboard width adjustment updates the panel and does not reach terminal input', T.s.ai.width === 320 && panel.style.getPropertyValue('--ai-width') === '320px' && writes().length === 2);
  const savedJSON = JSON.stringify(saved);
  check('A43 Configuration saves never contain prompts, responses, attachments or key', !['fixture-key-do-not-persist', 'Explain explicit output', 'Local service response', 'ordinary terminal output'].some(value => savedJSON.includes(value)));
  A.newChat();
  const huge = await send('A question before a large response');
  await answer(huge, '中文'.repeat(50000));
  const budgeted = await send('Small follow-up after oversized history');
  const requestBytes = new w.Blob(budgeted.messages.map(message => message.content)).size;
  check('A44 Oversized history is summarized before the next question without losing it', requestBytes <= 224 * 1024 && budgeted.messages.length === 3 && budgeted.messages[1].content.includes('先前对话与执行记录摘要') && budgeted.messages.at(-1).content === 'Small follow-up after oversized history');
  check('A45 Compaction uses a real summary request and keeps the original visible transcript', chats().some(request => request.messages[0].content.includes('摘要器')) && text().includes('中文'.repeat(20)) && q('#ai-context-size').textContent.includes('tokens'));
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
  check('A50 Production core persistence allowlist excludes injected secret and conversation fields', Object.keys(parsed.ai).sort().join(',')===settingKeys && !['secret-should-not-save','private question','private terminal output'].some(value=>persisted.includes(value)));
  coreDom.window.close();

  {
    const initialSettings = { ...T.s.ai, endpoint: 'https://model.example/v1', model: 'fixture-chat', rememberKey: true };
    const restarted = await restartPanel(initialSettings);
    const request = await restarted.send('Restart retrieves this endpoint credential');
    check('A54 A fresh panel restores its API key from the native credential store without resaving configuration', request.apiKey === 'fixture-key-do-not-persist' && restarted.ipc.some(([command, args]) => command === 'ai_key_read' && args.endpoint === initialSettings.endpoint) && restarted.snapshots.length === 0);
    const foreign = await restartPanel({ ...initialSettings, endpoint: 'https://different-provider.example/v1' });
    const foreignRequest = await foreign.send('Different provider must not reuse the previous key');
    check('A55 Different endpoints never receive another endpoint stored key', foreignRequest.apiKey === '' && foreign.ipc.filter(([command]) => command === 'ai_key_read').every(([, args]) => args.endpoint === 'https://different-provider.example/v1'));
    restarted.api.fillConfig(); restarted.d.querySelector('#ai-forget-key').click(); await settle();
    check('A56 Delete credential removes it from the native store and clears the masked field', !credentials.has(initialSettings.endpoint) && restarted.d.querySelector('#ai-key').value === '' && restarted.ipc.some(([command, args]) => command === 'ai_key_delete' && args.endpoint === initialSettings.endpoint));
    const afterDelete = await restarted.send('Deleted key must not remain in the runtime credential');
    check('A57 Deleting a key also prevents its use in the next request', afterDelete.apiKey === '');
    const deletedRestart = await restartPanel(initialSettings), deletedRequest = await deletedRestart.send('Deleted key stays deleted after restart');
    check('A58 A subsequent fresh panel cannot recover a deleted key', deletedRequest.apiKey === '');
    restarted.close(); foreign.close(); deletedRestart.close();
  }
  {
    A.newChat(); const beforeSave = await send('CONFIG_SAVE_EXISTING_HISTORY'); await answer(beforeSave, 'Existing conversation must not be cleared while saving');
    await click('#ai-settings'); input('#ai-endpoint', 'https://save-failure.example/v1'); input('#ai-key', 'PRIVATE_FAILED_KEY');
    const previous = JSON.stringify(T.s.ai), saveCount = saved.length;
    credentialFailure = true; await click('#ai-save'); credentialFailure = false;
    check('A59 Native credential write failure does not persist settings or report success', JSON.stringify(T.s.ai) === previous && saved.length === saveCount && !q('#ai-config').hidden && q('#ai-status').textContent.includes('配置尚未保存') && !q('#ai-save').disabled);
    check('A60 Credential failures do not reveal native errors or keys in visible output or settings', !q('#ai-status').textContent.includes('fixture-key-do-not-persist') && !text().includes('PRIVATE_FAILED_KEY') && !JSON.stringify(saved).includes('PRIVATE_FAILED_KEY'));
    input('#ai-endpoint', 'https://save-pending.example/v1'); input('#ai-key', 'PRIVATE_PENDING_KEY'); input('#ai-input', 'draft preserved while configuration saves');
    const visible = text(), count = chats().length;
    holdCredentialWrite = true; q('#ai-save').click(); await settle();
    check('A61 Asynchronous credential save disables send, new conversation, modes and configuration inputs', q('#ai-send').disabled && q('#ai-new').disabled && qa('button[data-ai-mode]').every(button => button.disabled) && qa('#ai-config input').every(node => node.disabled));
    const modeChanged = A.setMode('agent'); A.newChat(); await A.send(); A.onSessionChange();
    check('A62 Direct API calls cannot send, reset history or change mode while configuration is saving', modeChanged === false && chats().length === count && text() === visible && q('#ai-input').value === 'draft preserved while configuration saves' && panel.dataset.aiMode === 'chat' && q('#ai-send').disabled);
    check('A63 Saving also blocks context compaction to prevent old-provider history from returning', q('#ai-compact').disabled);
    holdCredentialWrite = false; releaseCredentialWrite(); await settle();
    check('A64 Finishing the credential save unlocks the panel and starts a clean provider conversation', !q('#ai-send').disabled && !q('#ai-new').disabled && T.s.ai.endpoint === 'https://save-pending.example/v1' && credentials.get(T.s.ai.endpoint) === 'PRIVATE_PENDING_KEY' && qa('[data-ai-message]').length === 0 && q('#ai-status').textContent.includes('配置已保存'));
    check('A65 A successful native key write still never stores the key in synchronized settings', !JSON.stringify(saved).includes('PRIVATE_PENDING_KEY'));
  }
  {
    A.newChat();
    for (let i = 0; i < 4; i++) { const request = await send('MANUAL_HISTORY_' + i); await answer(request, 'MANUAL_VERIFIED_' + i + ' ' + 'evidence '.repeat(100)); }
    const visible = text(); await click('#ai-compact');
    check('A66 Manual compression performs model summarization and retains the visible transcript', text() === visible && q('#ai-status').textContent.includes('上下文已压缩') && q('#ai-context-size').title.includes('已压缩 1 次'));
    const compacted = await send('Check manually compacted history');
    check('A67 A follow-up uses the model summary and complete recent exchanges', compacted.messages[1].content.includes('先前对话与执行记录摘要') && compacted.messages.some(message => message.content === 'MANUAL_HISTORY_3') && !compacted.messages.some(message => message.content === 'MANUAL_HISTORY_0'));
    await answer(compacted, 'Verified after manual compression');
    const expectedPrefix = [...compacted.messages, { role: 'assistant', content: 'Verified after manual compression' }], beforeCancel = text();
    summaryMode = 'hold'; await click('#ai-compact'); const summary = heldSummaries.at(-1);
    check('A68 Manual compression exposes Stop and disables concurrent sending', !!summary && q('#ai-send').disabled && !q('#ai-stop').hidden);
    await click('#ai-stop'); summaryMode = 'auto'; summary.resolve({ content: 'LATE_CANCELLED_SUMMARY_MUST_NOT_REPLACE_HISTORY' }); await settle();
    check('A69 Stop cancels the exact active summary request and ignores its late response', calls.some(([command, args]) => command === 'ai_cancel' && args.requestId === summary.request.requestId) && text() === beforeCancel && !q('#ai-send').disabled);
    const afterCancel = await send('After manual summary cancellation');
    check('A70 Cancelled compaction preserves the complete previous model context without hidden truncation', JSON.stringify(afterCancel.messages.slice(0, -1)) === JSON.stringify(expectedPrefix));
    await answer(afterCancel, 'Verified after cancelled compression');
    const expectedFailurePrefix = [...afterCancel.messages, { role: 'assistant', content: 'Verified after cancelled compression' }];
    summaryMode = 'fail'; await click('#ai-compact'); summaryMode = 'auto';
    check('A71 Manual summary errors explain that original history remains and do not echo provider data', q('#ai-status').textContent.includes('原上下文已保留') && !q('#ai-status').textContent.includes('private credential'));
    const afterFailure = await send('After failed manual compression');
    check('A72 Failed compaction leaves the next request original context intact', JSON.stringify(afterFailure.messages.slice(0, -1)) === JSON.stringify(expectedFailurePrefix));
    await answer(afterFailure, 'Final controlled fixture result');
    check('A73 Neither context summaries nor task records or API keys enter persisted settings', !['MANUAL_HISTORY_', 'MANUAL_VERIFIED_', '先前记录摘要', 'PRIVATE_FAILED_KEY', 'PRIVATE_PENDING_KEY'].some(value => JSON.stringify(saved).includes(value)));
  }
  {
    const endpoint = 'https://deleted-read-race.example/v1'; credentials.set(endpoint, 'FIXTURE_DELETED_READ_KEY');
    const fresh = await restartPanel({ ...T.s.ai, endpoint, model: 'fixture', rememberKey: true }, { holdRead: true });
    fresh.d.querySelector('#ai-settings').click(); fresh.d.querySelector('#ai-forget-key').click(); await settle();
    fresh.releaseRead(); await settle(); const request = await fresh.send('Verify deleted credential cannot be restored by an older read');
    check('A74 A delayed startup credential read cannot resurrect a successfully deleted key', !credentials.has(endpoint) && request.apiKey === '' && fresh.d.querySelector('#ai-key').value === '' && fresh.d.querySelector('#ai-status').textContent.includes('回答完成'));
    fresh.close();
  }
  {
    const endpoint = 'https://old-awaiting-read.example/v1'; credentials.set(endpoint, 'FIXTURE_OLD_READ_KEY');
    const fresh = await restartPanel({ ...T.s.ai, endpoint, model: 'fixture', rememberKey: true }, { holdRead: true, holdWrite: true });
    fresh.d.querySelector('#ai-input').value = 'Send that is still waiting for credential restore'; const waitingSend = fresh.api.send();
    fresh.d.querySelector('#ai-settings').click();
    const set = (id, value) => { const input = fresh.d.querySelector(id); input.value = value; input.dispatchEvent(new fresh.w.Event('input', { bubbles: true })); };
    set('#ai-endpoint', 'https://new-credential-provider.example/v1'); set('#ai-key', 'FIXTURE_NEW_PROVIDER_KEY'); fresh.d.querySelector('#ai-save').click(); await settle();
    fresh.releaseRead(); await waitingSend;
    check('A75 Send awaiting a prior key read cannot start after asynchronous configuration saving begins', fresh.requests.length === 0 && fresh.d.querySelector('#ai-send').disabled && fresh.snapshots.length === 0);
    fresh.releaseWrite(); await settle(); const request = await fresh.send('Send only to the newly saved provider');
    check('A76 After the save finishes only the new endpoint and its own key are used', request.endpoint === 'https://new-credential-provider.example/v1' && request.apiKey === 'FIXTURE_NEW_PROVIDER_KEY' && fresh.requests.length === 1 && !JSON.stringify(fresh.snapshots).includes('FIXTURE_NEW_PROVIDER_KEY'));
    fresh.close();
  }
  {
    const endpoint = 'https://remember-disabled.example/v1'; credentials.set(endpoint, 'FIXTURE_KEY_THAT_MUST_NOT_RESTORE');
    const fresh = await restartPanel({ ...T.s.ai, endpoint, model: 'fixture', rememberKey: false });
    const request = await fresh.send('Remember-key disabled must not restore a saved credential');
    check('A77 Disabling credential persistence also disables native key restoration in a fresh panel', request.apiKey === '' && !fresh.ipc.some(([command]) => command === 'ai_key_read'));
    fresh.close();
  }
  {
    const endpoint = 'https://closed-awaiting-read.example/v1'; credentials.set(endpoint, 'FIXTURE_CLOSE_PENDING_KEY');
    const fresh = await restartPanel({ ...T.s.ai, endpoint, model: 'fixture', rememberKey: true }, { holdRead: true });
    fresh.d.querySelector('#ai-input').value = 'Do not send after closing the assistant'; const waitingSend = fresh.api.send();
    fresh.api.close(); fresh.releaseRead(); await waitingSend; await settle();
    check('A78 Closing while a credential read is pending cancels the not-yet-started send', fresh.requests.length === 0 && fresh.d.querySelector('#ai-panel').hidden && fresh.d.querySelector('#ai-input').value === 'Do not send after closing the assistant');
    fresh.close();
  }
  {
    const endpoint = 'https://mode-awaiting-read.example/v1'; credentials.set(endpoint, 'FIXTURE_MODE_PENDING_KEY');
    const fresh = await restartPanel({ ...T.s.ai, endpoint, model: 'fixture', rememberKey: true }, { holdRead: true });
    const tasks = [], target = { id: 'fixture-target', ptyId: 'fixture-native', session: { protocol: 'local' }, term: { focus() {} } };
    fresh.w.WT.term = { activeTab: () => target, isLive: tab => tab === target, ptyId: tab => tab.ptyId };
    fresh.w.OpsAgent = { run: async options => { tasks.push(options.goal); return { status: 'complete', summary: 'Controlled task fixture', commands: 0 }; }, stop() {} };
    fresh.d.querySelector('#ai-input').value = 'This was submitted as a chat question'; const waitingSend = fresh.api.send();
    fresh.api.setMode('agent'); fresh.releaseRead(); await waitingSend; await settle();
    check('A79 Switching modes while a credential read is pending cannot turn a chat send into an operations task', tasks.length === 0);
    fresh.close();
  }
  {
    const endpoint = 'https://settings-awaiting-read.example/v1'; credentials.set(endpoint, 'FIXTURE_SETTINGS_PENDING_KEY');
    const fresh = await restartPanel({ ...T.s.ai, endpoint, model: 'fixture', rememberKey: true }, { holdRead: true });
    fresh.d.querySelector('#ai-input').value = 'Keep the draft while checking provider settings'; const waitingSend = fresh.api.send();
    fresh.d.querySelector('#ai-settings').click(); fresh.releaseRead(); await waitingSend; await settle();
    check('A80 Opening configuration invalidates an earlier send still waiting for key restoration', fresh.requests.length === 0 && !fresh.d.querySelector('#ai-config').hidden && fresh.d.querySelector('#ai-input').value === 'Keep the draft while checking provider settings');
    fresh.close();
  }
  {
    const endpoint = 'https://new-chat-awaiting-read.example/v1'; credentials.set(endpoint, 'FIXTURE_NEW_CHAT_PENDING_KEY');
    const fresh = await restartPanel({ ...T.s.ai, endpoint, model: 'fixture', rememberKey: true }, { holdRead: true });
    fresh.d.querySelector('#ai-input').value = 'The previous conversation draft must be discarded'; const waitingSend = fresh.api.send();
    fresh.api.newChat(); fresh.releaseRead(); await waitingSend; await settle();
    check('A81 A new conversation cannot receive a send delayed by the previous conversation key read', fresh.requests.length === 0 && fresh.d.querySelectorAll('[data-ai-message]').length === 0 && fresh.d.querySelector('#ai-input').value === '');
    fresh.close();
  }
  check('A51 Complete integration has no JavaScript or DOM errors', errors.length === 0);
  console.log(`\nRESULT ${checks.length} passed, ${errors.length} JavaScript errors`);
} finally {
  A.stop(); for (const value of pending.values()) value.resolve({ content: 'test cleanup' }); for (const value of heldSummaries) value.resolve({ content: 'test cleanup summary' }); await settle(); dom.window.close();
}
