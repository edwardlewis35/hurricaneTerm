// Production panel with a controlled local journal and operations agent. No model
// request, native execution, credential persistence or network access occurs.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const source = new URL('../src/', import.meta.url);
const checks = [], errors = [];
const check = (label, condition) => { assert.ok(condition, label); checks.push(label); console.log('PASS ' + label); };
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const clone = value => JSON.parse(JSON.stringify(value));
const target = { identity: 'ssh|fixture@one:22', protocol: 'ssh', host: 'one', user: 'fixture', port: 22, title: 'One <img src=x onerror=alert(1)>' };
const call = (id, command) => ({ id, name: 'run_command', arguments: JSON.stringify({ command, purpose: 'Inspect <svg onload=alert(1)>' }) });
const events = [
  { seq: 1, kind: 'assistant/message', data: { message: { role: 'assistant', content: 'Inspect', toolCalls: [call('known', 'printf "<img src=x onerror=alert(1)>"'), call('unknown', 'touch state-file'), call('not-started', 'cat state-file')] } } },
  { seq: 2, kind: 'tool/dispatch', data: { callId: 'known', name: 'run_command', requestId: 'req-1', command: 'printf "<img src=x onerror=alert(1)>"' } },
  { seq: 3, kind: 'tool/result', data: { message: { role: 'tool', toolCallId: 'known', content: JSON.stringify({ stdout: 'Safe output <script>alert(1)</script>', stderr: '', exitCode: 0 }) } } },
  { seq: 4, kind: 'tool/dispatch', data: { callId: 'unknown', name: 'run_command', requestId: 'req-2', command: 'touch state-file' } },
];
const interrupted = { id: 'record-one', metadata: { goal: 'Check service <img src=x onerror=alert(1)>', target }, events, interruptedTail: true };
const complete = { ...interrupted, id: 'record-done', metadata: { ...interrupted.metadata, goal: 'Finished task' }, events: [...events, { seq: 5, kind: 'turn/end', data: { status: 'complete', summary: 'Verified complete' } }], interruptedTail: false };
const different = { ...interrupted, id: 'record-other', metadata: { goal: 'Other machine', target: { ...target, identity: 'ssh|fixture@other:22', host: 'other' } } };
function replay(record) {
  const ended = record.id === 'record-done';
  return { status: ended ? 'complete' : 'interrupted', summary: ended ? 'Verified complete' : 'Interrupted <b>summary</b>', history: [], commands: 2, rounds: 1, compactions: 0,
    pending: ended ? [] : [{ id: 'unknown', name: 'run_command', dispatched: true }, { id: 'not-started', name: 'run_command', dispatched: false }] };
}
function fixture({ holdKey = false, noHarness = false } = {}) {
  const vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><body><aside id="ai-panel" hidden></aside></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://tauri.localhost/', virtualConsole: vc });
  const w = dom.window, d = w.document, journalCalls = [], resumes = [], runs = [], nativeCalls = [], keyGate = deferred();
  const state = { failList: false, failRead: false, failTarget: false, holdTarget: null, holdRead: null, holdList: null, holdResume: null };
  const tab = { id: 'one', title: 'One', ptyId: 'native-one', _connectionGeneration: 1, identity: target.identity, session: { protocol: 'ssh', host: 'one', user: 'fixture' }, live: true, focused: 0, term: { focus() { tab.focused++; } } };
  const other = { ...tab, id: 'other', title: 'Other', ptyId: 'native-other', identity: different.metadata.target.identity, term: { focus() {} } };
  let active = tab;
  const WT = w.WT = { s: { ai: { endpoint: 'https://fixture.invalid/v1', model: 'fixture', rememberKey: true, confirmCommands: false } },
    ui: { fitAll() {}, closeDock() {} }, term: { activeTab: () => active, ptyId: value => value?.ptyId, isLive: value => !!value?.live, receiveOutput() {} },
    persistSettings() {}, copyText: async () => true, listen: async () => () => {},
    invoke: async (command, args) => { nativeCalls.push([command, args]); if (command === 'ai_key_read') return holdKey ? keyGate.promise : 'LOCAL_API_KEY_NOT_IN_LOG'; return null; } };
  const records = new Map([interrupted, complete, different].map(record => [record.id, clone(record)]));
  const store = { target: async value => { if (state.failTarget) throw Error('LOCAL_API_KEY_NOT_IN_LOG'); if (state.holdTarget) { const held = state.holdTarget; state.holdTarget = null; return held.promise; } return { ...target, identity: value.identity }; },
    async list() { journalCalls.push('list'); if (state.failList) throw Error('LOCAL_API_KEY_NOT_IN_LOG'); if (state.holdList) return state.holdList.promise;
      return [...records.values()].map(record => ({ id: record.id, metadata: record.metadata, eventCount: record.events.length, updatedAt: 1792000000000, interruptedTail: record.interruptedTail })); },
    async read(id) { journalCalls.push(['read', id]); if (state.failRead) throw Error('LOCAL_API_KEY_NOT_IN_LOG'); if (state.holdRead) return state.holdRead.promise; return clone(records.get(id)); },
    replay };
  if (!noHarness) w.AiHarness = { createJournal: () => store };
  w.OpsAgent = { run: async options => { runs.push(options); return { status: 'complete', summary: 'Normal fixture run', commands: 0 }; },
    resume: async options => { resumes.push(options); options.onEvent({ type: 'session', sessionId: options.sessionId, resumed: true });
      if (state.holdResume) return state.holdResume.promise;
      options.onEvent({ type: 'command', requestId: 'new-1', command: 'pwd', index: 1 });
      options.onEvent({ type: 'result', requestId: 'new-1', result: { stdout: '/fixture', stderr: '', exitCode: 0, durationMs: 3 } });
      return { status: 'complete', summary: 'Resumed verified result', commands: 1, compactions: 0 }; }, stop() {}, checkTarget() {} };
  for (const file of ['icons.js', 'ai.js']) w.eval(readFileSync(new URL(file, source), 'utf8'));
  const A = w.AiPanel, q = selector => d.querySelector(selector);
  A.mount(q('#ai-panel')); A.open();
  const click = async selector => { assert.ok(q(selector), 'Missing ' + selector); q(selector).click(); await tick(); };
  return { w, d, q, A, WT, tab, other, state, store, records, resumes, runs, nativeCalls, journalCalls, keyGate, click,
    switch(value) { active = value; A.onSessionChange(); }, close() { A.stop(); w.close(); } };
}
const fixtures = [];
const create = options => { const f = fixture(options); fixtures.push(f); return f; };
const openDetail = async f => { await f.click('#ai-records-toggle'); await f.click('[data-ai-record-id="record-one"]'); };
try {
  const f = create(); await tick();
  check('HUI01 Mount adds an accessible records button without reading the journal', f.q('#ai-records-toggle').getAttribute('aria-expanded') === 'false' && f.journalCalls.length === 0);
  await f.click('#ai-records-toggle');
  check('HUI02 Explicit open loads local records and exposes the records section', !f.q('#ai-records').hidden && f.q('#ai-record-list').children.length === 3 && f.q('#ai-records-toggle').getAttribute('aria-expanded') === 'true');
  check('HUI03 List machine and goal use text nodes, retaining literal hostile markup', f.q('#ai-record-list').textContent.includes('<img src=x onerror=alert(1)>') && !f.q('#ai-record-list img'));
  await f.click('[data-ai-record-id="record-one"]');
  const detail = f.q('#ai-record-detail');
  check('HUI04 Detail renders command/result cards in execution order', detail.querySelectorAll('.ai-record-step').length === 3 && detail.textContent.indexOf('Safe output') < detail.textContent.indexOf('touch state-file'));
  check('HUI05 Detail renders all log data as text without executable HTML', detail.textContent.includes('<script>alert(1)</script>') && !detail.querySelector('script,img,svg,b'));
  check('HUI06 Incomplete dispatch and unstarted call are explicitly distinguished', detail.textContent.includes('结果未知，可能已产生副作用') && detail.textContent.includes('尚未发出执行请求') && detail.textContent.includes('尚未执行'));
  check('HUI07 Truncated log tail and exact target are visible', detail.textContent.includes('日志最后一条写入中断') && detail.textContent.includes('fixture@one:22'));
  check('HUI08 Same identity permits explicit continue and opening logs never runs commands', !f.q('#ai-record-resume').disabled && f.resumes.length === 0 && f.runs.length === 0 && f.nativeCalls.every(([command]) => command === 'ai_key_read'));
  await f.click('[data-ai-record-id="record-done"]');
  check('HUI09 Completed runs are viewable but cannot be resumed', f.q('#ai-record-resume').disabled && f.q('#ai-record-target-status').textContent.includes('任务已结束'));
  await f.click('[data-ai-record-id="record-other"]');
  check('HUI10 Different machine identity disables continue and explains reconnection', f.q('#ai-record-resume').disabled && f.q('#ai-record-target-status').textContent.includes('目标机器'));
  await f.click('[data-ai-record-id="record-one"]'); await f.click('#ai-record-resume');
  const resumed = f.resumes[0];
  check('HUI11 Continue calls resume with the record ID, bound current tab and restored local key', f.resumes.length === 1 && resumed.sessionId === 'record-one' && resumed.tab === f.tab && resumed.apiKey === 'LOCAL_API_KEY_NOT_IN_LOG' && resumed.goal === interrupted.metadata.goal);
  check('HUI12 Recovery forces command-by-command approval despite disabled normal preference', resumed.confirmEachCommand === true && f.WT.s.ai.confirmCommands === false && typeof resumed.approve === 'function');
  check('HUI13 New command output precedes final result and terminal input is returned', f.q('#ai-records').hidden && f.q('#ai-messages').textContent.indexOf('/fixture') < f.q('#ai-messages').textContent.indexOf('Resumed verified result') && f.tab.focused > 0 && !f.q('#ai-send').disabled);
  check('HUI14 Secret is not rendered in local history or the resumed conversation', !f.d.body.textContent.includes('LOCAL_API_KEY_NOT_IN_LOG'));
  await f.click('#ai-records-toggle'); await f.click('#ai-records-toggle');
  check('HUI15 Second header click closes records and restores the header focus', f.q('#ai-records').hidden && f.d.activeElement === f.q('#ai-records-toggle'));
  await f.click('#ai-records-toggle'); await f.click('#ai-record-close');
  check('HUI16 Close button closes only the records view', f.q('#ai-records').hidden && f.A.isOpen());

  for (const [label, mutate] of [
    ['HUI17 Target switch invalidates a delayed record read', x => x.switch(x.other)],
    ['HUI18 Same-tab reconnect invalidates delayed recovery', x => { x.tab._connectionGeneration++; x.A.onSessionChange(); }],
    ['HUI19 Stop invalidates delayed recovery', x => x.A.stop()],
    ['HUI20 Closing the records view invalidates delayed recovery', x => x.q('#ai-record-close').click()],
    ['HUI21 New conversation invalidates delayed recovery', x => x.A.newChat()],
    ['HUI22 Configuration changes invalidate delayed recovery', x => { x.WT.s.ai.model = 'different-model'; }],
    ['HUI23 Closing AI invalidates delayed recovery', x => x.A.close()],
    ['HUI23b Refreshing records invalidates delayed recovery', x => x.q('#ai-record-refresh').click()],
  ]) {
    const x = create(); await openDetail(x); x.state.holdRead = deferred(); x.q('#ai-record-resume').click(); await tick(); mutate(x); x.state.holdRead.resolve(clone(interrupted)); await tick();
    check(label, x.resumes.length === 0 && x.runs.length === 0);
  }
  const key = create({ holdKey: true }); await openDetail(key); key.q('#ai-record-resume').click(); await tick();
  check('HUI24 Recovery waits for system credential restoration before agent invocation', key.resumes.length === 0 && key.nativeCalls.filter(([command]) => command === 'ai_key_read').length === 1);
  key.switch(key.other); key.keyGate.resolve('LOCAL_API_KEY_NOT_IN_LOG'); await tick();
  check('HUI25 Late credential response cannot resume on a changed machine', key.resumes.length === 0);

  const failed = create(); failed.state.failList = true; await failed.click('#ai-records-toggle');
  check('HUI26 List failures expose a safe retry message without raw errors or secrets', failed.q('#ai-record-list').textContent.includes('读取失败') && !failed.d.body.textContent.includes('LOCAL_API_KEY_NOT_IN_LOG'));
  failed.state.failList = false; await failed.click('#ai-record-refresh'); failed.state.failRead = true; await failed.click('[data-ai-record-id="record-one"]');
  check('HUI27 Detail failures keep continue disabled and hide raw errors', failed.q('#ai-record-detail').textContent.includes('读取失败') && failed.q('#ai-record-resume').disabled && !failed.d.body.textContent.includes('LOCAL_API_KEY_NOT_IN_LOG'));
  failed.state.failRead = false; failed.state.holdRead = deferred(); failed.q('[data-ai-record-id="record-one"]').click(); await tick(); failed.q('#ai-record-close').click(); failed.state.holdRead.resolve(clone(interrupted)); await tick();
  check('HUI28 Late detail data cannot reopen or populate a closed view', failed.q('#ai-records').hidden && !failed.q('#ai-record-detail').textContent.includes('touch state-file'));

  const bounded = create(); bounded.store.list = async () => Array.from({ length: 105 }, (_, i) => ({ id: 'id-' + i, metadata: { goal: 'Task ' + i, target }, eventCount: 4, updatedAt: 1792000000000 })); await bounded.click('#ai-records-toggle');
  check('HUI29 Recent list is bounded to 100 entries', bounded.q('#ai-record-list').children.length === 100);
  const missing = create({ noHarness: true }); await missing.click('#ai-records-toggle');
  check('HUI30 Missing journal runtime fails visibly while ordinary AI panel remains usable', missing.q('#ai-record-list').textContent.includes('读取失败') && missing.A.isOpen());
  check('HUI31 Persistence copy distinguishes ephemeral chat and local operations logs', f.q('#ai-config').textContent.includes('普通对话仅在本次运行中保留；运维运行记录保存在本机') && f.q('.ai-record-privacy').textContent.includes('命令与输出保存在本机'));
  check('HUI32 No browser runtime error was raised by record rendering or async invalidation', errors.length === 0);
  const fingerprint = create(), fingerprintGate = deferred(); fingerprint.state.holdTarget = fingerprintGate; await openDetail(fingerprint);
  check('HUI33 Native identity verification keeps continue disabled until the fingerprint arrives', fingerprint.q('#ai-record-resume').disabled && fingerprint.q('#ai-record-target-status').textContent.includes('正在核对'));
  fingerprint.switch(fingerprint.other); fingerprintGate.resolve({ ...target }); await tick();
  check('HUI34 A late matching fingerprint cannot enable recovery after target switch', fingerprint.q('#ai-record-resume').disabled && fingerprint.resumes.length === 0);
  const badFingerprint = create(); badFingerprint.state.failTarget = true; await openDetail(badFingerprint);
  check('HUI35 Fingerprint errors disable recovery with safe visible retry text', badFingerprint.q('#ai-record-resume').disabled && badFingerprint.q('#ai-record-target-status').textContent.includes('无法核对') && !badFingerprint.d.body.textContent.includes('LOCAL_API_KEY_NOT_IN_LOG'));
  const changedFingerprint = create(); await openDetail(changedFingerprint); changedFingerprint.store.target = async () => ({ ...target, identity: 'changed-fingerprint' }); await changedFingerprint.click('#ai-record-resume');
  check('HUI36 Recovery independently rechecks the native fingerprint before invoking the agent', changedFingerprint.resumes.length === 0);
  const duplicate = create(); await openDetail(duplicate); duplicate.state.holdRead = deferred(); duplicate.q('#ai-record-resume').click(); duplicate.q('#ai-record-resume').click(); await tick(); duplicate.state.holdRead.resolve(clone(interrupted)); await tick();
  check('HUI37 Repeated continue clicks during preflight produce exactly one resumed run', duplicate.resumes.length === 1);
  const ordinary = create({ holdKey: true }); ordinary.A.setMode('agent'); ordinary.q('#ai-input').value = 'Explicit task'; const waitingSend = ordinary.A.send(); await tick(); ordinary.switch(ordinary.other); ordinary.keyGate.resolve('LOCAL_API_KEY_NOT_IN_LOG'); await waitingSend;
  check('HUI38 New operations tasks also bind the original machine while loading credentials', ordinary.runs.length === 0 && ordinary.resumes.length === 0 && ordinary.q('#ai-status').textContent.includes('活动机器已变化'));
  const nativeChanged = create(); await openDetail(nativeChanged); nativeChanged.state.holdRead = deferred(); nativeChanged.q('#ai-record-resume').click(); await tick(); nativeChanged.tab.ptyId = 'replacement-native'; nativeChanged.A.onSessionChange(); nativeChanged.state.holdRead.resolve(clone(interrupted)); await tick();
  check('HUI39 Replacement native sessions invalidate recovery even without a generation increment', nativeChanged.resumes.length === 0);
  const recentlyFinished = create(); await openDetail(recentlyFinished); recentlyFinished.store.replay = () => ({ status: 'complete' }); await recentlyFinished.click('#ai-record-resume');
  check('HUI40 A fresh record that completed since viewing is not passed to the agent', recentlyFinished.resumes.length === 0 && recentlyFinished.q('#ai-status').textContent.includes('此任务已结束'));
  const repaired = create(); repaired.records.get('record-one').events.push(...[['unknown', 'TOOL_OUTCOME_UNKNOWN', '实际结果未知；禁止自动重放'], ['not-started', 'TOOL_NOT_STARTED', '未执行，不自动执行']].map(([toolCallId, code, message], index) => ({ seq: 5 + index, kind: 'tool/result', data: { message: { role: 'tool', toolCallId, content: JSON.stringify({ code, message, requiresReconciliation: true }) } } })));
  repaired.store.replay = () => ({ status: 'stopped', pending: [] }); await openDetail(repaired);
  check('HUI41 Durable repair observations retain unknown/not-started labels after pending calls are closed', repaired.q('#ai-record-detail').textContent.includes('执行结果未知，请先核实') && repaired.q('#ai-record-detail').textContent.includes('尚未执行，不自动重放') && repaired.q('#ai-record-detail').textContent.includes('禁止自动重放'));
  console.log('AI harness UI checks: ' + checks.length + ' passed');
} finally { for (const f of fixtures) f.close(); }
