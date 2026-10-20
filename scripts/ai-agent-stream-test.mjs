// Real operations controller, context, journal and plugin kernel. Only the
// native model/event/storage bridges are controlled; no command or network runs.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { installHarnessFixture } from './harness-fixture.mjs';

let checks = 0;
const check = (name, value) => { assert.ok(value, name); checks++; console.log('PASS ' + name); };
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async (predicate, label) => { const end = Date.now() + 3000; while (!predicate()) { if (Date.now() > end) throw Error('Stream fixture deadline: ' + label); await tick(); } };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const call = id => ({ id, name: 'run_command', arguments: JSON.stringify({ command: 'printf controlled-fixture', purpose: '验证受控服务' }) });
const reply = (content = '已核实完成', toolCalls = []) => ({ content, toolCalls });
const output = () => ({ stdout: 'controlled result', stderr: '', exitCode: 0, durationMs: 2, timedOut: false, cancelled: false, truncated: false });
function commit(args, storage) {
  const record = storage.records.get(args.id);
  assert.equal(record.events.length, args.expectedSeq);
  const event = { seq: args.expectedSeq + 1, kind: args.kind, data: clone(args.data), at: Date.now() };
  record.events.push(event); return clone(event);
}
function env({ model, persist, listen, throwingDisposer = false } = {}) {
  const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only', url: 'http://tauri.localhost/' });
  const w = dom.window, calls = [], events = [], trace = [], listeners = new Map(), callbacks = new Map(), disposed = [];
  w.TextEncoder = TextEncoder;
  const tab = { id: 'fixture-ui', ptyId: 'fixture-native', _connectionGeneration: 7, title: '受控机器',
    session: { protocol: 'ssh', host: 'fixture.invalid', user: 'ops', port: 22 } };
  const T = w.WT = {
    term: { tabs: { [tab.id]: tab }, ptyId: value => value.ptyId, isLive: value => value === tab && !value.exited && !value._closing,
      activeTab: () => tab },
    invoke(name, args) {
      trace.push({ kind: 'invoke', name, args: clone(args) }); calls.push({ name, args: clone(args) });
      if (name === 'ai_agent_step') return model?.(args, calls) ?? Promise.resolve(reply());
      if (name === 'agent_exec') return Promise.resolve(output());
      return Promise.resolve(null);
    },
    listen(name, callback) {
      const captured = callbacks.get(name) || []; captured.push(callback); callbacks.set(name, captured);
      const dispose = () => {
        disposed.push(name); if (listeners.get(name) === callback) listeners.delete(name);
        if (throwingDisposer && name === 'agent-exec-output') throw Error('controlled disposer error');
      };
      const intercepted = listen?.(name, callback, dispose);
      if (intercepted !== undefined) return intercepted;
      listeners.set(name, callback); return Promise.resolve(dispose);
    },
  };
  const fixture = installHarnessFixture(w, T, { intercept(name, args, storage) {
    trace.push({ kind: 'persistence', name, event: args.kind });
    return persist?.(name, args, storage);
  } });
  for (const file of ['ai-context.js', 'ai-agent.js']) w.eval(readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'));
  const options = { goal: '验证受控服务', endpoint: 'https://model.fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-secret',
    tab, confirmEachCommand: true, onEvent(event) { trace.push({ kind: 'view', event: event.type, requestId: event.requestId, status: event.status }); events.push(clone(event)); } };
  return { w, T, tab, calls, events, trace, fixture, callbacks, disposed, listeners,
    run: extra => w.OpsAgent.run({ ...options, ...extra }), count: name => calls.filter(item => item.name === name).length,
    models: () => calls.filter(item => item.name === 'ai_agent_step').map(item => item.args.request),
    emit(value) { listeners.get('ai-chat-delta')?.({ payload: value }); },
    raw(callback, value) { callback({ payload: value }); }, close() { w.OpsAgent.stop(); w.close(); } };
}

{
  const response = deferred(), e = env({ model: () => response.promise });
  try {
    const task = e.run(); await until(() => e.models().length === 1, 'first model');
    const requestId = e.models()[0].requestId, operations = e.fixture.operations.length;
    check('AS01 Both native listeners are ready before a model request is submitted', e.listeners.has('ai-chat-delta') && e.listeners.has('agent-exec-output'));
    check('AS02 Model start identifies the current round and precedes its native request', e.events.some(event => event.type === 'model/start' && event.requestId === requestId && event.round === 1)
      && e.trace.findIndex(item => item.event === 'model/start') < e.trace.findIndex(item => item.name === 'ai_agent_step'));
    e.emit({ requestId, delta: '## 检查\n', done: false }); e.emit({ requestId, delta: '**运行中** 🙂', done: false });
    check('AS03 Unicode Markdown text is visible before the model IPC resolves', e.events.filter(event => event.type === 'model/delta').map(event => event.delta).join('') === '## 检查\n**运行中** 🙂' && e.w.OpsAgent.isRunning());
    check('AS04 Stream tokens create no durable journal events or machine operations', e.fixture.operations.length === operations && e.count('agent_exec') === 0);
    const before = e.events.length;
    for (const value of [null, {}, { requestId: 'another-model', delta: 'wrong' }, { requestId, delta: 12 }, { requestId, delta: 'wrong', done: 'true' },
      { requestId, toolCalls: [call('partial')], delta: null }, { requestId: 'ops-compact-unrelated', delta: 'summary' }]) e.emit(value);
    check('AS05 Wrong requests, malformed deltas, compaction traffic and partial tool payloads are ignored', e.events.length === before && e.count('agent_exec') === 0);
    e.emit({ requestId, delta: '', done: true }); e.emit({ requestId, delta: 'after done', done: false });
    check('AS06 Native done closes preview text without finalizing or authorizing the model round', e.events.length === before && !e.events.some(event => event.type === 'model/end') && e.count('agent_exec') === 0);
    response.resolve(reply('权威的完整回答')); const result = await task;
    const end = e.events.find(event => event.type === 'model/end'), record = e.fixture.records.get(result.sessionId);
    check('AS07 Complete IPC content replaces preview after validated durable acknowledgement', result.status === 'complete' && end.status === 'complete' && end.content === '权威的完整回答' && end.hasToolCalls === false
      && e.trace.findIndex(item => item.kind === 'persistence' && item.event === 'assistant/message') < e.trace.findIndex(item => item.kind === 'view' && item.event === 'model/end'));
    check('AS08 Journal stores one complete assistant message and no per-token events', record.events.filter(event => event.kind === 'assistant/message').length === 1 && !record.events.some(event => event.kind.startsWith('model/')));
    check('AS09 Successful teardown releases both listeners once', e.listeners.size === 0 && e.disposed.length === 2 && new Set(e.disposed).size === 2 && !e.w.OpsAgent.isRunning());
  } finally { e.close(); }
}

{
  const first = deferred(), second = deferred(), ack = deferred(), approval = deferred(); let rounds = 0;
  const e = env({ model: () => ++rounds === 1 ? first.promise : second.promise,
    persist: (name, args, storage) => name === 'harness_append' && args.kind === 'assistant/message' && rounds === 1
      ? ack.promise.then(() => commit(args, storage)) : undefined });
  try {
    const task = e.run({ approve: () => approval.promise }); await until(() => e.models().length === 1, 'proposal');
    const firstId = e.models()[0].requestId;
    e.emit({ requestId: firstId, delta: '先检查服务', done: false });
    check('AS10 Streaming a purpose does not execute, approve or persist a partial tool proposal', e.count('agent_exec') === 0 && !e.events.some(event => event.type === 'approval') && ![...e.fixture.records.values()][0].events.some(event => event.kind === 'assistant/message'));
    first.resolve(reply('先检查服务，再核实结果', [call('controlled-proposal')]));
    await until(() => e.fixture.operations.some(item => item.args.kind === 'assistant/message'), 'held assistant acknowledgement');
    const deltaCount = e.events.filter(event => event.type === 'model/delta').length;
    e.emit({ requestId: firstId, delta: 'late while ACK pending', done: false }); await tick();
    check('AS11 IPC completion cannot accept late tokens or authorize tools while assistant journal ACK is pending', e.events.filter(event => event.type === 'model/delta').length === deltaCount && e.count('agent_exec') === 0
      && !e.events.some(event => event.type === 'approval' || event.type === 'model/end'));
    ack.resolve(); await until(() => e.events.some(event => event.type === 'approval'), 'approval after durable assistant');
    const end = e.events.find(event => event.type === 'model/end');
    check('AS12 Validated complete proposal ends before fresh command approval and still waits for user decision', end.requestId === firstId && end.round === 1 && end.hasToolCalls && end.content === '先检查服务，再核实结果'
      && e.events.indexOf(end) < e.events.findIndex(event => event.type === 'approval') && e.count('agent_exec') === 0);
    approval.resolve(true); await until(() => e.models().length === 2, 'second model after native result');
    const secondId = e.models()[1].requestId, before = e.events.filter(event => event.type === 'model/delta').length;
    e.emit({ requestId: firstId, delta: 'stale round', done: false }); e.emit({ requestId: firstId, delta: '', done: true });
    e.emit({ requestId: secondId, delta: '结果已验证', done: false });
    const streamed = e.events.filter(event => event.type === 'model/delta');
    check('AS13 Each new model round has its own request and rejects previous round tokens and done', firstId !== secondId && streamed.length === before + 1 && streamed.at(-1).round === 2 && streamed.at(-1).requestId === secondId);
    const native = e.trace.findIndex(item => item.name === 'agent_exec'), beforeNative = e.trace.slice(0, native);
    check('AS14 Durable proposal, user approval and dispatch remain ordered before native execution', beforeNative.findIndex(item => item.kind === 'persistence' && item.event === 'assistant/message')
      < beforeNative.findIndex(item => item.kind === 'persistence' && item.event === 'tool/approval')
      && beforeNative.findIndex(item => item.kind === 'persistence' && item.event === 'tool/approval') < beforeNative.findIndex(item => item.kind === 'persistence' && item.event === 'tool/dispatch') && e.count('agent_exec') === 1);
    second.resolve(reply('最终验证成功')); const result = await task;
    const ends = e.events.filter(event => event.type === 'model/end');
    check('AS15 Both round texts have stable order around command results and the final summary', result.status === 'complete' && ends.length === 2 && ends[0].round === 1 && ends[1].round === 2
      && e.events.indexOf(ends[0]) < e.events.findIndex(event => event.type === 'command') && e.events.findIndex(event => event.type === 'result') < e.events.indexOf(ends[1]) && !ends[1].hasToolCalls);
  } finally { e.close(); }
}

{
  const old = deferred(), fresh = deferred(); let rounds = 0;
  const e = env({ model: () => ++rounds === 1 ? old.promise : fresh.promise });
  try {
    const task = e.run(); await until(() => e.models().length === 1, 'cancellable model');
    const oldId = e.models()[0].requestId, oldCallback = e.callbacks.get('ai-chat-delta')[0];
    e.emit({ requestId: oldId, delta: '部分回答', done: false }); e.w.OpsAgent.stop(); const stopped = await task;
    check('AS16 Cancellation closes the active model preview once and cancels its exact native request', stopped.status === 'stopped' && e.events.filter(event => event.type === 'model/end').length === 1
      && e.events.find(event => event.type === 'model/end').status === 'stopped' && e.calls.some(item => item.name === 'ai_cancel' && item.args.requestId === oldId));
    const eventsAtStop = e.events.length; e.raw(oldCallback, { requestId: oldId, delta: 'late after stop' });
    check('AS17 Queued native callbacks remain inert after stop and listener disposal', e.events.length === eventsAtStop && e.listeners.size === 0);
    const next = e.run(); await until(() => e.models().length === 2, 'replacement task');
    const freshId = e.models()[1].requestId, before = e.events.filter(event => event.type === 'model/delta').length;
    e.raw(oldCallback, { requestId: oldId, delta: 'old listener' }); e.emit({ requestId: oldId, delta: 'old request on new listener' });
    e.emit({ requestId: freshId, delta: '新任务', done: false }); old.resolve(reply('late old model', [call('forbidden-late-call')])); await tick();
    check('AS18 A new task accepts only its own stream and an old model response cannot execute', e.events.filter(event => event.type === 'model/delta').length === before + 1 && e.events.filter(event => event.type === 'model/delta').at(-1).requestId === freshId && e.count('agent_exec') === 0);
    fresh.resolve(reply('新任务完成')); await next;
    check('AS19 Consecutive tasks dispose their two independently registered listeners exactly once', e.disposed.length === 4 && e.disposed.filter(name => name === 'ai-chat-delta').length === 2 && e.listeners.size === 0);
  } finally { e.close(); }
}

for (const mutation of ['exit', 'generation', 'replacement', 'close']) {
  const response = deferred(), e = env({ model: () => response.promise });
  try {
    const task = e.run(); await until(() => e.models().length === 1, 'target mutation'); const requestId = e.models()[0].requestId;
    if (mutation === 'exit') e.tab.exited = true;
    if (mutation === 'generation') e.tab._connectionGeneration++;
    if (mutation === 'replacement') e.T.term.tabs[e.tab.id] = { ...e.tab };
    if (mutation === 'close') e.tab._closing = true;
    e.emit({ requestId, delta: 'invalid target token' }); e.w.OpsAgent.checkTarget(); const result = await task;
    response.resolve(reply('invalid target complete', [call('forbidden-' + mutation)])); await tick();
    check('AS20 ' + mutation + ' invalidates stream ownership and closes its model round without execution', result.status === 'stopped' && !e.events.some(event => event.type === 'model/delta')
      && e.events.filter(event => event.type === 'model/end').length === 1 && e.events.find(event => event.type === 'model/end').status === 'stopped' && e.count('agent_exec') === 0 && e.listeners.size === 0);
  } finally { e.close(); }
}

for (const failure of ['invalid-batch', 'journal', 'provider']) {
  const response = deferred();
  const e = env({ model: () => response.promise,
    persist: (name, args) => failure === 'journal' && name === 'harness_append' && args.kind === 'assistant/message' ? Promise.reject(Error('controlled private disk error')) : undefined });
  try {
    const task = e.run({ confirmEachCommand: false }); await until(() => e.models().length === 1, 'failing model');
    const requestId = e.models()[0].requestId;
    e.emit({ requestId, delta: '临时预览', done: false });
    if (failure === 'provider') response.reject(Error('controlled private provider error fixture-secret'));
    else response.resolve(reply('完整但尚未接受的提议', [call('valid-first'), ...(failure === 'invalid-batch' ? [{ ...call('bad-second'), arguments: '{partial' }] : [])]));
    const result = await task, ends = e.events.filter(event => event.type === 'model/end');
    check('AS21 ' + failure + ' closes preview as error and cannot execute even a valid first command', result.status === 'error' && e.count('agent_exec') === 0 && ends.length === 1 && ends[0].status === 'error'
      && !('content' in ends[0]) && !e.events.some(event => event.type === 'approval') && !result.summary.includes('fixture-secret') && e.listeners.size === 0);
  } finally { e.close(); }
}

{
  const registration = deferred(); let release, captured;
  const e = env({ listen: (name, callback, dispose) => {
    if (name !== 'ai-chat-delta') return undefined; release = dispose; captured = callback; return registration.promise;
  } });
  try {
    const task = e.run(); await until(() => !!release, 'late model-listener registration'); e.w.OpsAgent.stop(); const result = await task;
    check('AS22 Stopping during second listener registration releases the already registered execution listener', result.status === 'stopped' && e.disposed.join(',') === 'agent-exec-output' && e.count('ai_agent_step') === 0);
    registration.resolve(release); await tick(); await tick(); e.raw(captured, { requestId: 'late', delta: 'late' });
    check('AS23 A model listener resolving after teardown is disposed exactly once without rendering', e.disposed.length === 2 && e.disposed[1] === 'ai-chat-delta' && !e.events.some(event => event.type.startsWith('model/')));
  } finally { e.close(); }
}

{
  const e = env({ listen: name => name === 'ai-chat-delta' ? Promise.reject(Error('controlled register failure')) : undefined });
  try { const result = await e.run(); check('AS24 Stream registration failure prevents model submission and disposes the first listener', result.status === 'error' && e.count('ai_agent_step') === 0 && e.disposed.join(',') === 'agent-exec-output' && e.listeners.size === 0); }
  finally { e.close(); }
}

{
  const response = deferred(), e = env({ model: () => response.promise, throwingDisposer: true });
  try {
    const task = e.run(); await until(() => e.models().length === 1, 'bounded stream'); const requestId = e.models()[0].requestId;
    e.emit({ requestId, delta: '中'.repeat(50000) + '🙂', done: false }); e.emit({ requestId, delta: 'more'.repeat(50000), done: false });
    const deltas = e.events.filter(event => event.type === 'model/delta'), preview = deltas.map(event => event.delta).join('');
    check('AS25 Preview keeps a bounded UTF8 prefix without split surrogates or appending after truncation', Buffer.byteLength(preview) <= 128 * 1024 && !/[\uD800-\uDBFF]$/.test(preview) && deltas.length === 1 && deltas[0].truncated);
    response.resolve(reply('完整权威结果')); const result = await task;
    check('AS26 A throwing execution disposer cannot retain the model listener or live task', result.status === 'complete' && e.disposed.length === 2 && e.listeners.size === 0 && !e.w.OpsAgent.isRunning());
  } finally { e.close(); }
}

console.log(`\nAI operations streaming: ${checks}/${checks} checks passed. Real controller/kernel; model/native bridges controlled, no machine commands.`);
