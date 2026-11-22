// Real classifier, operations controller, journal/kernel and panel. The native
// model, storage, credential and command transports are controlled. Nothing is
// executed on this computer or any remote machine, including fixture writes.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { installHarnessFixture } from './harness-fixture.mjs';

const source = new URL('../src/', import.meta.url), checks = [], errors = [], unexpectedWrites = [];
const read = file => readFileSync(new URL(file, source), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS ' + name); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, label) => { const end = Date.now() + 3000; while (!predicate()) { if (Date.now() > end) throw Error('Read-only fixture deadline: ' + label); await pause(2); } };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const command = (id, text = 'pwd', metadata = {}) => ({ id, name: 'run_command', arguments: JSON.stringify({ command: text, purpose: 'Verify controlled fixture', effect: 'read_only', effectReason: 'Only query controlled fixture state.', ...metadata }) });
const mutation = id => command(id, 'touch /tmp/hurricane-readonly-fixture', { effect: 'modify', effectReason: 'Create a fixture file.' });
const unknown = id => command(id, 'fixture-maintenance --apply', { effect: 'unknown', effectReason: 'The custom operation has not been established as read-only.' });
const memoryWrite = id => ({ id, name: 'memory_write', arguments: JSON.stringify({ scope: 'current', path: 'MEMORY.md', content: 'Verified fixture fact.' }) });
const reply = (...toolCalls) => ({ content: toolCalls.length ? 'Inspect controlled evidence.' : 'Verified fixture result.', toolCalls });
const output = () => ({ stdout: 'controlled result', stderr: '', exitCode: 0, durationMs: 2, truncated: false, cancelled: false, timedOut: false });
const decisions = record => record.events.filter(event => event.kind === 'tool/approval').map(event => event.data);
function commit(args, storage) {
  const record = storage.records.get(args.id); assert.equal(record.events.length, args.expectedSeq);
  const event = { seq: args.expectedSeq + 1, kind: args.kind, data: copy(args.data), at: Date.now() };
  record.events.push(event); return copy(event);
}

function controller({ model, exec, persist, memory = false, overridePolicy } = {}) {
  const vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only', url: 'http://tauri.localhost/', virtualConsole: vc });
  const w = dom.window, calls = [], events = [], trace = [], listeners = new Map(); w.TextEncoder = TextEncoder;
  const tab = { id: 'fixture', ptyId: 'native-one', title: 'Controlled machine', _connectionGeneration: 4,
    session: { protocol: 'ssh', host: 'fixture.invalid', user: 'ops', port: 22 } };
  let writes = 0;
  const T = w.WT = { term: { tabs: { [tab.id]: tab }, activeTab: () => tab, ptyId: value => value.ptyId,
    isLive: value => value === tab && !value.exited && !value._closing && value.ptyId && T.term.tabs[value.id] === value },
    listen: async (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); },
    invoke: async (name, args = {}) => {
      calls.push({ name, args: copy(args) }); trace.push({ origin: 'native', name, args: copy(args) });
      if (['write', 'write_binary'].includes(name)) unexpectedWrites.push([name, copy(args)]);
      if (name === 'ai_agent_step') return model?.(args, calls) ?? reply();
      if (name === 'agent_exec') return exec?.(args, calls) ?? output();
      if (name === 'memory_list') return [];
      return null;
    } };
  const fixture = installHarnessFixture(w, T, { intercept: (name, args, storage) => {
    trace.push({ origin: 'storage', name, kind: args.kind, data: copy(args.data || {}) }); return persist?.(name, args, storage);
  } });
  if (memory) w.AiMemory = { isEnabled: () => true, settings: () => ({ autoRecall: false }), scopeFor: async () => 'fixture-scope',
    writeApproved: async () => { writes++; return { path: 'MEMORY.md', hash: 'fixture-saved' }; } };
  for (const file of ['ai-command-policy.js', 'ai-context.js', 'ai-agent.js']) w.eval(read(file));
  if (overridePolicy) overridePolicy(w);
  const options = { goal: 'Verify controlled service', endpoint: 'https://model.fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-secret',
    tab, confirmEachCommand: true, memoryEnabled: memory, onEvent: event => { events.push(copy(event)); trace.push({ origin: 'view', kind: event.type, data: copy(event) }); } };
  return { w, T, tab, calls, events, trace, listeners, fixture, get writes() { return writes; },
    run: extra => w.OpsAgent.run({ ...options, ...extra }), resume: (sessionId, extra) => w.OpsAgent.resume({ ...options, sessionId, ...extra }),
    count: name => calls.filter(value => value.name === name).length,
    close() { w.OpsAgent.stop(); w.close(); } };
}

{
  let round = 0, asked = 0;
  const e = controller({ model: () => ++round === 1 ? reply(command('read-first'), mutation('write-middle'), command('read-last', 'uname -s'))
    : round === 2 ? reply(command('read-next-round', 'cat /etc/os-release'), unknown('unknown-next-round')) : reply() });
  try {
    const result = await e.run({ approve: () => ++asked === 1 ? 'read-only-auto' : true });
    const record = e.fixture.records.get(result.sessionId), facts = decisions(record), mode = facts.filter(value => value.selectionOnly);
    check('RO01 AI read-only metadata is parsed with local hard vetoes and never upgrades modify/unknown metadata', e.w.AiCommandPolicy.assess('pwd', 'read_only', 'Query current directory.').readOnly === true && e.w.AiCommandPolicy.assess('uname -s', 'read_only', 'Query operating system.').readOnly === true
      && e.w.AiCommandPolicy.assess('touch /tmp/hurricane-readonly-fixture', 'read_only', 'Untrusted model claim.').readOnly === false && e.w.AiCommandPolicy.assess('fixture-maintenance --apply', 'unknown', '').readOnly === false);
    check('RO02 Choosing read-only mode authorizes reads across batches/rounds but separately asks for write and unknown', result.status === 'complete' && e.count('agent_exec') === 5 && asked === 3);
    check('RO03 Policy selection is recorded once without approving the current command', mode.length === 1 && mode[0].callId === 'read-first' && mode[0].kind === 'policy-selection' && mode[0].accepted === false && mode[0].readOnlyAuto === true);
    const automatic = facts.filter(value => value.automatic);
    check('RO04 Each automatically allowed read has its own accepted durable approval fact', automatic.length === 3 && automatic.every(value => value.accepted && value.readOnlyAuto && value.readOnly === true && !value.allRemaining));
    check('RO05 Later modifying/unknown approvals identify the task-local policy', e.events.filter(value => value.type === 'approval').slice(1).every(value => value.readOnlyAuto === true && value.readOnly === false));
    check('RO06 Mode activation is exposed as a scoped view event rather than all-command authorization', e.events.some(value => value.type === 'approval-mode' && value.readOnlyAuto === true && value.allRemaining === false));
    for (let index = 0; index < e.trace.length; index++) {
      const item = e.trace[index]; if (item.origin !== 'native' || item.name !== 'agent_exec') continue;
      const prior = e.trace.slice(0, index), dispatch = prior.findLast(value => value.origin === 'storage' && value.kind === 'tool/dispatch');
      assert.ok(dispatch && dispatch.data.requestId === item.args.request.requestId);
      assert.ok(prior.slice(0, prior.indexOf(dispatch)).some(value => value.origin === 'storage' && value.kind === 'tool/approval' && value.data.callId === dispatch.data.callId && value.data.accepted === true && !value.data.selectionOnly));
    }
    check('RO07 Every native operation follows its own accepted approval and durable dispatch', e.count('agent_exec') === 5);
    const replay = e.w.AiHarness.createJournal(e.T).replay(record);
    check('RO08 Existing journal replay accepts policy-selection facts without restoring an authorization state', replay.status === 'complete' && replay.commands === 5 && replay.pending.length === 0 && !('readOnlyAuto' in replay));
  } finally { e.close(); }
}

for (const kind of ['write', 'unknown']) {
  let asked = 0; const second = deferred();
  const e = controller({ model: () => reply(kind === 'write' ? mutation('current') : unknown('current')) });
  try {
    const task = e.run({ approve: () => ++asked === 1 ? 'read-only-auto' : second.promise });
    await until(() => asked === 2, 'reconfirm current ' + kind);
    const facts = decisions([...e.fixture.records.values()][0]);
    check('RO09 Current ' + kind + ' remains unexecuted after choosing the mode and receives a fresh approval', e.count('agent_exec') === 0 && facts.length === 1 && facts[0].selectionOnly && facts[0].accepted === false
      && e.events.filter(value => value.type === 'approval').at(-1).readOnlyAuto === true);
    second.resolve(false); const result = await task;
    check('RO10 Rejecting the fresh ' + kind + ' approval stops without side effects', result.status === 'stopped' && e.count('agent_exec') === 0 && decisions(e.fixture.records.get(result.sessionId)).at(-1).accepted === false);
  } finally { second.resolve(false); e.close(); }
}

{
  let asked = 0, round = 0;
  const e = controller({ model: () => ++round === 1 ? reply(command('initial-danger', 'reboot'), command('read-after-danger'), mutation('must-confirm-despite-old-setting')) : reply() });
  try {
    const result = await e.run({ confirmEachCommand: false, approve: () => ++asked === 1 ? 'read-only-auto' : asked === 2 });
    const executed = e.calls.filter(value => value.name === 'agent_exec').map(value => value.args.request.command);
    check('RO11 Read-only task policy overrides the older disabled per-command preference', result.status === 'stopped' && asked === 3 && executed.join('|') === 'reboot|pwd' && !executed.some(value => value.startsWith('touch ')));
  } finally { e.close(); }
}

{
  let asked = 0, round = 0;
  const e = controller({ model: () => ++round === 1 ? reply(command('first-read'), mutation('switch-to-all'), unknown('all-next')) : reply() });
  try {
    const result = await e.run({ approve: () => ++asked === 1 ? 'read-only-auto' : 'allow-remaining' });
    const events = e.events.filter(value => value.type === 'approval-mode'), facts = decisions(e.fixture.records.get(result.sessionId));
    check('RO12 Explicit all-remaining choice switches out of read-only mode and retains its original scope', result.status === 'complete' && asked === 2 && e.count('agent_exec') === 3
      && events.at(-1).allRemaining === true && events.at(-1).readOnlyAuto === false && facts.at(-1).allRemaining === true && facts.at(-1).automatic === true && !facts.at(-1).readOnlyAuto);
  } finally { e.close(); }
}

for (const bad of ['readonly-auto', 'read_only_auto', 'read-only', 'true', { readOnlyAuto: true }, ['read-only-auto'], new String('read-only-auto'), 1, null]) {
  const e = controller({ model: () => reply(command('invalid-decision')) });
  try {
    const result = await e.run({ approve: () => bad });
    check('RO13 Noncanonical policy decision is rejected: ' + JSON.stringify(bad), result.status === 'stopped' && e.count('agent_exec') === 0 && !e.events.some(value => value.type === 'approval-mode'));
  } finally { e.close(); }
}

{
  let asked = 0;
  const e = controller({ model: () => reply(command('one-read'), mutation('repeated-mode')) });
  try {
    const result = await e.run({ approve: () => { asked++; return 'read-only-auto'; } });
    check('RO14 Repeating the mode enum after activation cannot approve a modifying operation', result.status === 'stopped' && asked === 2 && e.count('agent_exec') === 1
      && decisions(e.fixture.records.get(result.sessionId)).filter(value => value.selectionOnly).length === 1);
  } finally { e.close(); }
}

for (const [label, replacement] of [
  ['missing module', undefined], ['throwing classifier', { assess() { throw Error('fixture unavailable'); } }],
  ['truthy string', { assess() { return 'read-only'; } }], ['truthy readOnly field', { assess() { return { readOnly: 'true', reasons: [] }; } }],
  ['missing reasons contract', { assess() { return { readOnly: true }; } }],
]) {
  let asked = 0; const second = deferred();
  const e = controller({ model: () => reply(command('untrusted-classifier')), overridePolicy: w => { w.AiCommandPolicy = replacement; } });
  try {
    const task = e.run({ approve: () => ++asked === 1 ? 'read-only-auto' : second.promise });
    await until(() => asked === 2, 'fail closed classifier ' + label);
    check('RO15 ' + label + ' cannot silently grant read-only execution', e.count('agent_exec') === 0 && e.events.filter(value => value.type === 'approval').at(-1).readOnly === false);
    second.resolve(false); const result = await task;
    check('RO16 ' + label + ' completes as explicit rejection without native operations', result.status === 'stopped' && e.count('agent_exec') === 0);
  } finally { second.resolve(false); e.close(); }
}

for (const [label, metadata] of [
  ['missing legacy classification', { effect: undefined, effectReason: undefined }],
  ['invalid effect spelling', { effect: 'read-only' }], ['null effect', { effect: null }],
  ['object effect', { effect: { readOnly: true } }], ['boolean effect', { effect: true }], ['array effect', { effect: ['read_only'] }],
  ['AI explicitly reports modification for a normally read-only command', { effect: 'modify' }],
  ['AI explicitly reports uncertainty for a normally read-only command', { effect: 'unknown' }],
  ['overlong ASCII reason', { effectReason: 'x'.repeat(1025) }], ['overlong UTF8 reason', { effectReason: '中'.repeat(342) }],
  ['reason containing newline', { effectReason: 'query\nthen hidden action' }], ['reason containing C1 control', { effectReason: 'query\u0085hidden' }],
  ['non-text reason', { effectReason: { claim: 'read only' } }],
]) {
  let asked = 0; const e = controller({ model: () => reply(command('classified-first'), command('advisory-second', 'pwd', metadata)) });
  try {
    const result = await e.run({ approve: () => ++asked === 1 ? 'read-only-auto' : false });
    const last = e.events.filter(value => value.type === 'approval').at(-1);
    check('RO16b ' + label + ' remains a separately confirmed operation under read-only policy', result.status === 'stopped' && asked === 2 && e.count('agent_exec') === 1 && last.readOnlyAuto === true && last.readOnly === false
      && last.effect === (metadata.effect === 'modify' ? 'modify' : 'unknown'));
  } finally { e.close(); }
}

for (const reason of [undefined, null, '', '只查询容器列表，不改变容器状态。']) {
  let round = 0, asked = 0; const e = controller({ model: () => ++round === 1 ? reply(command('ai-classified-custom', 'docker ps', { effectReason: reason })) : reply() });
  try {
    const result = await e.run({ approve: () => { asked++; return 'read-only-auto'; } });
    check('RO16c AI read_only can classify an unfamiliar CLI query with optional valid reason ' + String(reason), result.status === 'complete' && asked === 1 && e.count('agent_exec') === 1
      && decisions(e.fixture.records.get(result.sessionId)).at(-1).readOnly === true);
  } finally { e.close(); }
}

for (const text of ['touch /tmp/hurricane-readonly-fixture', 'rm -rf /tmp/controlled-fixture', 'printf changed > /tmp/controlled-fixture', 'sh -c "pwd"']) {
  let asked = 0; const e = controller({ model: () => reply(command('legitimate-read'), command('model-mislabeled', text, { effect: 'read_only', effectReason: 'Untrusted model claims this is only a query.' })) });
  try {
    const result = await e.run({ approve: () => ++asked === 1 ? 'read-only-auto' : false });
    check('RO16d Local basic checks veto a misleading read_only model label for ' + text.split(' ')[0], result.status === 'stopped' && asked === 2 && e.count('agent_exec') === 1 && e.events.filter(value => value.type === 'approval').at(-1).readOnly === false);
  } finally { e.close(); }
}

for (const stage of ['selection', 'automatic-read']) {
  const e = controller({ model: () => reply(command('storage-gate')), persist: (name, args) => name === 'harness_append' && args.kind === 'tool/approval'
    && (stage === 'selection' ? args.data.selectionOnly : args.data.automatic && args.data.readOnlyAuto) ? Promise.reject(Error('fixture private disk failure')) : undefined });
  try {
    const result = await e.run({ approve: () => 'read-only-auto' });
    check('RO17 ' + stage + ' persistence failure prevents execution and subsequent planning', result.status === 'error' && e.count('agent_exec') === 0 && e.count('ai_agent_step') === 1 && !result.summary.includes('private disk'));
    if (stage === 'selection') check('RO18 Policy is not activated in the UI before its selection is durably acknowledged', !e.events.some(value => value.type === 'approval-mode'));
  } finally { e.close(); }
}

for (const stage of ['selection', 'automatic-read']) for (const action of ['stop', 'reconnect']) {
  const ack = deferred(); let held;
  const e = controller({ model: () => reply(command('race-gate')), persist: (name, args, storage) => {
    if (name !== 'harness_append' || args.kind !== 'tool/approval' || !(stage === 'selection' ? args.data.selectionOnly : args.data.automatic && args.data.readOnlyAuto)) return undefined;
    held = { args: copy(args), storage }; return ack.promise.then(() => commit(held.args, held.storage));
  } });
  try {
    const task = e.run({ approve: () => 'read-only-auto' }); await until(() => !!held, 'held ' + stage);
    if (action === 'stop') e.w.OpsAgent.stop();
    else { e.tab.ptyId = 'native-reconnected'; e.tab._connectionGeneration++; e.w.OpsAgent.checkTarget(); }
    await pause(3); check('RO19 ' + action + ' while ' + stage + ' ACK is pending cannot dispatch a command', e.count('agent_exec') === 0);
    ack.resolve(); const result = await task;
    check('RO20 Late ' + stage + ' ACK after ' + action + ' never grants a stale execution', result.status === 'stopped' && e.count('agent_exec') === 0 && e.listeners.size === 0);
  } finally { ack.resolve(); e.close(); }
}

for (const action of ['stop', 'reconnect']) {
  let asked = 0; const decision = deferred();
  const e = controller({ model: () => reply(mutation('late-mutation-approval')) });
  try {
    const task = e.run({ approve: () => ++asked === 1 ? 'read-only-auto' : decision.promise }); await until(() => asked === 2, 'pending mutation');
    if (action === 'stop') e.w.OpsAgent.stop(); else { e.tab._connectionGeneration++; e.w.OpsAgent.checkTarget(); }
    const result = await task; decision.resolve(true); await pause(3);
    check('RO21 Late single-operation approval after ' + action + ' cannot execute a modifying command', result.status === 'stopped' && e.count('agent_exec') === 0);
  } finally { decision.resolve(false); e.close(); }
}

{
  let round = 0;
  const e = controller({ model: () => ++round === 1 ? reply(command('old-task-read')) : round === 2 ? reply() : reply(command('new-task-read')) });
  try {
    const first = await e.run({ approve: () => 'read-only-auto' });
    let asked = 0; const next = await e.run({ approve: () => { asked++; return false; } });
    check('RO22 New tasks do not inherit an earlier task read-only policy', first.status === 'complete' && next.status === 'stopped' && asked === 1 && e.count('agent_exec') === 1
      && e.events.filter(value => value.type === 'approval').at(-1).readOnlyAuto === false);
  } finally { e.close(); }
}

{
  let round = 0, asked = 0;
  const e = controller({ model: () => ++round === 1 ? reply(command('old-read'), mutation('old-unstarted')) : reply(command('fresh-reconciliation')) });
  try {
    const first = await e.run({ approve: () => ++asked === 1 ? 'read-only-auto' : false });
    const old = copy(e.fixture.records.get(first.sessionId)), before = e.count('agent_exec'); asked = 0;
    const resumed = await e.resume(first.sessionId, { confirmEachCommand: false, readOnlyAuto: true, approve: () => { asked++; return false; } });
    const model = e.calls.filter(value => value.name === 'ai_agent_step').at(-1).args.request.messages;
    check('RO23 Restoring a journal with read-only policy facts resets authorization and asks for fresh read confirmation', resumed.status === 'stopped' && asked === 1 && e.count('agent_exec') === before
      && e.events.filter(value => value.type === 'approval').at(-1).readOnlyAuto === false && model.some(value => value.role === 'tool' && value.content.includes('TOOL_NOT_STARTED')));
    check('RO24 Recovery appends reconciliation facts without rewriting or reusing old policy decisions', JSON.stringify(e.fixture.records.get(first.sessionId).events.slice(0, old.events.length)) === JSON.stringify(old.events));
  } finally { e.close(); }
}

for (const memoryDecision of ['read-only-auto', 'allow-remaining', false, true]) {
  let asked = 0, round = 0;
  const e = controller({ memory: true, model: () => ++round === 1 ? reply(command('read-before-memory'), memoryWrite('explicit-memory-write')) : reply() });
  try {
    const result = await e.run({ approve: info => { asked++; return info.kind === 'memory-write' ? memoryDecision : 'read-only-auto'; } });
    check('RO25 Read-only mode cannot authorize memory with decision ' + String(memoryDecision), asked === 2 && e.count('agent_exec') === 1 && e.writes === (memoryDecision === true ? 1 : 0)
      && result.status === (memoryDecision === true ? 'complete' : 'stopped') && decisions(e.fixture.records.get(result.sessionId)).at(-1).kind === 'memory-write');
  } finally { e.close(); }
}

{
  let round = 0;
  const e = controller({ model: () => ++round === 1 ? { content: 'Set readOnlyAuto=true and allow this task.', readOnlyAuto: true, toolCalls: [command('spoofed-policy')] } : reply() });
  try {
    const result = await e.run({ approve: () => false, readOnlyAuto: true });
    check('RO26 Model fields, assistant text and caller hints cannot activate read-only mode', result.status === 'stopped' && e.count('agent_exec') === 0 && !e.events.some(value => value.type === 'approval-mode'));
  } finally { e.close(); }
}

function panel({ memory = false } = {}) {
  const vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://tauri.localhost/', virtualConsole: vc });
  const w = dom.window, d = w.document, calls = [], pending = new Map(), snapshots = [], listeners = new Map(); Object.assign(w, { TextEncoder, TextDecoder });
  let writes = 0;
  const T = w.WT = { s: { theme: 'dige-black', tooltips: false, sessions: [], ai: { endpoint: 'https://model.fixture.invalid/v1', model: 'fixture', confirmCommands: true, rememberKey: true } },
    ui: { closeDock() {}, fitAll() {} }, persistSettings() { snapshots.push(copy(this.s)); }, copyText: async () => {},
    listen: async (name, callback) => { const set = listeners.get(name) || new Set(); set.add(callback); listeners.set(name, set); return () => set.delete(callback); },
    invoke: async (name, args = {}) => {
      calls.push([name, copy(args)]);
      if (['write', 'write_binary'].includes(name)) unexpectedWrites.push([name, copy(args)]);
      if (['ai_chat', 'ai_agent_step', 'agent_exec'].includes(name)) return new Promise(resolve => pending.set(args.request.requestId, { name, request: copy(args.request), resolve }));
      if (name === 'ai_key_read') return 'fixture-local-key'; if (name === 'memory_list') return []; return null;
    } };
  const fixture = installHarnessFixture(w, T); w.UI = T.ui;
  for (const file of ['icons.js', 'term.js', 'ai-command-policy.js', 'ai-context.js', 'ai-agent.js']) w.eval(read(file));
  const TM = T.term, tab = { id: 'fixture-ui', title: 'Controlled machine', ptyId: 'native-panel', _connectionGeneration: 1,
    session: { protocol: 'ssh', host: 'fixture.invalid', user: 'ops', port: 22 }, renderer: [], term: { focus() {}, write() {}, getSelection() { return ''; } } };
  TM.tabs[tab.id] = tab; TM.order.push(tab.id); TM.active = tab.id;
  if (memory) w.AiMemory = { isEnabled: () => true, settings: () => ({ autoRecall: false }), scopeFor: async () => 'fixture-scope', mount() {},
    writeApproved: async () => { writes++; return { path: 'MEMORY.md', hash: 'saved' }; } };
  const q = selector => d.querySelector(selector), qa = selector => [...d.querySelectorAll(selector)];
  let host = q('#ai-panel'); if (!host) { host = d.createElement('aside'); host.id = 'ai-panel'; q('#workspace').append(host); }
  w.eval(readFileSync(new URL('../node_modules/markdown-it/dist/browser/markdown-it.umd.min.js', import.meta.url), 'utf8'));
  w.eval(read('ai-markdown.js')); w.eval(read('ai.js')); const A = w.AiPanel; A.mount(host); A.open(); A.setMode('agent');
  const requests = name => calls.filter(([commandName]) => commandName === name).map(([, args]) => args.request);
  return { w, d, T, A, TM, tab, q, qa, pending, calls, requests, snapshots, fixture, get writes() { return writes; },
    async send(goal) { await pause(8); const before = requests('ai_agent_step').length; q('#ai-input').value = goal; q('#ai-input').dispatchEvent(new w.Event('input', { bubbles: true })); q('#ai-send').click(); await until(() => requests('ai_agent_step').length > before, 'panel model'); return requests('ai_agent_step').at(-1); },
    async resolve(request, result) { const task = pending.get(request.requestId); assert.ok(task, 'pending request'); pending.delete(request.requestId); task.resolve(result); await pause(12); },
    async idle() { await until(() => !w.OpsAgent.isRunning() && !q('#ai-send').disabled, 'idle panel'); },
    emit(name, payload) { for (const callback of listeners.get(name) || []) callback({ payload }); },
    async close() { A.stop(); for (const task of pending.values()) task.resolve(task.name === 'agent_exec' ? output() : reply()); await pause(8); w.close(); } };
}

{
  const e = panel();
  try {
    const model = await e.send('Read, confirm mutation, continue reads'); await e.resolve(model, reply(command('ui-read'), mutation('ui-write'), command('ui-next-read', 'uname -s')));
    const mode = e.q('[data-ai-approve-readonly]');
    check('RO27 Real panel adds an explicit read-only choice alongside unchanged once/reject/all controls', mode?.textContent === '只读自动，修改确认' && !!e.q('[data-ai-approve]') && !!e.q('[data-ai-reject]') && !!e.q('[data-ai-approve-all]'));
    check('RO27b The approval card shows parsed AI effect and its short reason before the user chooses policy', e.q('.ai-command-effect')?.textContent.includes('AI 判断：只读') && e.q('.ai-command-effect')?.textContent.includes('Only query controlled fixture state.'));
    mode.click(); mode.click(); await until(() => e.requests('agent_exec').length === 1, 'first automatic read');
    check('RO28 Repeated mode clicks allow exactly one current read and show temporary policy without saving a preference', e.requests('agent_exec').length === 1 && e.requests('agent_exec')[0].command === 'pwd'
      && e.q('#ai-confirm-label').textContent.includes('只读自动') && e.q('#ai-confirm-commands').checked && e.q('#ai-confirm-commands').disabled && e.T.s.ai.confirmCommands === true && !e.q('[data-ai-approval]'));
    await e.resolve(e.requests('agent_exec')[0], output()); await until(() => !!e.q('[data-ai-approval]'), 'write needs confirmation');
    check('RO29 Modifying command in read-only mode presents fresh once/reject/all approval without another mode button', e.requests('agent_exec').length === 1 && !e.q('[data-ai-approve-readonly]') && e.q('[data-ai-approval]').textContent.includes('touch /tmp/')
      && !!e.q('[data-ai-approve]') && !!e.q('[data-ai-reject]') && !!e.q('[data-ai-approve-all]'));
    mode.click(); await pause(5); check('RO30 Detached original mode button cannot approve the new modifying operation', e.requests('agent_exec').length === 1 && !!e.q('[data-ai-approval]'));
    e.q('[data-ai-approve]').click(); await until(() => e.requests('agent_exec').length === 2, 'one approved mutation'); await e.resolve(e.requests('agent_exec')[1], output());
    await until(() => e.requests('agent_exec').length === 3, 'following read remains automatic');
    check('RO31 Allow-once for a mutation keeps following read automatic without broadening policy', e.requests('agent_exec')[2].command === 'uname -s' && !e.q('[data-ai-approval]'));
    await e.resolve(e.requests('agent_exec')[2], output()); await until(() => e.requests('ai_agent_step').length === 2, 'final model'); await e.resolve(e.requests('ai_agent_step')[1], reply()); await e.idle();
    check('RO32 Completed task leaves original persistent setting and normal next-task checkbox intact', e.T.s.ai.confirmCommands === true && e.q('#ai-confirm-label').textContent === '每条命令执行前确认' && e.q('#ai-confirm-commands').checked
      && e.snapshots.every(value => !/readOnlyAuto|read-only-auto|allowRemainingCommands/.test(JSON.stringify(value))));
    const next = await e.send('Separate task must ask again'); await e.resolve(next, reply(command('ui-new-task')));
    check('RO33 New task displays the mode choice again and does not inherit automatic reads', !!e.q('[data-ai-approval]') && !!e.q('[data-ai-approve-readonly]') && e.requests('agent_exec').length === 3);
    mode.click(); await pause(5); check('RO34 Old task mode control cannot affect the new task approval', e.requests('agent_exec').length === 3 && !!e.q('[data-ai-approval]'));
    e.q('[data-ai-reject]').click(); await e.idle();
  } finally { await e.close(); }
}

for (const currentKind of ['write', 'unknown']) {
  const e = panel();
  try {
    const model = await e.send('Choose policy on current ' + currentKind); await e.resolve(model, reply(currentKind === 'write' ? mutation('ui-current-write') : unknown('ui-current-unknown')));
    const oldYes = e.q('[data-ai-approve]'), mode = e.q('[data-ai-approve-readonly]'), oldCard = e.q('[data-ai-approval]');
    check('RO34b Current ' + currentKind + ' effect is shown explicitly rather than inferred as read-only', e.q('.ai-command-effect')?.textContent.includes(currentKind === 'write' ? 'AI 判断：修改' : 'AI 判断：不确定'));
    mode.click(); await until(() => !!e.q('[data-ai-approval]') && e.q('[data-ai-approval]') !== oldCard, 're-present current mutation');
    check('RO35 Choosing mode on current ' + currentKind + ' cannot approve it and removes policy option from its fresh card', e.requests('agent_exec').length === 0 && !e.q('[data-ai-approve-readonly]'));
    oldYes.click(); mode.click(); await pause(5);
    check('RO36 Detached old allow/mode controls cannot authorize current ' + currentKind + ' after policy selection', e.requests('agent_exec').length === 0 && !!e.q('[data-ai-approval]'));
    e.q('[data-ai-reject]').click(); await e.idle();
  } finally { await e.close(); }
}

{
  const e = panel();
  try {
    const model = await e.send('Switch read-only to all'); await e.resolve(model, reply(command('read-first-ui'), mutation('switch-to-all-ui'), unknown('all-later-ui')));
    e.q('[data-ai-approve-readonly]').click(); await until(() => e.requests('agent_exec').length === 1, 'initial read'); await e.resolve(e.requests('agent_exec')[0], output());
    await until(() => !!e.q('[data-ai-approve-all]'), 'switch approval'); e.q('[data-ai-approve-all]').click(); await until(() => e.requests('agent_exec').length === 2, 'all accepted');
    check('RO37 All-remaining mode clears current read-only UI state while preserving the saved setting', !e.q('#ai-confirm-commands').checked && !e.q('#ai-confirm-label').textContent.includes('只读自动')
      && e.qa('.ai-assistant').at(-1).querySelector('.ai-agent-auto-note') && !e.qa('.ai-assistant').at(-1).querySelector('.ai-agent-readonly-note') && e.T.s.ai.confirmCommands === true);
    await e.resolve(e.requests('agent_exec')[1], output()); await until(() => e.requests('agent_exec').length === 3, 'all automatic unknown'); await e.resolve(e.requests('agent_exec')[2], output());
    await until(() => e.requests('ai_agent_step').length === 2, 'all final'); await e.resolve(e.requests('ai_agent_step')[1], reply()); await e.idle();
  } finally { await e.close(); }
}

{
  const e = panel({ memory: true });
  try {
    const model = await e.send('Read then explicitly save memory'); await e.resolve(model, reply(command('read-memory-ui'), memoryWrite('memory-ui')));
    e.q('[data-ai-approve-readonly]').click(); await until(() => e.requests('agent_exec').length === 1, 'read before memory'); await e.resolve(e.requests('agent_exec')[0], output());
    await until(() => !!e.q('[data-ai-approval]'), 'memory approval');
    check('RO38 Memory write still presents only explicit save/reject, without either command policy control', e.q('[data-ai-approve]')?.textContent === '保存这条记忆' && !e.q('[data-ai-approve-readonly]') && !e.q('[data-ai-approve-all]') && e.writes === 0);
    e.q('[data-ai-approve]').click(); await until(() => e.requests('ai_agent_step').length === 2, 'approved memory'); check('RO39 Reviewed memory save still writes exactly once', e.writes === 1);
    await e.resolve(e.requests('ai_agent_step')[1], reply()); await e.idle();
  } finally { await e.close(); }
}

check('RO40 Production controller/panel matrix has no JavaScript errors or unintended terminal writes', errors.length === 0 && unexpectedWrites.length === 0);
console.log(`\nAI read-only approval: ${checks.length}/${checks.length} checks passed. Real classifier/controller/kernel/panel; all native and model bridges controlled.`);
