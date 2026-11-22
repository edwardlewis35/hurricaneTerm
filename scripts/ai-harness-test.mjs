// Execute the production kernel with a deterministic native journal bridge.
// The fixtures never call a model or execute an operating-system command.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('../src/ai-harness.js', import.meta.url), 'utf8');
const world = { window: {}, TextEncoder };
vm.runInNewContext(source, world, { filename: 'ai-harness.js' });
const { createRuntime, createJournal } = world.window.AiHarness;
const checks = [];
const check = (name, value = true) => { assert.ok(value, name); checks.push(name); console.log('PASS ' + name); };
const copy = value => JSON.parse(JSON.stringify(value));
const reject = async (name, promise, pattern) => { await assert.rejects(promise, pattern); check(name); };
const throws = (name, action, pattern) => { assert.throws(action, pattern); check(name); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

{
  const runtime = createRuntime(), order = [];
  await runtime.mountAll([
    { id: 'view', requires: ['tools'], setup(ctx) { order.push('view'); ctx.provide('view', { tools: ctx.service('tools') }); } },
    { id: 'tools', requires: ['model'], setup(ctx) { order.push('tools'); ctx.provide('tools', { model: ctx.service('model') }); } },
    { id: 'model', requires: [], async setup(ctx) { await tick(); order.push('model'); ctx.provide('model', 'configured-model'); } },
  ]);
  check('H01 Dependencies are mounted before async dependent setup', order.join(',') === 'model,tools,view');
  check('H02 Plugins resolve real services through the scoped context', runtime.service('view').tools.model === 'configured-model');
  const inventory = runtime.plugins(); inventory[0].requires.push('corruption'); inventory[0].services.length = 0;
  check('H03 Plugin inventory is an independent snapshot', runtime.plugins()[0].requires.length === 0 && runtime.plugins()[0].services[0] === 'model');
  await reject('H04 A mounted dependency cannot be removed', runtime.unmount('model'), /仍被依赖/);
  await runtime.unmount('view'); await runtime.unmount('tools'); await runtime.unmount('model');
  throws('H05 Unmount removes scoped provided services', () => runtime.service('model'), /未注册服务/);
  check('H06 Unmount removes plugin inventory entries', runtime.plugins().length === 0);
  await runtime.close(); await runtime.close();
  throws('H07 Closed runtimes reject new leases', () => runtime.acquire(), /已关闭/);
  await reject('H08 Closed runtimes reject dispatch', runtime.dispatch('task', {}), /已关闭/);
}

for (const [name, plugins, pattern] of [
  ['unknown dependency', [{ id: 'one', requires: ['missing'], setup() {} }], /未知插件依赖/],
  ['dependency cycle', [{ id: 'one', requires: ['two'], setup() {} }, { id: 'two', requires: ['one'], setup() {} }], /循环依赖/],
  ['duplicate plugin id', [{ id: 'one', setup() {} }, { id: 'one', setup() {} }], /插件重名/],
  ['duplicate dependency', [{ id: 'one', requires: ['two', 'two'], setup() {} }], /依赖无效/],
]) {
  const runtime = createRuntime();
  await reject('H09 Preflight rejects ' + name, runtime.mountAll(plugins), pattern);
  check('H10 Invalid plugin graph never leaves partial registrations: ' + name, runtime.plugins().length === 0);
  await runtime.close();
}

{
  const runtime = createRuntime(), cleanup = [], seen = [];
  await runtime.mountAll([{ id: 'stable', setup(ctx) { ctx.provide('stable', 17); ctx.on('hook', () => seen.push('stable')); } }]);
  await reject('H11 Setup failure rejects the whole mount batch', runtime.mountAll([
    { id: 'first', requires: ['stable'], setup(ctx) { ctx.provide('temporary', true); ctx.effect(() => cleanup.push('first')); ctx.on('hook', () => seen.push('leaked')); } },
    { id: 'bad', requires: ['first'], async setup(ctx) { ctx.provide('bad', true); ctx.effect(async () => { await tick(); cleanup.push('bad'); }); throw new Error('fixture setup'); } },
  ]), /fixture setup/);
  check('H12 Rollback awaits reverse dependency order', cleanup.join(',') === 'bad,first');
  check('H13 Rollback preserves plugins mounted before this batch', runtime.plugins().length === 1 && runtime.service('stable') === 17);
  throws('H14 Rollback removes partially registered services', () => runtime.service('temporary'), /未注册服务/);
  await runtime.dispatch('hook');
  check('H15 Rollback removes failed-batch event listeners', seen.join(',') === 'stable');
  await reject('H16 Service names are unique across plugins', runtime.mountAll([{ id: 'collision', setup(ctx) { ctx.provide('stable', 99); } }]), /服务重名/);
  check('H17 Service collision keeps the existing owner', runtime.service('stable') === 17 && runtime.plugins().length === 1);
  await runtime.close();
}

{
  const runtime = createRuntime(), fired = []; let oldService, oldHook, scope;
  await runtime.mountAll([{ id: 'reusable', setup(ctx) {
    scope = ctx; oldService = ctx.provide('value', 1); oldHook = ctx.on('hook', () => fired.push('old'));
  } }]);
  oldService(); oldHook();
  scope.provide('value', 2); scope.on('hook', () => fired.push('new'));
  oldService(); oldHook(); await runtime.dispatch('hook');
  check('H18 Old service disposers cannot remove a later registration', runtime.service('value') === 2);
  check('H19 Old hook disposers cannot remove a later listener', fired.join(',') === 'new');
  let releases = 0; const dispose = scope.effect(() => releases++); dispose(); dispose();
  await runtime.unmount('reusable');
  check('H20 Every effect is disposed at most once', releases === 1);
  throws('H21 A revoked scope cannot register a new service', () => scope.provide('late', 1), /撤销/);
  throws('H22 A revoked scope cannot register a new listener', () => scope.on('late', () => {}), /监听器无效/);
  await runtime.close();
}

{
  const runtime = createRuntime(); await runtime.mountAll([{ id: 'live', setup() {} }]);
  const first = runtime.acquire(), second = runtime.acquire(); first(); first();
  await reject('H23 Task leases block mount', runtime.mountAll([{ id: 'extra', setup() {} }]), /运行中/);
  await reject('H24 Task leases block unmount', runtime.unmount('live'), /运行中/);
  await reject('H25 Task leases block close', runtime.close(), /运行中/);
  second(); await runtime.unmount('live');
  check('H26 Releasing each lease once restores mutation access', runtime.plugins().length === 0);
  await runtime.close();
}

{
  const runtime = createRuntime(), gate = deferred(), events = [];
  await runtime.mountAll([{ id: 'hooks', setup(ctx) {
    ctx.on('observe', async value => { events.push('first-' + value); await gate.promise; events.push('first-done'); });
    ctx.on('observe', value => events.push('second-' + value));
  } }]);
  const dispatch = runtime.dispatch('observe', 'fixture'); await tick();
  check('H27 Event hooks await the preceding hook', events.join(',') === 'first-fixture');
  await reject('H28 An async dispatch holds a lease against unloading', runtime.unmount('hooks'), /运行中/);
  gate.resolve(); await dispatch;
  check('H29 Event hooks finish in deterministic serial order', events.join(',') === 'first-fixture,first-done,second-fixture');
  await runtime.close();
}

{
  const runtime = createRuntime(), cleanup = [];
  await runtime.mountAll([{ id: 'base', setup(ctx) { ctx.effect(() => cleanup.push('base')); } },
    { id: 'dependent', requires: ['base'], setup(ctx) { ctx.effect(() => { cleanup.push('throw'); throw new Error('fixture cleanup'); }); ctx.effect(() => cleanup.push('last')); } }]);
  await reject('H30 Cleanup errors are reported after other scopes are released', runtime.close(), /清理失败/);
  check('H31 Close cleans every effect in reverse registration order', cleanup.join(',') === 'last,throw,base' && runtime.plugins().length === 0);
  throws('H32 Cleanup failures still leave the runtime closed', () => runtime.acquire(), /已关闭/);
}

function bridge(interceptor) {
  const calls = [], records = new Map();
  const native = {
    async invoke(command, args) {
      calls.push({ command, args: copy(args) });
      const intercepted = interceptor?.(command, args, { calls, records });
      if (intercepted !== undefined) return await intercepted;
      if (command === 'harness_fingerprint') return createHash('sha256').update(args.identity).digest('hex');
      if (command === 'harness_create') {
        if (records.has(args.id)) throw new Error('session exists');
        const record = { id: args.id, metadata: copy(args.metadata), events: [], interruptedTail: false };
        records.set(args.id, record); return copy(record);
      }
      if (command === 'harness_append') {
        const record = records.get(args.id); if (!record || args.expectedSeq !== record.events.length) throw new Error('sequence conflict');
        const event = { seq: record.events.length + 1, kind: args.kind, data: copy(args.data), at: 1000 + record.events.length };
        record.events.push(event); return copy(event);
      }
      if (command === 'harness_read') { if (!records.has(args.id)) throw new Error('missing session'); return copy(records.get(args.id)); }
      if (command === 'harness_list') return [...records.values()].map(record => ({ id: record.id, metadata: copy(record.metadata),
        eventCount: record.events.length, updatedAt: record.events.at(-1)?.at || 0, interruptedTail: record.interruptedTail }));
      throw new Error('unexpected native command ' + command);
    },
  };
  return { native, calls, records, journal: options => createJournal(native, options) };
}
const assistant = (...calls) => ({ role: 'assistant', content: null, toolCalls: calls.map(([id, name = 'run_command', args = '{"command":"printf fixture"}']) => ({ id, name, arguments: args })) });
const tool = (id, content = '{"stdout":"fixture","exitCode":0}') => ({ role: 'tool', toolCallId: id, content });
const history = [{ role: 'system', content: 'Fixture rules' }, { role: 'user', content: 'Inspect fixture' }];
const fingerprint = 'a'.repeat(64);
const target = { identity: fingerprint, protocol: 'ssh', host: 'fixture.invalid', user: 'tester', port: 22, title: 'Fixture' };
const event = (kind, data) => ({ kind, data });
const session = (events, extra = {}) => ({ id: 'fixture-session', metadata: { goal: 'Fixture', target },
  events: events.map((entry, index) => ({ ...copy(entry), seq: index + 1, at: index + 1000 })), interruptedTail: false, ...extra });

{
  const b = bridge(), journal = b.journal({ secrets: ['fixture-api-secret', '', 'fixture-api-secret'] });
  const metadata = { goal: 'Check fixture-api-secret safely', target, apiKey: 'never-send', nested: { password: 'password', access_token: 'token',
    embeddingKey: 'embedding', contextTokens: 8192, ordinary: 'before fixture-api-secret after', array: ['fixture-api-secret'] } };
  await journal.create('new-session', metadata);
  check('H33 Create binds the caller-provided session id with sequence zero', journal.id === 'new-session' && journal.seq === 0);
  const sent = b.calls[0].args;
  check('H34 Metadata removes recursive sensitive field names', !('apiKey' in sent.metadata) && !('password' in sent.metadata.nested) && !('access_token' in sent.metadata.nested) && !('embeddingKey' in sent.metadata.nested));
  check('H35 Scrubbing retains innocent context token counters', sent.metadata.nested.contextTokens === 8192);
  check('H36 Key strings are replaced in nested strings and arrays', sent.metadata.goal === 'Check [REDACTED] safely' && sent.metadata.nested.array[0] === '[REDACTED]');
  check('H37 The bridge receives neither the secret list nor secret values', !JSON.stringify(b.calls).includes('fixture-api-secret') && !('secrets' in sent));
  await journal.append('history/replace', { messages: history, rounds: 0, commands: 0, compactions: 0 });
  await journal.append('assistant/message', { message: { ...assistant(['one']), reasoning_content: 'PRIVATE THOUGHT', privateAnalysis: 'PRIVATE THOUGHT' } });
  const modelMessage = b.calls.at(-1).args.data.message;
  check('H38 Assistant journal projection excludes private reasoning fields', !JSON.stringify(modelMessage).includes('PRIVATE THOUGHT') && Object.keys(modelMessage).sort().join(',') === 'content,role,toolCalls');
  await journal.append('tool/dispatch', { callId: 'one', name: 'run_command', requestId: 'native-request', index: 1, command: 'printf fixture-api-secret', purpose: 'Fixture' });
  await journal.append('tool/result', { message: tool('one', '{"stdout":"fixture-api-secret","contextTokens":2}') });
  check('H39 Tool result strings retain exact formatting while replacing secrets', b.calls.at(-1).args.data.message.content === '{"stdout":"[REDACTED]","contextTokens":2}');
  check('H40 Every append uses the acknowledged preceding sequence', b.calls.filter(call => call.command === 'harness_append').map(call => call.args.expectedSeq).join(',') === '0,1,2,3' && journal.seq === 4);
  const read = await b.journal({ secrets: ['fixture-api-secret'] }).read('new-session');
  check('H41 A new journal can bind and read complete native events', read.events.length === 4 && read.events[3].seq === 4);
  const listed = await journal.list();
  check('H42 Session listing validates summary records without needing event payloads', listed.length === 1 && listed[0].eventCount === 4 && !('events' in listed[0]));
  await reject('H43 A bound journal cannot switch to another session', journal.read('different-session'), /不能切换/);
}

{
  const gate = deferred(); let first = true;
  const b = bridge((command, args, { records }) => {
    if (command === 'harness_append' && first) {
      first = false;
      return gate.promise.then(() => { const entry = { seq: 1, kind: args.kind, data: copy(args.data), at: 1000 }; records.get(args.id).events.push(entry); return entry; });
    }
  }), journal = b.journal(); await journal.create('serial', {});
  const one = journal.append('session/start', {}), two = journal.append('turn/start', { goal: 'Fixture' });
  await tick();
  check('H44 An unacknowledged append blocks the next native append', b.calls.filter(call => call.command === 'harness_append').length === 1 && journal.seq === 0);
  gate.resolve(); await Promise.all([one, two]);
  check('H45 Concurrent callers append in strict acknowledgement order', b.calls.filter(call => call.command === 'harness_append').map(call => call.args.expectedSeq).join(',') === '0,1' && journal.seq === 2);
}

{
  const b = bridge(command => command === 'harness_append' ? Promise.reject(new Error('disk full fixture')) : undefined), journal = b.journal();
  await journal.create('failure', {});
  const first = journal.append('session/start', {}), second = journal.append('turn/start', { goal: 'must never run' });
  const results = await Promise.allSettled([first, second]);
  check('H46 A failed append rejects already queued later appends', results.every(result => result.status === 'rejected') && results.every(result => /disk full/.test(result.reason.message)));
  await reject('H47 A failed append permanently blocks later append side effects', journal.append('turn/end', { status: 'error', summary: 'unsafe to continue' }), /disk full/);
  check('H48 Failed persistence never advances seq or calls native again', journal.seq === 0 && b.calls.filter(call => call.command === 'harness_append').length === 1);
}

for (const [label, mutate] of [
  ['skipped sequence', value => ({ ...value, seq: 2 })],
  ['wrong event kind', value => ({ ...value, kind: 'turn/start', data: { goal: 'unexpected' } })],
  ['changed event data', value => ({ ...value, data: { injected: true } })],
  ['invalid timestamp', value => ({ ...value, at: -1 })],
]) {
  const b = bridge((command, args) => command === 'harness_append' ? mutate({ seq: 1, kind: args.kind, data: copy(args.data), at: 1 }) : undefined), journal = b.journal();
  await journal.create('ack-fixture', {});
  await reject('H49 Native acknowledgement rejects ' + label, journal.append('session/start', {}), /AI Harness/);
  check('H50 Invalid native acknowledgement cannot advance local sequence: ' + label, journal.seq === 0);
}

{
  const b = bridge(), journal = b.journal(), identity = { user: 'tester', protocol: 'ssh', host: 'fixture.invalid', port: 22,
    password: 'connection-password', proxy: { user: 'jump', host: 'jump.invalid' } };
  const first = await journal.target({ id: 'tab-a', ptyId: 'native-a', title: 'Fixture', _connectionGeneration: 2, _connectionIdentity: identity });
  const second = await journal.target({ id: 'tab-b', ptyId: 'native-b', title: 'Other display title', _connectionGeneration: 99,
    _connectionIdentity: { proxy: { host: 'jump.invalid', user: 'jump' }, port: 22, host: 'fixture.invalid', protocol: 'ssh', user: 'tester', password: 'connection-password' } });
  check('H51 Stable identity hashing ignores object key order and UI session ids', first.identity === second.identity);
  check('H52 Public targets do not contain connection secrets or native ids', Object.keys(first).sort().join(',') === 'host,identity,port,protocol,title,user' && !JSON.stringify(first).includes('connection-password') && !JSON.stringify(first).includes('native-a'));
  check('H53 Public target metadata is immutable', Object.isFrozen(first));
  const changed = await journal.target({ _connectionIdentity: { ...identity, host: 'different.invalid' } });
  check('H54 Changing a connection endpoint changes its recovery fingerprint', changed.identity !== first.identity);
  const credentials = await journal.target({ _connectionIdentity: { ...identity, password: 'different-password' } });
  check('H55 Changing a connection credential invalidates a recovery fingerprint', credentials.identity !== first.identity);
  const local = await journal.target({ id: 'local-tab', ptyId: 'local-pty' });
  check('H56 Local targets use a stable local identity without terminal ids', local.protocol === 'local' && local.host === '' && local.port === null);
  const before = b.calls.length;
  await reject('H57 Oversized identity is rejected before calling native', journal.target({ session: { protocol: 'ssh', host: '中'.repeat(30000) } }), /大小超限/);
  check('H58 Oversized identities never cross the native bridge', before === b.calls.length);
  const circular = { protocol: 'ssh' }; circular.loop = circular;
  await reject('H59 Cyclic identities fail explicitly', journal.target({ session: circular }), /有限的 JSON/);
}

{
  const b = bridge(), journal = b.journal();
  const record = session([event('history/replace', { messages: history, rounds: 0, commands: 0, compactions: 0 }),
    event('step/start', { round: 1 }), event('assistant/message', { message: assistant(['first'], ['second'], ['third']) }),
    event('tool/call', { callId: 'first', name: 'run_command' }), event('tool/dispatch', { callId: 'first', name: 'run_command', index: 1 }),
    event('tool/result', { message: tool('first', '{"stdout":"confirmed exact","exitCode":0}') }),
    event('tool/call', { callId: 'second', name: 'run_command' }), event('tool/dispatch', { callId: 'second', name: 'run_command', index: 2 }),
    event('tool/call', { callId: 'third', name: 'run_command' })]);
  const result = journal.replay(record);
  check('H60 Replay projects assistant and completed tool events into model history', result.history[2].role === 'assistant' && result.history[3].content === '{"stdout":"confirmed exact","exitCode":0}');
  check('H61 Replay preserves multi-call result order in one assistant group', result.history.slice(3).map(value => value.toolCallId).join(',') === 'first,second,third');
  check('H62 Dispatched calls with unknown outcomes require reconciliation', JSON.parse(result.history[4].content).code === 'TOOL_OUTCOME_UNKNOWN' && result.pending[0].dispatched);
  check('H63 Calls not dispatched are marked as never started', JSON.parse(result.history[5].content).code === 'TOOL_NOT_STARTED' && !result.pending[1].dispatched);
  check('H64 Interrupted projection never re-executes tools', b.calls.length === 0 && result.interrupted && result.requiresReconciliation && result.status === 'interrupted');
  check('H65 Replay tracks all tool ids including completed ones', result.toolIds.join(',') === 'first,second,third' && result.repairMessages.length === 2);
  check('H66 Replay counters come from steps and actual dispatch events', result.rounds === 1 && result.commands === 2 && result.compactions === 0);
  check('H67 Every synthetic result explicitly warns against automatic replay', result.repairMessages.every(value => JSON.parse(value.content).requiresReconciliation === true && JSON.parse(value.content).interrupted === true));
}

{
  const journal = bridge().journal(), initial = [...history, assistant(['complete']), tool('complete')];
  const result = journal.replay(session([
    event('history/replace', { messages: history }), event('step/start', { round: 1 }), event('assistant/message', { message: assistant(['complete']) }),
    event('tool/dispatch', { callId: 'complete' }), event('tool/result', { message: tool('complete') }),
    event('history/replace', { messages: [{ role: 'system', content: 'Fixture rules' }, { role: 'user', content: 'Inspect fixture' },
      { role: 'assistant', content: 'Prior results compacted safely' }], rounds: 1, commands: 1, compactions: 1 }),
    event('step/start', { round: 2 }), event('assistant/message', { message: { role: 'assistant', content: 'Verified final result', reasoning: 'discard private field' } }),
    event('turn/end', { status: 'complete', summary: 'Fixture succeeded' })]));
  check('H68 History replacement applies to the event projection', result.history.length === 4 && result.history[2].content === 'Prior results compacted safely' && result.history[3].content === 'Verified final result');
  check('H69 Compaction never forgets previously used tool ids', result.toolIds.includes('complete') && result.commands === 1 && result.compactions === 1 && result.rounds === 2);
  check('H70 A complete turn restores final status and summary without pending tools', result.status === 'complete' && result.summary === 'Fixture succeeded' && result.pending.length === 0 && !result.interrupted && !result.requiresReconciliation);
  const complete = journal.replay(session([event('history/replace', { messages: initial }), event('turn/end', { status: 'stopped', summary: 'User stopped' })]));
  check('H71 Existing paired history produces no synthetic results', complete.repairMessages.length === 0 && complete.history[3].content === initial[3].content && complete.status === 'stopped');
  const tail = journal.replay(session([event('history/replace', { messages: history }), event('turn/end', { status: 'complete', summary: 'Done' })], { interruptedTail: true }));
  check('H72 A partial native file tail remains explicitly interrupted', tail.interrupted && tail.status === 'interrupted' && !tail.requiresReconciliation);
}

for (const [label, value] of [
  ['unknown kind', session([event('arbitrary/script', {})])],
  ['non-contiguous sequence', session([event('session/start', {})], { events: [{ seq: 2, at: 1, kind: 'session/start', data: {} }] })],
  ['invalid message role', session([event('history/replace', { messages: [{ role: 'developer', content: 'invalid' }] })])],
  ['non-string tool output', session([event('tool/result', { message: { role: 'tool', toolCallId: 'one', content: {} } })])],
  ['negative counters', session([event('history/replace', { messages: history, commands: -1 })])],
  ['oversized snapshot', session([event('history/replace', { messages: Array.from({ length: 65 }, () => ({ role: 'user', content: 'fixture' })) })])],
  ['orphan tool result', session([event('history/replace', { messages: history }), event('tool/result', { message: tool('missing') })])],
  ['unmatched dispatch', session([event('tool/dispatch', { callId: 'missing' })])],
  ['tool result moved across a user message', session([event('history/replace', { messages: [...history, assistant(['one']), { role: 'user', content: 'intervening' }, tool('one')] })])],
  ['duplicate dispatch', session([event('assistant/message', { message: assistant(['one']) }), event('tool/dispatch', { callId: 'one' }), event('tool/dispatch', { callId: 'one' })])],
  ['unresolved tool removed by compaction', session([event('history/replace', { messages: [...history, assistant(['one'])] }), event('history/replace', { messages: history })])],
  ['changed repeated tool id', session([event('assistant/message', { message: assistant(['one']) }), event('tool/result', { message: tool('one') }), event('assistant/message', { message: assistant(['one', 'memory_search']) })])],
  ['malformed interrupted tail marker', session([], { interruptedTail: 'true' })],
]) throws('H73 Damaged records fail instead of silently dropping ' + label, () => bridge().journal().replay(value), /AI Harness/);

{
  const b = bridge(), journal = b.journal();
  await journal.create('constraints', {});
  await reject('H74 Unknown event kinds are rejected before native persistence', journal.append('unsafe/import', {}), /未知事件/);
  check('H75 Invalid append poisons the chain without contacting native', b.calls.length === 1);
  const invalid = bridge().journal();
  await reject('H76 Session ids reject path separators', invalid.create('../outside', {}), /会话编号/);
  const large = bridge().journal();
  await reject('H77 Metadata is bounded by UTF-8 bytes', large.create('large', { goal: '中'.repeat(30000) }), /大小超限/);
  const j = bridge().journal(); await j.create('event-limit', {});
  await reject('H78 A single event is bounded to 256 KiB', j.append('assistant/message', { message: { role: 'assistant', content: 'x'.repeat(256 * 1024) } }), /大小超限/);
}

{
  const malformed = bridge(command => command === 'harness_list' ? [{ id: 'bad-summary', metadata: {}, eventCount: -1, updatedAt: 1, interruptedTail: false }] : undefined);
  await reject('H79 List rejects corrupted native summary counters', malformed.journal().list(), /摘要无效/);
  const b = bridge(); b.records.set('restore', { ...session([event('session/start', {})]), id: 'restore' });
  const journal = b.journal(); await journal.read('restore'); await journal.append('turn/start', { goal: 'Resume fixture' });
  check('H80 Read resumes appending at the acknowledged existing sequence', journal.seq === 2 && b.calls.at(-1).args.expectedSeq === 1);
  const badRead = bridge(command => command === 'harness_read' ? session([], { id: 'wrong' }) : undefined).journal();
  await reject('H81 Read rejects a native record belonging to another session', badRead.read('expected'), /记录无效/);
}
{
  const result = bridge().journal().replay(session([event('history/replace', { messages: history }),
    event('assistant/message', { message: assistant(['memory', 'memory_search']) }), event('tool/dispatch', { callId: 'memory', name: 'memory_search' }),
    event('tool/result', { message: tool('memory') }), event('turn/end', { status: 'complete', summary: 'done' })]));
  check('H82 Memory dispatches do not inflate the executed-command counter', result.commands === 0 && result.toolIds[0] === 'memory');
}
{
  const runtime = createRuntime(), gate = deferred(), order = [];
  const later = { id: 'later', requires: ['base'], setup(ctx) { ctx.provide('later-service', 'original-setup'); } };
  const mounting = runtime.mountAll([{ id: 'base', setup: async ctx => { await gate.promise; ctx.provide('base-service', true); } }, later]);
  throws('H83 A pending async plugin setup blocks task acquisition', () => runtime.acquire(), /正在变更/);
  await reject('H84 Concurrent plugin graph mutations cannot overlap', runtime.mountAll([]), /运行中/);
  later.id = 'base'; later.requires.push('missing'); later.setup = () => order.push('mutated');
  gate.resolve(); await mounting;
  check('H85 Mount plans snapshot plugin ids, dependencies and setup functions', runtime.service('later-service') === 'original-setup' && !order.length && runtime.plugins()[1].id === 'later');
  await runtime.close();
}
{
  const runtime = createRuntime(), effects = [];
  await runtime.mountAll([{ id: 'error-hook', setup(ctx) { ctx.on('hook', async () => { await tick(); throw new Error('hook fixture'); }); ctx.on('hook', () => effects.push('must not run')); } }]);
  await reject('H86 A rejected hook prevents later hooks from observing a partial event', runtime.dispatch('hook'), /hook fixture/);
  await runtime.unmount('error-hook');
  check('H87 Failed dispatch releases its internal lease', !effects.length && runtime.plugins().length === 0);
  await runtime.close();
}
{
  const gate = deferred(); let first = true;
  const b = bridge((command, args, { records }) => {
    if (command === 'harness_append' && first) { first = false; return gate.promise.then(() => { const result = { seq: 1, kind: args.kind, data: copy(args.data), at: 1 }; records.get(args.id).events.push(result); return result; }); }
  });
  const journal = b.journal(), metadata = { goal: 'original' }, created = journal.create('capture', metadata); metadata.goal = 'mutated'; await created;
  check('H88 Create snapshots metadata before asynchronous scheduling', b.records.get('capture').metadata.goal === 'original');
  const a = journal.append('session/start', {}), data = { goal: 'original turn' }, c = journal.append('turn/start', data); data.goal = 'mutated turn';
  gate.resolve(); await Promise.all([a, c]);
  check('H89 Queued append snapshots payload before earlier I/O completes', b.records.get('capture').events[1].data.goal === 'original turn');
}
{
  const b = bridge(), journal = b.journal({ secrets: ['known-secret'] });
  b.records.set('restore-secret', { id: 'restore-secret', metadata: { api_key: 'old secret', goal: 'known-secret' },
    events: [{ seq: 1, at: 1, kind: 'turn/start', data: { goal: 'known-secret' } }], interruptedTail: false });
  const restored = await journal.read('restore-secret');
  check('H90 Read also scrubs old sensitive records before returning to callers', !('api_key' in restored.metadata) && restored.metadata.goal === '[REDACTED]' && restored.events[0].data.goal === '[REDACTED]');
  const direct = journal.replay(session([event('history/replace', { messages: [{ role: 'user', content: 'known-secret' }] })]));
  check('H91 Direct replay never exposes a configured secret', direct.history[0].content === '[REDACTED]');
}
{
  const secret = 'key"with\\backslash', b = bridge(), journal = b.journal({ secrets: [secret] });
  await journal.create('escaped-key', {});
  await journal.append('assistant/message', { message: assistant(['quoted', 'run_command', JSON.stringify({ command: 'printf ' + secret, purpose: 'fixture' })]) });
  const args = JSON.parse(b.calls.at(-1).args.data.message.toolCalls[0].arguments);
  check('H92 Escaped quotes and backslashes in a key are removed from JSON tool arguments', args.command === 'printf [REDACTED]' && args.purpose === 'fixture');
  const nested = JSON.stringify({ stdout: JSON.stringify({ stdout: secret, apiKey: 'drop this field', retained: 'safe' }), exitCode: 0 });
  await journal.append('tool/result', { message: tool('quoted', nested) });
  const result = JSON.parse(b.calls.at(-1).args.data.message.content), inner = JSON.parse(result.stdout);
  check('H93 JSON strings nested inside stdout are recursively scrubbed', inner.stdout === '[REDACTED]' && !('apiKey' in inner) && inner.retained === 'safe' && result.exitCode === 0);
  await journal.append('tool/result', { message: tool('quoted', 'plain output: ' + secret) });
  check('H94 Non-JSON output still uses literal key replacement', b.calls.at(-1).args.data.message.content === 'plain output: [REDACTED]');
}
for (const secret of ['a', 'command']) {
  const b = bridge(), journal = b.journal({ secrets: [secret] }); await journal.create('short-key', {});
  await journal.append('tool/result', { message: tool('tool-id', JSON.stringify({ command: 'printf ' + secret, data: { name: secret, api_key: 'remove' } })) });
  const result = JSON.parse(b.calls.at(-1).args.data.message.content);
  check('H95 A short key cannot corrupt JSON object field names: ' + secret, result.command === 'printf [REDACTED]' && result.data.name === '[REDACTED]' && !('api_key' in result.data));
}
{
  const b = bridge(), journal = b.journal();
  let inside = { value: 'finite' }; for (let i = 0; i < 20; i++) inside = { next: inside };
  await journal.create('depth-ok', { body: JSON.stringify(inside) });
  check('H96 Finite nested JSON within the cleaning budget remains usable', b.calls.length === 1 && JSON.parse(b.calls[0].args.metadata.body).next.next);
  const deep = bridge().journal({ secrets: ['escaped"key'] }); let nested = { value: 'escaped"key' }; for (let i = 0; i < 70; i++) nested = { next: nested };
  await reject('H97 Deep JSON strings stop instead of falling back to raw replacement', deep.create('depth-limit', { body: JSON.stringify(nested) }), /嵌套深度超限/);
  const direct = bridge().journal();
  await reject('H98 Deep objects are bounded before persistence', direct.create('object-depth', nested), /嵌套深度超限/);
  const invalid = bridge(), ordinary = invalid.journal({ secrets: ['known-secret'] }); await ordinary.create('ordinary-json', {});
  await ordinary.append('tool/result', { message: tool('tool-id', '{not valid JSON known-secret') });
  check('H99 Malformed JSON text receives ordinary literal replacement', invalid.calls.at(-1).args.data.message.content === '{not valid JSON [REDACTED]');
}
for (const secret of ['a', 'command']) {
  const b = bridge(), journal = b.journal({ secrets: [secret] });
  const meta = { goal: 'check ' + secret, target, model: 'standard-model' };
  await journal.create('session-command-a', meta);
  await journal.append('history/replace', { messages: history, rounds: 0, commands: 0, compactions: 0 });
  await journal.append('step/start', { round: 1, requestId: 'model-a-command', model: 'standard-model' });
  await journal.append('assistant/message', { message: assistant(['call-a-command', 'run_command', JSON.stringify({ command: 'printf ' + secret, purpose: 'check ' + secret })]) });
  await journal.append('tool/call', { callId: 'call-a-command', name: 'run_command' });
  await journal.append('tool/approval', { callId: 'call-a-command', accepted: true, kind: 'dangerous' });
  await journal.append('tool/dispatch', { callId: 'call-a-command', name: 'run_command', requestId: 'request-a-command', index: 1, command: 'printf ' + secret });
  await journal.append('tool/result', { message: tool('call-a-command', JSON.stringify({ stdout: JSON.stringify({ name: secret, a: secret }), exitCode: 0 })) });
  await journal.append('turn/end', { status: 'complete', summary: 'completed ' + secret });
  const restored = await b.journal({ secrets: [secret] }).read(journal.id), replay = journal.replay(restored);
  const call = replay.history.find(value => value.toolCalls)?.toolCalls[0], result = JSON.parse(replay.history.find(value => value.role === 'tool').content);
  check('H100 Complete sessions preserve protocol correlations with a short key: ' + secret,
    restored.id === 'session-command-a' && restored.metadata.target.identity === fingerprint && call.id === 'call-a-command' && call.name === 'run_command'
      && replay.status === 'complete' && replay.commands === 1 && replay.toolIds[0] === 'call-a-command');
  check('H101 Short keys clean tool data without globally protecting nested name fields: ' + secret,
    JSON.parse(call.arguments).command === 'printf [REDACTED]' && JSON.parse(result.stdout).name === '[REDACTED]' && JSON.parse(result.stdout).a === '[REDACTED]');
  const again = b.journal({ secrets: [secret] }).replay(restored);
  check('H102 Repeated read and replay scrubbing is idempotent: ' + secret, JSON.stringify(again) === JSON.stringify(replay));
}
{
  const secret = 'REDACTED', b = bridge(), journal = b.journal({ secrets: [secret] }); await journal.create('marker-idempotence', { goal: secret });
  await journal.append('history/replace', { messages: [{ role: 'user', content: secret + ' [REDACTED]' }] });
  const record = await b.journal({ secrets: [secret] }).read(journal.id), first = journal.replay(record), second = journal.replay(record);
  check('H103 A secret matching bytes in the marker does not expand markers on replay', first.history[0].content === '[REDACTED] [REDACTED]' && JSON.stringify(first) === JSON.stringify(second));
}
for (const secret of ['a', 'command']) {
  let round = 0;
  const proposed = { id: 'call-a-command', name: 'run_command', arguments: JSON.stringify({ command: 'printf data', purpose: 'check data' }) };
  const b = bridge(command => command === 'ai_agent_step' ? { content: ++round === 1 ? 'inspect data' : 'Task done', toolCalls: round === 1 ? [proposed] : [] }
    : command === 'agent_exec' ? { stdout: JSON.stringify({ name: secret }), stderr: '', exitCode: 0, durationMs: 1 } : undefined);
  const tab = { id: 'tab-a-command', ptyId: 'native-a-command', title: 'standard machine', _connectionGeneration: 1,
    _connectionIdentity: { protocol: 'ssh', host: 'machine.invalid', user: 'admin', port: 22 } };
  const T = { ...b.native, term: { tabs: { [tab.id]: tab }, ptyId: value => value.ptyId, isLive: value => value === tab }, listen: async () => () => {} };
  const context = { window: { WT: T }, TextEncoder, setInterval, clearInterval, setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  for (const file of ['ai-context.js', 'ai-agent.js']) vm.runInNewContext(readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), context);
  const result = await context.window.OpsAgent.run({ endpoint: 'https://fixture.invalid/v1', model: 'fixture', apiKey: secret, goal: 'check data', tab, confirmEachCommand: false });
  const modelCalls = b.calls.filter(call => call.command === 'ai_agent_step'), execCalls = b.calls.filter(call => call.command === 'agent_exec');
  const observed = modelCalls[1]?.args.request.messages, call = observed?.find(value => value.toolCalls)?.toolCalls[0];
  check('H104 Real controller completes with short configured keys: ' + secret, result.status === 'complete' && result.commands === 1 && execCalls.length === 1 && execCalls[0].args.request.command === 'printf data');
  check('H105 Controller observation retains valid tool schemas after scrubbing: ' + secret,
    modelCalls[0].args.request.messages[0].content.includes('run_command') && call?.name === 'run_command' && call.id === 'call-a-command' && typeof JSON.parse(call.arguments).command === 'string'
      && JSON.parse(JSON.parse(observed.find(value => value.role === 'tool').content).stdout).name === '[REDACTED]');
}
for (const secret of ['a', 'global']) {
  const b = bridge(), journal = b.journal({ secrets: [secret] }); await journal.create('memory-enums', {});
  await journal.append('assistant/message', { message: assistant(['memory-get', 'memory_get', JSON.stringify({ scope: 'global', path: 'MEMORY.md', note: { scope: secret } })]) });
  const args = JSON.parse(b.calls.at(-1).args.data.message.toolCalls[0].arguments);
  check('H106 Known memory tool scope enums survive short configured keys: ' + secret, args.scope === 'global' && args.path === 'MEMORY.md');
  check('H107 Arbitrary nested scope values are still data and are scrubbed: ' + secret, args.note.scope === '[REDACTED]');
}
{
  const b = bridge(), journal = b.journal({ secrets: ['a', 'command'] }); await journal.create('token-boundaries', { goal: 'standard run_command global a command' });
  check('H108 Short keys match independent tokens without damaging tool names or words', b.records.get('token-boundaries').metadata.goal === 'standard run_command global [REDACTED] [REDACTED]');
  await journal.append('tool/result', { message: tool('one', 'secret token a, a; command command_value value-command run_command') });
  check('H109 Short token matching respects identifier boundaries and repeated tokens', b.calls.at(-1).args.data.message.content === 'secret token [REDACTED], [REDACTED]; [REDACTED] command_value value-command run_command');
}
{
  const secret = 'a\\b', b = bridge(), journal = b.journal({ secrets: [secret] }); await journal.create('literal-regex', { goal: 'literal ' + secret + ' only' });
  check('H110 Short keys escape regular expression metacharacters literally', b.records.get('literal-regex').metadata.goal === 'literal [REDACTED] only');
  const long = bridge(), full = long.journal({ secrets: ['long-secret'] }); await full.create('long-substring', { goal: 'prefixlong-secretsuffix' });
  check('H111 Realistic long keys are still removed as substrings', long.records.get('long-substring').metadata.goal === 'prefix[REDACTED]suffix');
}
{
  let node = { value: 'finite' }; for (let i = 0; i < 62; i++) node = { next: node };
  const b = bridge(), journal = b.journal(); await journal.create('depth-edge-ok', { body: JSON.stringify(node) });
  check('H112 JSON cleaning accepts the finite edge of its 64-level budget', b.calls.length === 1);
  const tooDeep = bridge().journal(); await reject('H113 The next nested JSON level fails rather than bypassing the depth bound', tooDeep.create('depth-edge-fail', { body: JSON.stringify({ next: node }) }), /嵌套深度超限/);
}
for (const secret of ['a', 'global']) {
  let round = 0, actualScope;
  const proposed = { id: 'memory-call', name: 'memory_get', arguments: JSON.stringify({ path: 'MEMORY.md', scope: 'global' }) };
  const b = bridge(command => command === 'ai_agent_step' ? { content: ++round === 1 ? 'read memory' : 'verified memory', toolCalls: round === 1 ? [proposed] : [] } : undefined);
  const tab = { id: 'memory-tab', ptyId: 'memory-native', title: 'fixture', _connectionGeneration: 1,
    _connectionIdentity: { protocol: 'ssh', host: 'machine.invalid', user: 'ops', port: 22 } };
  const T = { ...b.native, term: { tabs: { [tab.id]: tab }, ptyId: value => value.ptyId, isLive: value => value === tab }, listen: async () => () => {} };
  const memory = { isEnabled: () => true, scopeFor: async () => 'machine-fixture', settings: () => ({ autoRecall: false }),
    get: async args => { actualScope = args.scope; return { path: args.path, scope: args.scope, content: 'fixture facts' }; } };
  const context = { window: { WT: T, AiMemory: memory }, TextEncoder, setInterval, clearInterval, setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  for (const file of ['ai-context.js', 'ai-agent.js']) vm.runInNewContext(readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), context);
  const result = await context.window.OpsAgent.run({ endpoint: 'https://fixture.invalid/v1', model: 'fixture', apiKey: secret, goal: 'read memory', tab, memoryEnabled: true, confirmEachCommand: false });
  const models = b.calls.filter(call => call.command === 'ai_agent_step'), argumentsText = models[1]?.args.request.messages.find(value => value.toolCalls)?.toolCalls[0].arguments;
  check('H114 Real memory controller uses the declared scope with short keys: ' + secret, result.status === 'complete' && result.memoryCalls === 1 && result.commands === 0 && actualScope === 'global');
  check('H115 Memory model observations retain a valid public scope enum: ' + secret, JSON.parse(argumentsText).scope === 'global' && models[0].args.request.messages[0].content.includes('run_command'));
}
console.log(`AI harness: ${checks.length} checks passed`);
