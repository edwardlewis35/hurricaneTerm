// End-to-end production AI panel/controller/memory modules. Only native IPC and
// the terminal renderer are controlled. No network or real command execution.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { webcrypto, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { installHarnessFixture } from './harness-fixture.mjs';

const source = new URL('../src/', import.meta.url), checks = [], errors = [];
const read = path => readFileSync(new URL(path, source), 'utf8');
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log('PASS ' + name); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition, label) => { const end = Date.now() + 2500; while (!condition()) { if (Date.now() > end) throw Error('Timed out: ' + label); await pause(3); } await pause(20); };
const clone = value => JSON.parse(JSON.stringify(value));
const command = (id, text = 'printf inspected') => ({ id, name: 'run_command', arguments: JSON.stringify({ command: text, purpose: 'Verify fixture service' }) });
const tool = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });
const output = stdout => ({ stdout, stderr: '', exitCode: 0, signal: null, durationMs: 8, timedOut: false, cancelled: false, truncated: false, cwd: '/tmp' });
function fixture(memory = {}) {
  const vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://tauri.localhost/', virtualConsole: vc });
  const w = dom.window, d = w.document, calls = [], snapshots = [], listeners = new Map(), pending = new Map(), heldSearches = [], documents = new Map();
  let holdSearch = false, searchWarning = '', memoryKey = 'memory-only-secret', memoryBusy = false;
  Object.assign(w, { TextEncoder, TextDecoder }); Object.defineProperty(w, 'crypto', { value: webcrypto });
  const hash = content => createHash('sha256').update(content).digest('hex');
  const key = (scope, path) => scope + ':' + path;
  const put = (scope, path, content) => { const doc = { scope, path, content, hash: hash(content), bytes: Buffer.byteLength(content), updatedMs: Date.now() }; documents.set(key(scope, path), doc); return doc; };
  const metadata = doc => { const { content, ...rest } = doc; return rest; };
  const T = w.WT = {
    s: { theme: 'dige-black', fontSize: 13, sync: false, triggers: [], sessions: [], tooltips: false,
      ai: { endpoint: 'https://chat.fixture.invalid/v1', model: 'chat-fixture', width: 380, rememberKey: true, confirmCommands: false, autoCompact: true },
      aiMemory: { enabled: false, endpoint: 'https://embedding.fixture.invalid/v1', model: 'embedding-fixture', autoRecall: true, includeGlobal: true, flushBeforeCompact: false, ...memory } },
    persistSettings() { snapshots.push(clone(this.s)); }, copyText: async () => true,
    listen(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return Promise.resolve(() => listeners.get(name)?.delete(fn)); },
    invoke(name, args = {}) {
      calls.push([name, clone(args)]);
      if (['ai_chat', 'ai_agent_step', 'agent_exec'].includes(name)) return new Promise((resolve, reject) => pending.set(args.request.requestId, { name, request: clone(args.request), resolve, reject }));
      if (name === 'ai_key_read') return Promise.resolve('chat-only-secret');
      if (name === 'memory_key_read') return Promise.resolve(memoryKey);
      if (name === 'memory_key_write') { memoryKey = args.apiKey; return Promise.resolve(null); }
      if (name === 'memory_key_delete') { memoryKey = ''; return Promise.resolve(null); }
      if (name === 'memory_list') return Promise.resolve([...documents.values()].filter(doc => doc.scope === args.scope).map(metadata));
      if (name === 'memory_status') return Promise.resolve({ documents: 2, indexedChunks: 2, embeddingChunks: 2, mode: 'hybrid' });
      if (name === 'memory_search') {
        const req = args.request;
        const result = { hits: [...documents.values()].filter(doc => doc.scope === req.scope || (req.includeGlobal && doc.scope === 'global')).map(doc => ({ scope: doc.scope, path: doc.path, startLine: 1, endLine: 2, snippet: doc.content, hash: doc.hash, score: .9 })), mode: searchWarning ? 'keyword' : req.embedding ? 'hybrid' : 'keyword', warning: searchWarning, indexedChunks: 2, embeddingChunks: 2 };
        return holdSearch ? new Promise(resolve => heldSearches.push(() => resolve(result))) : Promise.resolve(result);
      }
      if (name === 'memory_get') {
        const doc = documents.get(key(args.scope, args.path));
        return doc ? Promise.resolve({ ...doc, startLine: 1, endLine: doc.content.split('\n').length, totalLines: doc.content.split('\n').length }) : Promise.reject(Error('not found'));
      }
      if (name === 'memory_write') {
        const req = args.request, old = documents.get(key(req.scope, req.path));
        if (req.ifIdle && memoryBusy) return Promise.reject(Error('记忆库正在处理其他任务，请稍后重试'));
        if (req.expectedHash != null && req.expectedHash !== (old?.hash || '')) return Promise.reject(Error('conflict'));
        return Promise.resolve(metadata(put(req.scope, req.path, req.append ? (old?.content || '') + req.content : req.content)));
      }
      if (name === 'memory_embedding_test') return Promise.resolve({ dimensions: 768 });
      if (name === 'memory_reindex') return Promise.resolve({ indexedChunks: 2, embeddingChunks: 2, mode: 'hybrid' });
      if (name === 'ui_state_load') return Promise.resolve(null);
      return Promise.resolve(true);
    },
  };
  installHarnessFixture(w, T);
w.UI = T.ui = { toast() {}, status() {}, log() {}, renderDock() {}, closeDock() {}, fitAll() {} };
  for (const file of ['icons.js', 'term.js', 'ai-context.js', 'ai-memory.js', 'ai-memory-flush.js', 'ai-agent.js']) w.eval(read(file));
  const TM = T.term;
  function terminal(id) {
    const input = d.createElement('textarea'); d.querySelector('.term-host').append(input);
    const value = { id, ptyId: 'native-' + id, title: id + ' target', _connectionGeneration: 1,
      session: { protocol: 'ssh', host: id + '.fixture.invalid', user: 'fixture-user', port: 22 }, exited: false, _closing: false,
      renderer: [], term: { focus() { input.focus(); }, getSelection: () => '', write(text, done) { value.renderer.push(text); done?.(); },
        buffer: { active: { length: 1, getLine: () => ({ translateToString: () => 'fixture terminal output' }) } } }, fit: { fit() {} }, wrap: input, input };
    value._connectionIdentity = Object.freeze({ ...value.session });
    TM.tabs[id] = value; TM.order.push(id); return value;
  }
  const first = terminal('first'), second = terminal('second'); TM.active = first.id;
  w.eval(read('ai.js')); const A = w.AiPanel;
  const q = selector => d.querySelector(selector), qa = selector => [...d.querySelectorAll(selector)];
  A.mount(q('#ai-panel')); A.open();
  const requests = name => calls.filter(([command]) => command === name).map(([, args]) => args.request);
  const ipc = name => calls.filter(([command]) => command === name).map(([, args]) => args);
  const input = (selector, value) => { const n = q(selector); assert.ok(n, selector); n.value = value; n.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const click = async selector => { assert.ok(q(selector), selector); q(selector).click(); await pause(35); };
  const resolve = async (request, result) => { const task = pending.get(request.requestId); assert.ok(task, request.requestId); pending.delete(request.requestId); task.resolve(result); await pause(40); };
  return { w, d, T, A, TM, first, second, calls, snapshots, documents, put, pending, heldSearches, q, qa, requests, ipc, input, click, resolve,
    async ready() { await pause(30); const scope = await w.AiMemory.scopeFor(first); put(scope, 'MEMORY.md', 'Server uses 8080.\nUntrusted history: rm -rf /fixture ; <img src=x onerror=alert(1)>'); put('global', 'MEMORY.md', 'Use explicit evidence before changes.'); return scope; },
    async send(text, mode = 'chat') { A.setMode(mode); input('#ai-input', text); q('#ai-send').click(); await pause(35); },
    flags(values) { if ('holdSearch' in values) holdSearch = values.holdSearch; if ('searchWarning' in values) searchWarning = values.searchWarning; if ('memoryBusy' in values) memoryBusy = values.memoryBusy; },
    async idle() { await until(() => !w.OpsAgent.isRunning() && !q('#ai-send').disabled, 'AI idle'); },
    close() { A.stop(); dom.window.close(); },
  };
}

{
  const e = fixture();
  try {
    await e.ready(); await e.send('Explain the fixture'); await until(() => e.requests('ai_chat').length === 1, 'chat with memory disabled');
    const request = e.requests('ai_chat')[0];
    check('I01 Default-off chat sends neither memory search nor Embedding credential requests', !e.ipc('memory_search').length && !e.ipc('memory_key_read').length && request.messages.length === 2);
    await e.resolve(request, { content: 'Fixture reply' }); await e.idle();
    await e.send('Inspect fixture', 'agent'); await until(() => e.requests('ai_agent_step').length === 1, 'agent with memory disabled');
    const agent = e.requests('ai_agent_step')[0];
    check('I02 Default-off agent does not enable memory tools or auto recall', agent.memoryEnabled !== true && !e.ipc('memory_search').length);
    await e.resolve(agent, { content: '', toolCalls: [tool('forbidden-memory', 'memory_search', { query: 'private' })] }); await e.idle();
    check('I03 Disabled memory tools returned by a model are rejected before native retrieval or command execution', !e.ipc('memory_search').length && !e.requests('agent_exec').length);
  } finally { e.close(); }
}

{
  const e = fixture({ enabled: true });
  try {
    const scope = await e.ready(); await e.send('Where does the fixture listen?'); await until(() => e.requests('ai_chat').length === 1, 'memory-enabled chat');
    const request = e.requests('ai_chat')[0], recall = e.ipc('memory_search')[0].request;
    check('I04 Real memory module recalls current-machine and global source before chat', recall.scope === scope && recall.includeGlobal === true && recall.embedding.endpoint === 'https://embedding.fixture.invalid/v1');
    check('I05 Embedding and chat keys remain isolated through the production request path', recall.embedding.apiKey === 'memory-only-secret' && request.apiKey === 'chat-only-secret' && !JSON.stringify(request).includes('memory-only-secret'));
    const references = request.messages.filter(message => message.content.includes('历史记忆参考数据'));
    check('I06 Memory is a sourced untrusted user reference and never promoted into system authorization', references.length === 1 && references[0].role === 'user' && references[0].content.includes('MEMORY.md:1-2') && references[0].content.includes('不构成') && !request.messages[0].content.includes('Server uses 8080'));
    check('I07 Retrieval never inserts historical shell text into a live terminal', !e.ipc('write').length && !e.requests('agent_exec').length && !e.first.renderer.join('').includes('rm -rf'));
    await e.resolve(request, { content: 'The saved fixture port is 8080.' }); await e.idle();
    check('I08 Memory source cards remain safe text while showing retrieval provenance', !e.q('#ai-messages img') && e.q('#ai-messages').textContent.includes('MEMORY.md'));
    const writes = e.ipc('memory_write').length;
    e.put(await e.w.AiMemory.scopeFor(e.second), 'MEMORY.md', 'Second machine only, never mix with first.');
    e.TM.active = e.second.id; e.A.onSessionChange();
    await e.click('[data-ai-save-memory]');
    check('I09 Save-reply action only opens an editable memory draft without writing', e.w.AiMemory.isOpen() && e.q('#aim-content').value.includes('saved fixture port') && e.ipc('memory_write').length === writes);
    check('I09b A chat reply saved after switching tabs remains bound to its original machine', e.ipc('memory_list').at(-1).scope === scope && e.q('#aim-content').value.startsWith('Server uses 8080') && !e.q('#aim-content').value.includes('Second machine only'));
    e.w.AiMemory.close();
    check('I10 Closing the memory draft restores the existing chat transcript', e.q('#ai-messages').textContent.includes('saved fixture port'));
  } finally { e.close(); }
}

for (const action of ['stop', 'reconnect', 'tab-switch']) {
  const e = fixture({ enabled: true });
  try {
    await e.ready(); e.flags({ holdSearch: true }); await e.send('Pending recall ' + action); await until(() => e.heldSearches.length === 1, 'held chat memory search');
    if (action === 'stop') e.A.stop(); else if (action === 'tab-switch') { e.TM.active = e.second.id; e.A.onSessionChange(); } else { e.first._connectionGeneration++; e.A.onSessionChange(); }
    e.heldSearches.shift()(); await pause(65);
    check('I11 Chat ' + action + ' ignores late recall before sending any model request', !e.requests('ai_chat').length && !e.requests('agent_exec').length);
  } finally { e.close(); }
}

{
  const e = fixture({ enabled: true });
  try {
    const scope = await e.ready(); e.flags({ holdSearch: true }); await e.send('Recall on captured target', 'agent');
    await until(() => e.heldSearches.length === 1, 'target-bound recall'); e.TM.active = e.second.id; e.A.onSessionChange();
    e.heldSearches.shift()(); await until(() => e.requests('ai_agent_step').length === 1, 'captured-target agent');
    check('I12b Selecting another terminal keeps active agent recall bound to the original machine', e.ipc('memory_search')[0].request.scope === scope && e.w.OpsAgent.getTarget().sessionId === 'native-first');
    await e.resolve(e.requests('ai_agent_step')[0], { content: 'Read original machine history', toolCalls: [] }); await e.idle();
  } finally { e.close(); }
}

for (const action of ['stop', 'reconnect']) {
  const e = fixture({ enabled: true });
  try {
    await e.ready(); e.flags({ holdSearch: true }); await e.send('Pending agent recall ' + action, 'agent'); await until(() => e.heldSearches.length === 1, 'held agent memory search');
    if (action === 'stop') e.A.stop(); else { e.first._connectionGeneration++; e.A.onSessionChange(); }
    await e.idle(); e.heldSearches.shift()(); await pause(50);
    check('I12 Agent ' + action + ' ignores late recall before model or shell execution', !e.requests('ai_agent_step').length && !e.requests('agent_exec').length && !e.ipc('write').length);
  } finally { e.close(); }
}

{
  const e = fixture({ enabled: true });
  try {
    const scope = await e.ready(); await e.send('Use memory to inspect fixture', 'agent'); await until(() => e.requests('ai_agent_step').length === 1, 'first memory agent request');
    let request = e.requests('ai_agent_step').at(-1);
    check('I13 Enabled agent opts into memory tools and receives source recall as untrusted reference', request.memoryEnabled === true && request.messages.some(m => m.role === 'user' && m.content.includes('历史记忆参考数据')));
    await e.resolve(request, { content: '', toolCalls: [tool('search-history', 'memory_search', { query: 'port', maxResults: 3, minScore: .35 })] });
    await until(() => e.requests('ai_agent_step').length === 2, 'search result model request'); request = e.requests('ai_agent_step').at(-1);
    const searchResult = JSON.parse(request.messages.at(-1).content);
    check('I14 Agent memory_search calls the real module and returns paired scoped source results', e.ipc('memory_search').length === 2 && e.ipc('memory_search').at(-1).request.scope === scope && request.messages.at(-1).toolCallId === 'search-history' && searchResult.hits.every(hit => ['current', 'global'].includes(hit.scope)));
    await e.resolve(request, { content: '', toolCalls: [tool('read-original', 'memory_get', { scope: 'current', path: 'MEMORY.md', fromLine: 1, lines: 20 })] });
    await until(() => e.requests('ai_agent_step').length === 3, 'memory get result'); request = e.requests('ai_agent_step').at(-1);
    check('I15 Agent memory_get reads the selected machine original with requested line range', e.ipc('memory_get').at(-1).scope === scope && e.ipc('memory_get').at(-1).lines === 20 && JSON.parse(request.messages.at(-1).content).content.includes('Server uses 8080'));
    await e.resolve(request, { content: '', toolCalls: [tool('save-fact', 'memory_write', { scope: 'current', path: 'memory/fixture.md', content: 'Confirmed fixture fact', append: true })] });
    await until(() => !!e.q('[data-ai-approval]'), 'memory write approval');
    check('I16 Memory writes require approval even when ordinary-command confirmation is disabled', e.T.s.ai.confirmCommands === false && !e.ipc('memory_write').length && e.q('[data-ai-approval]').textContent.includes('Confirmed fixture fact'));
    await e.click('[data-ai-approve]'); await until(() => e.requests('ai_agent_step').length === 4, 'approved memory result'); request = e.requests('ai_agent_step').at(-1);
    check('I17 Approved memory write uses native hash protection on the captured machine', e.ipc('memory_write').length === 1 && e.ipc('memory_write')[0].request.scope === scope && e.ipc('memory_write')[0].request.expectedHash === '' && e.documents.get(scope + ':memory/fixture.md').content === 'Confirmed fixture fact');
    await e.resolve(request, { content: '', toolCalls: [command('verify-port', 'printf port-8080-verified')] }); await until(() => e.requests('agent_exec').length === 1, 'command following retrieval');
    const execution = e.requests('agent_exec')[0];
    check('I18 After reading memory the agent executes only its explicit command on the locked terminal', execution.command === 'printf port-8080-verified' && execution.sessionId === 'native-first' && !e.ipc('write').length);
    await e.resolve(execution, output('port 8080 verified')); await until(() => e.requests('ai_agent_step').length === 5, 'final planning request'); request = e.requests('ai_agent_step').at(-1);
    await e.resolve(request, { content: 'Final result: fixture port 8080 verified.', toolCalls: [] }); await e.idle();
    const display = e.q('#ai-messages').textContent;
    check('I19 Final answer follows visible command output and retains memory provenance', display.indexOf('port 8080 verified') < display.indexOf('Final result:') && display.includes('MEMORY.md') && e.qa('[data-ai-step]').length === 1);
    check('I20 Historical executable-looking memory is never treated as a run_command request', e.requests('agent_exec').every(req => !req.command.includes('rm -rf')) && !e.q('#ai-messages img'));
    e.TM.active = e.second.id; e.A.onSessionChange(); await e.click('[data-ai-save-memory]');
    check('I20b Saving a completed agent reply after tab switch still targets the executed machine', e.ipc('memory_list').at(-1).scope === scope && e.q('#aim-content').value.includes('Final result: fixture port 8080 verified.'));
  } finally { e.close(); }
}

{
  const e = fixture({ enabled: true, autoRecall: false });
  try {
    await e.ready();
    for (let i = 0; i < 3; i++) {
      await e.send('Confirmed fact ' + i); await until(() => e.requests('ai_chat').length === i + 1, 'seed compactable chat');
      await e.resolve(e.requests('ai_chat').at(-1), { content: ('Confirmed fixture environment fact ' + i + '. ').repeat(30) }); await e.idle();
    }
    await e.click('#ai-compact'); await until(() => e.requests('ai_chat').length === 4, 'manual compression with memory-flush off');
    check('I23b Real compression button bypasses memory extraction while flush option is off', e.requests('ai_chat').at(-1).messages[0].content.includes('摘要器') && !e.ipc('memory_write').length);
    await e.resolve(e.requests('ai_chat').at(-1), { content: 'Confirmed fixture facts from the earliest exchange.' }); await e.idle();
    e.T.s.aiMemory.flushBeforeCompact = true;
    await e.click('#ai-compact'); await until(() => e.requests('ai_chat').length === 5, 'manual compression extraction');
    check('I23c Real compression button extracts durable facts before running the normal context summarizer', e.requests('ai_chat').at(-1).messages[0].content.includes('跨会话保留'));
    const extraction = e.requests('ai_chat').at(-1); await e.click('#ai-stop');
    await e.resolve(extraction, { content: '- Confirmed fixture is configured correctly.' }); await pause(35);
    check('I23d Stopping UI compression prevents late extraction writes and subsequent context requests', !e.ipc('memory_write').length && e.requests('ai_chat').length === 5 && !e.q('#ai-send').disabled);
    await e.click('#ai-compact'); await until(() => e.requests('ai_chat').length === 6, 'compression before reconnect');
    const beforeReconnect = e.requests('ai_chat').at(-1); e.first._connectionGeneration++; e.A.onSessionChange();
    await e.resolve(beforeReconnect, { content: '- A fact observed before the original connection changed.' }); await e.idle();
    check('I23e Reconnecting during compression prevents late memory append or later compaction requests', !e.ipc('memory_write').length && e.requests('ai_chat').length === 6);
    e.TM.active = e.second.id; e.A.onSessionChange(); await e.click('#ai-compact');
    await until(() => e.requests('ai_chat').length === 7, 'cross-machine context-only compression');
    check('I23f Compressing machine A conversation while viewing B skips durable-fact extraction', e.requests('ai_chat').at(-1).messages[0].content.includes('摘要器') && !e.ipc('memory_write').length);
    await e.resolve(e.requests('ai_chat').at(-1), { content: 'Earlier facts.' }); await e.idle();
    await e.w.AiMemory.open({ tab: e.second });
    check('I23g Machine A history is never saved into B and skipped auto-flush is visible', !e.ipc('memory_write').length && e.q('#aim-status').textContent.includes('不同机器'));
  } finally { e.close(); }
}

{
  const e = fixture({ enabled: true, autoRecall: false });
  try {
    await e.ready(); await e.send('Prepare a memory fact', 'agent'); await until(() => e.requests('ai_agent_step').length === 1, 'manual-memory agent');
    await e.resolve(e.requests('ai_agent_step')[0], { content: '', toolCalls: [tool('declined-fact', 'memory_write', { path: 'memory/declined.md', content: 'Do not save without approval' })] });
    await until(() => !!e.q('[data-ai-approval]'), 'declined memory approval'); await e.click('[data-ai-reject]'); await e.idle();
    check('I21 Rejecting a memory write prevents both native write and subsequent shell actions', !e.ipc('memory_write').length && !e.requests('agent_exec').length && e.requests('ai_agent_step').length === 1);
    check('I22 Auto-recall opt-out does not silently disable explicitly enabled agent memory tools', e.requests('ai_agent_step')[0].memoryEnabled === true && !e.ipc('memory_search').length);
  } finally { e.close(); }
}

{
  const e = fixture({ enabled: true, autoRecall: false });
  try {
    await e.ready(); await e.send('Validate full batch before any action', 'agent'); await until(() => e.requests('ai_agent_step').length === 1, 'bad batch agent');
    await e.resolve(e.requests('ai_agent_step')[0], { content: '', toolCalls: [command('should-not-run'), tool('bad-memory', 'memory_get', { path: '../secret', scope: 'other-machine' })] }); await e.idle();
    check('I23 An invalid memory tool in a mixed batch prevents the earlier shell command too', !e.requests('agent_exec').length && !e.ipc('memory_get').length && !e.ipc('memory_write').length);
  } finally { e.close(); }
}

{
  const e = fixture({ enabled: true });
  try {
    await e.ready(); const options = { tab: e.first, endpoint: 'https://chat.fixture.invalid/v1', model: 'chat-fixture', apiKey: 'chat-only-secret', messages: [{ role: 'user', content: 'Confirmed preference: use port 8080' }], shouldContinue: () => true };
    const off = await e.w.AiMemoryFlush.flush(options);
    check('I24 Compression memory flush defaults off and calls neither model nor file writer', off.skipped === true && !e.requests('ai_chat').length && !e.ipc('memory_write').length);
    e.T.s.aiMemory.flushBeforeCompact = true;
    let alive = true;
    const flushing = e.w.AiMemoryFlush.flush({ ...options, shouldContinue: () => alive }); await until(() => e.requests('ai_chat').length === 1, 'flush extraction request');
    alive = false; await e.resolve(e.requests('ai_chat')[0], { content: '- Confirmed fixture uses port 8080.' }); await flushing;
    check('I25 A cancelled compression extraction cannot append late memory', !e.ipc('memory_write').length);
    const saved = e.w.AiMemoryFlush.flush({ ...options, requestId: 'flush-confirmed' }); await until(() => e.requests('ai_chat').length === 2, 'second flush');
    await e.resolve(e.requests('ai_chat').at(-1), { content: '- Confirmed fixture uses port 8080.' }); const result = await saved;
    check('I26 Opt-in flush appends only to current-machine daily memory with fixed local filename and no queued save', result.saved && /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(result.path) && e.ipc('memory_write').at(-1).request.append === true && e.ipc('memory_write').at(-1).request.ifIdle === true && e.ipc('memory_write').at(-1).request.scope === await e.w.AiMemory.scopeFor(e.first));
    check('I27 Flush uses chat credentials for extraction and stores no secret in Markdown or settings', e.requests('ai_chat').at(-1).apiKey === 'chat-only-secret' && !e.ipc('memory_write').at(-1).request.content.includes('secret') && !JSON.stringify(e.snapshots).includes('secret'));
    const chatCount = e.requests('ai_chat').length; await e.w.AiMemoryFlush.flush(options);
    check('I28 Repeated unchanged compression input does not duplicate memory facts', e.requests('ai_chat').length === chatCount && e.ipc('memory_write').length === 1);
  } finally { e.close(); }
}

{
  const e = fixture({ enabled: true });
  try {
    const actualScope = await e.ready(); await e.send('Observe before saved profile is edited');
    await until(() => e.requests('ai_chat').length === 1, 'reply before profile edit');
    await e.resolve(e.requests('ai_chat')[0], { content: 'Fact verified on original connected server.' }); await e.idle();
    Object.assign(e.first.session, { host: 'edited-profile.fixture.invalid', user: 'other-user', port: 2222, protocol: 'telnet' });
    const editedScope = await e.w.AiMemory.scopeFor({ session: e.first.session });
    check('I28b Editing a saved profile in place does not mutate frozen connected identity or its memory scope', Object.isFrozen(e.first._connectionIdentity) && e.first._connectionIdentity.host === 'first.fixture.invalid' && editedScope !== actualScope && await e.w.AiMemory.scopeFor(e.first) === actualScope);
    await e.click('[data-ai-save-memory]');
    check('I28c Saving an older reply after in-place profile changes uses original connected machine', e.ipc('memory_list').at(-1).scope === actualScope && e.q('#aim-content').value.includes('Fact verified on original connected server.'));
    await e.click('#aim-discard'); e.w.AiMemory.close(); e.A.newChat();
    await e.send('Recall after saved profile host and protocol changed'); await until(() => e.requests('ai_chat').length === 2, 'chat after profile edit');
    check('I28d Chat retrieval continues using actual connection identity while edited profile awaits reconnect', e.ipc('memory_search').at(-1).request.scope === actualScope && e.first.ptyId === 'native-first');
    await e.resolve(e.requests('ai_chat').at(-1), { content: 'Original connected machine remains selected.' }); await e.idle(); e.A.newChat();
    await e.send('Check actual connected server history', 'agent'); await until(() => e.requests('ai_agent_step').length === 1, 'agent with edited saved profile');
    const target = e.w.OpsAgent.getTarget();
    check('I28e Agent target displays actual SSH host/user/port and remains operable despite edited profile protocol', target.protocol === 'ssh' && target.host === 'first.fixture.invalid' && target.user === 'fixture-user' && target.port === 22 && target.sessionId === 'native-first');
    await e.resolve(e.requests('ai_agent_step')[0], { content: '', toolCalls: [tool('profile-stable-search', 'memory_search', { query: 'server' }), tool('profile-stable-get', 'memory_get', { path: 'MEMORY.md', scope: 'current' })] });
    await until(() => e.requests('ai_agent_step').length === 2, 'memory tools on actual connection');
    check('I28f Agent memory search and original reads stay in captured connection scope after profile edit', e.ipc('memory_search').at(-1).request.scope === actualScope && e.ipc('memory_get').at(-1).scope === actualScope && !e.requests('agent_exec').length);
    await e.resolve(e.requests('ai_agent_step').at(-1), { content: 'Original connected machine history verified.', toolCalls: [] }); await e.idle();
    e.T.s.aiMemory.flushBeforeCompact = true;
    const flush = e.w.AiMemoryFlush.flush({ tab: e.first, endpoint: 'https://chat.fixture.invalid/v1', model: 'chat-fixture', apiKey: 'chat-only-secret', requestId: 'profile-frozen-flush', messages: [{ role: 'user', content: 'Verified fact on actual connected server.' }], shouldContinue: () => true });
    await until(() => e.requests('ai_chat').length === 3, 'flush after saved profile edit');
    await e.resolve(e.requests('ai_chat').at(-1), { content: '- Verified fact belongs to the original connected server.' }); const result = await flush;
    check('I28g Daily flush uses frozen actual connection scope and never the newly edited profile scope', result.saved && e.ipc('memory_write').at(-1).request.scope === actualScope && e.ipc('memory_write').at(-1).request.scope !== editedScope && e.ipc('memory_write').at(-1).request.ifIdle === true);
  } finally { e.close(); }
}

{
  const e = fixture({ enabled: true, flushBeforeCompact: true });
  try {
    await e.ready(); e.flags({ memoryBusy: true });
    const options = { tab: e.first, endpoint: 'https://chat.fixture.invalid/v1', model: 'chat-fixture', apiKey: 'chat-only-secret',
      messages: [{ role: 'user', content: 'Confirmed preference for retryable memory save.' }], shouldContinue: () => true };
    const first = e.w.AiMemoryFlush.flush({ ...options, requestId: 'busy-memory-attempt' }); await until(() => e.requests('ai_chat').length === 1, 'busy memory extraction');
    await e.resolve(e.requests('ai_chat')[0], { content: '- Confirmed retryable memory fact.' }); const failure = await first;
    check('I28h Busy memory rejects ifIdle flush without claiming success or changing a daily file', !failure.saved && !!failure.warning && e.ipc('memory_write').at(-1).request.ifIdle === true && ![...e.documents.values()].some(doc => doc.path.startsWith('memory/')) && e.q('#aim-status').textContent.includes('未完成') && !e.q('#aim-status').textContent.includes('已追加'));
    e.flags({ memoryBusy: false }); await pause(30);
    check('I28i Releasing a busy library cannot later execute the rejected queued write', e.ipc('memory_write').length === 1 && ![...e.documents.values()].some(doc => doc.path.startsWith('memory/')));
    const retry = e.w.AiMemoryFlush.flush({ ...options, requestId: 'busy-memory-retry' }); await until(() => e.requests('ai_chat').length === 2, 'retry memory extraction');
    await e.resolve(e.requests('ai_chat').at(-1), { content: '- Confirmed retryable memory fact.' }); const saved = await retry;
    check('I28j A failed busy flush remains retryable and appends exactly once after the library is idle', saved.saved && e.ipc('memory_write').length === 2 && e.ipc('memory_write').at(-1).request.ifIdle === true && [...e.documents.values()].filter(doc => doc.path.startsWith('memory/')).length === 1 && e.q('#aim-status').textContent.includes('已追加'));
  } finally { e.close(); }
}

const index = read('index.html');
check('I29 Production HTML includes memory UI, flush module, and shared-theme stylesheet', ['ai-memory.js', 'ai-memory-flush.js', 'ai-memory.css'].every(asset => index.includes(asset)));
check('I30 Production loads memory modules before the agent and panel integrations', index.indexOf('src="ai-memory.js"') < index.indexOf('src="ai-agent.js"') && index.indexOf('src="ai-memory-flush.js"') < index.indexOf('src="ai.js"'));
{
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://tauri.localhost/' });
  const w = dom.window, calls = [];
  // Inspect the real persistence boundary without starting the full application.
  const addListener = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (name, ...args) => { if (name !== 'DOMContentLoaded') addListener(name, ...args); };
  w.__TAURI__ = { core: { invoke: async (name, args) => { calls.push([name, clone(args)]); return null; } }, event: { listen: async () => () => {} } };
  try {
    w.eval(read('core.js'));
    w.WT.s.aiMemory = { enabled: true, endpoint: 'https://embedding.fixture.invalid/v1', model: 'embed-fixture',
      apiKey: 'memory-api-secret-fixture', key: 'memory-key-secret-fixture', cookieKey: 'memory-cookie-secret-fixture',
      documents: [{ content: 'private-memory-content-fixture' }], messages: ['private-conversation-fixture'], autoRecall: true, minScore: .35 };
    w.WT.s.sessions = [{ name: 'Fixture machine', protocol: 'ssh', host: 'machine.fixture.invalid', user: 'tester',
      password: 'ssh-password-secret-fixture', memory: 'private-machine-memory-fixture' }];
    w.WT.persistSettings(); await pause(5);
    const settingsWire = calls.find(([name]) => name === 'ui_state_save')[1].value;
    check('I31 Real settings serializer excludes all memory key aliases, documents and conversation content', !/secret-fixture|private-memory-content-fixture|private-conversation-fixture/.test(settingsWire) && JSON.parse(settingsWire).aiMemory.model === 'embed-fixture');
    w.eval(read('gist-sync.js'));
    const gist = JSON.stringify(w.GistSync.exportDocument(w.WT.s.sessions));
    check('I32 Real Gist export includes machine metadata without memory service keys or Markdown', !/secret-fixture|private-machine-memory-fixture|aiMemory|embedding\.fixture/.test(gist) && gist.includes('machine.fixture.invalid'));
  } finally { dom.window.close(); }
}
check('I33 Entire integration uses safe DOM rendering with no browser runtime errors', errors.length === 0);
console.log(JSON.stringify({ passed: checks.length, total: checks.length, networkRequests: 0, realCredentials: false, realMachineCommands: false }));
