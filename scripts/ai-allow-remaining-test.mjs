// Real operations controller/kernel and panel. Native storage/model/execution
// transports are controlled; this suite never runs a machine command or network request.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { installHarnessFixture } from './harness-fixture.mjs';

const source = new URL('../src/', import.meta.url), checks = [], errors = [];
const read = file => readFileSync(new URL(file, source), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const check = (label, condition) => { assert.ok(condition, label); checks.push(label); console.log('PASS ' + label); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, label) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Timed out: ' + label); await pause(3); }
};
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const command = (id, text = 'printf fixture') => ({ id, name: 'run_command', arguments: JSON.stringify({ command: text, purpose: 'Verify fixture state' }) });
const memoryWrite = id => ({ id, name: 'memory_write', arguments: JSON.stringify({ scope: 'current', path: 'MEMORY.md', content: 'Verified fixture fact.' }) });
const reply = (...toolCalls) => ({ content: toolCalls.length ? 'Inspect fixture state.' : 'Verified fixture task.', toolCalls });
const output = () => ({ stdout: 'verified', stderr: '', exitCode: 0, durationMs: 1, timedOut: false, cancelled: false, truncated: false });
const approvals = record => record.events.filter(event => event.kind === 'tool/approval').map(event => event.data);

function controller({ model, exec, persist, memory = false } = {}) {
  const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only', url: 'http://tauri.localhost/' });
  const w = dom.window, calls = [], events = [], trace = [];
  w.TextEncoder = TextEncoder;
  const tab = { id: 'fixture', title: 'Fixture target', ptyId: 'native-first', _connectionGeneration: 1,
    session: { protocol: 'ssh', host: 'fixture.invalid', user: 'ops', port: 22 } };
  let writes = 0;
  const T = w.WT = {
    term: { tabs: { [tab.id]: tab }, ptyId: value => value.ptyId, isLive: value => value === tab && !value.exited, activeTab: () => tab },
    listen: async () => () => {},
    invoke: async (name, args = {}) => {
      calls.push({ name, args: copy(args) }); trace.push(name);
      if (name === 'ai_agent_step') return model?.(args, calls) ?? reply();
      if (name === 'agent_exec') return exec?.(args, calls) ?? output();
      if (name === 'memory_list') return [];
      return null;
    },
  };
  if (memory) w.AiMemory = {
    isEnabled: () => true, settings: () => ({ autoRecall: false }), scopeFor: async () => 'fixture-scope',
    writeApproved: async () => { writes++; return { path: 'MEMORY.md', hash: 'saved' }; },
  };
  const fixture = installHarnessFixture(w, T, { intercept: (name, args, storage) => { trace.push(args.kind || name); return persist?.(name, args, storage); } });
  for (const file of ['ai-context.js', 'ai-agent.js']) w.eval(read(file));
  const options = { goal: 'Verify fixture service', endpoint: 'https://model.fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-key',
    tab, confirmEachCommand: true, memoryEnabled: memory, onEvent: event => events.push(event) };
  return {
    w, T, tab, fixture, calls, events, trace, get writes() { return writes; },
    run: extra => w.OpsAgent.run({ ...options, ...extra }),
    resume: (id, extra) => w.OpsAgent.resume({ ...options, sessionId: id, ...extra }),
    count: name => calls.filter(call => call.name === name).length,
    close() { w.OpsAgent.stop(); w.close(); },
  };
}

{
  let round = 0, asked = 0;
  const e = controller({ model: () => ++round === 1 ? reply(command('batch-one'), command('batch-two', 'pwd'))
    : round === 2 ? reply(command('next-round-danger', 'reboot')) : reply() });
  try {
    const result = await e.run({ approve: () => { asked++; return 'allow-remaining'; } }), record = e.fixture.records.get(result.sessionId), decisions = approvals(record);
    check('AR01 Exact all-remaining decision permits every command in the current batch', result.status === 'complete' && e.count('agent_exec') === 3 && asked === 1);
    check('AR02 Task authorization continues into later model rounds including recognized high-impact commands', e.calls.filter(call => call.name === 'agent_exec').at(-1).args.request.command === 'reboot' && e.events.filter(event => event.type === 'approval').length === 1);
    check('AR03 Initial authorization is durably recorded with its current-task scope', decisions[0].accepted === true && decisions[0].allRemaining === true && !decisions[0].automatic);
    check('AR04 Each later automatic command has a separate durable approval fact', decisions.length === 3 && decisions.slice(1).every(value => value.accepted === true && value.allRemaining === true && value.automatic === true) && decisions[2].kind === 'dangerous');
    const executed = e.trace.reduce((count, item, i) => {
      if (item !== 'agent_exec') return count;
      const previous = e.trace.slice(0, i), approval = previous.lastIndexOf('tool/approval'), dispatch = previous.lastIndexOf('tool/dispatch');
      assert.ok(approval >= 0 && approval < dispatch, 'durable approval before dispatch'); return count + 1;
    }, 0);
    check('AR05 Every explicit or automatic decision is committed before native dispatch', executed === 3);
  } finally { e.close(); }
}

for (const decision of ['true', 'all', 'allow_remaining', { allRemaining: true }, ['allow-remaining'], new String('allow-remaining'), 1, null]) {
  const e = controller({ model: () => reply(command('invalid-decision')) });
  try {
    const result = await e.run({ approve: () => decision });
    check('AR06 Rejects noncanonical truthy approval value ' + JSON.stringify(decision), result.status === 'stopped' && e.count('agent_exec') === 0 && approvals(e.fixture.records.get(result.sessionId))[0].accepted === false);
  } finally { e.close(); }
}

{
  let asked = 0;
  const e = controller({ model: () => reply(command('once-only'), command('still-needs-approval')) });
  try {
    const result = await e.run({ approve: () => ++asked === 1 });
    check('AR07 Original boolean true permits one command and rejection stops the next', result.status === 'stopped' && asked === 2 && e.count('agent_exec') === 1);
    const decisions = approvals(e.fixture.records.get(result.sessionId));
    check('AR08 Single-command and rejected decisions never enable remaining-task authorization', decisions.length === 2 && decisions[0].accepted && !decisions[0].allRemaining && !decisions[1].accepted);
  } finally { e.close(); }
}

for (const automatic of [false, true]) {
  let asked = 0;
  const e = controller({ model: () => reply(command('storage-one'), command('storage-two')),
    persist: (name, args) => name === 'harness_append' && args.kind === 'tool/approval'
      && (automatic ? args.data.automatic === true : args.data.allRemaining === true) ? Promise.reject(Error('fixture disk unavailable')) : undefined });
  try {
    const result = await e.run({ approve: () => { asked++; return 'allow-remaining'; } });
    check('AR09 ' + (automatic ? 'Automatic' : 'Initial') + ' approval persistence failure blocks its native operation', result.status === 'error' && e.count('agent_exec') === (automatic ? 1 : 0) && asked === 1);
    check('AR10 Failed durable authorization stops further planning without leaking raw storage errors ' + automatic, e.count('ai_agent_step') === 1 && !result.summary.includes('fixture disk') && !e.w.OpsAgent.isRunning());
  } finally { e.close(); }
}

for (const action of ['stop', 'reconnect']) {
  const gate = deferred(), e = controller({ model: () => reply(command('late-grant')) });
  try {
    const running = e.run({ approve: () => gate.promise }); await until(() => e.events.some(event => event.type === 'approval'), 'pending approval');
    if (action === 'stop') e.w.OpsAgent.stop();
    else { e.tab.ptyId = 'native-reconnected'; e.tab._connectionGeneration++; e.w.OpsAgent.checkTarget(); }
    const result = await running; gate.resolve('allow-remaining'); await pause(10);
    check('AR11 Late all-remaining decision after ' + action + ' cannot execute or grant authorization', result.status === 'stopped' && e.count('agent_exec') === 0 && approvals(e.fixture.records.get(result.sessionId)).length === 0);
  } finally { e.close(); }
}

for (const automatic of [false, true]) {
  const gate = deferred(); let held;
  const e = controller({ model: () => reply(command('ack-one'), command('ack-two')),
    persist: (name, args, storage) => {
      if (name !== 'harness_append' || args.kind !== 'tool/approval' || (args.data.automatic === true) !== automatic) return;
      held = () => {
        const record = storage.records.get(args.id), event = { seq: args.expectedSeq + 1, kind: args.kind, data: copy(args.data), at: Date.now() };
        assert.equal(record.events.length, args.expectedSeq); record.events.push(event); gate.resolve(copy(event));
      };
      return gate.promise;
    },
  });
  try {
    const running = e.run({ approve: () => 'allow-remaining' }); await until(() => !!held, 'durable authorization acknowledgement');
    e.w.OpsAgent.stop(); held(); const result = await running;
    check('AR11b Stop during ' + (automatic ? 'automatic' : 'initial') + ' durable approval prevents dispatch after late acknowledgement', result.status === 'stopped' && e.count('agent_exec') === (automatic ? 1 : 0));
  } finally { e.close(); }
}

{
  let round = 0;
  const e = controller({ model: () => ++round % 2 ? reply(command('task-' + round)) : reply() });
  try {
    const first = await e.run({ approve: () => 'allow-remaining' });
    const second = await e.run({ approve: () => false });
    check('AR12 Completed task authorization cannot transfer into a newly created task', first.status === 'complete' && second.status === 'stopped' && first.sessionId !== second.sessionId && e.count('agent_exec') === 1);
  } finally { e.close(); }
}

{
  let round = 0;
  const execution = deferred(), e = controller({ model: () => reply(command('resume-' + ++round)), exec: () => execution.promise });
  try {
    const running = e.run({ approve: () => 'allow-remaining' }); await until(() => e.count('agent_exec') === 1, 'first execution');
    e.w.OpsAgent.stop(); const first = await running;
    const resumed = await e.resume(first.sessionId, { confirmEachCommand: false, approve: () => false });
    check('AR13 Restored task ignores old all-remaining approval and asks again', resumed.status === 'stopped' && e.count('agent_exec') === 1 && e.events.filter(event => event.type === 'approval').length === 2);
    check('AR14 Recovery never automatically replays the interrupted native command', e.calls.filter(call => call.name === 'ai_agent_step').at(-1).args.request.messages.some(message => message.role === 'tool' && message.content.includes('TOOL_OUTCOME_UNKNOWN')));
    execution.resolve(output());
  } finally { e.close(); }
}

{
  const e = controller({ memory: true, model: () => reply(command('before-memory'), memoryWrite('explicit-memory')) });
  try {
    const result = await e.run({ approve: () => 'allow-remaining' }), decisions = approvals(e.fixture.records.get(result.sessionId));
    check('AR15 Command auto-authorization never approves a memory write', result.status === 'stopped' && e.count('agent_exec') === 1 && e.writes === 0 && decisions.at(-1).kind === 'memory-write' && decisions.at(-1).accepted === false);
  } finally { e.close(); }
}

function panel({ memory = false } = {}) {
  const vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://tauri.localhost/', virtualConsole: vc });
  const w = dom.window, d = w.document, calls = [], pending = new Map(), snapshots = [], listeners = new Map();
  Object.assign(w, { TextEncoder, TextDecoder });
  let writes = 0;
  const T = w.WT = { s: { theme: 'dige-black', tooltips: false, ai: { endpoint: 'https://model.fixture.invalid/v1', model: 'fixture', width: 380, rememberKey: true, confirmCommands: true } },
    ui: { fitAll() {}, closeDock() {} }, persistSettings() { snapshots.push(copy(this.s)); },
    listen: async (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); },
    invoke: async (name, args = {}) => {
      calls.push([name, copy(args)]);
      if (['ai_chat', 'ai_agent_step', 'agent_exec'].includes(name)) return new Promise(resolve => pending.set(args.request.requestId, { name, request: copy(args.request), resolve }));
      if (name === 'ai_key_read') return 'fixture-local-key';
      if (name === 'memory_list') return [];
      return null;
    },
  };
  installHarnessFixture(w, T);
  w.UI = T.ui;
  for (const file of ['icons.js', 'term.js', 'ai-context.js', 'ai-agent.js']) w.eval(read(file));
  const TM = T.term;
  const tab = { id: 'fixture-ui', title: 'Fixture target', ptyId: 'native-first', _connectionGeneration: 1,
    session: { protocol: 'ssh', host: 'fixture.invalid', user: 'ops', port: 22 }, renderer: [],
    term: { focus() {}, write() {}, getSelection() { return ''; } } };
  TM.tabs[tab.id] = tab; TM.order.push(tab.id); TM.active = tab.id;
  if (memory) w.AiMemory = { isEnabled: () => true, settings: () => ({ autoRecall: false }), scopeFor: async () => 'fixture-scope', mount() {},
    writeApproved: async () => { writes++; return { path: 'MEMORY.md', hash: 'saved' }; } };
  const q = selector => d.querySelector(selector), requests = name => calls.filter(([command]) => command === name).map(([, args]) => args.request);
  let host = q('#ai-panel'); if (!host) { host = d.createElement('aside'); host.id = 'ai-panel'; q('#workspace').append(host); }
  w.eval(readFileSync(new URL('../node_modules/markdown-it/dist/browser/markdown-it.umd.min.js', import.meta.url), 'utf8'));
  w.eval(read('ai-markdown.js')); w.eval(read('ai.js')); const A = w.AiPanel; A.mount(host); A.open(); A.setMode('agent');
  return {
    w, d, T, A, TM, tab, q, pending, requests, calls, snapshots, get writes() { return writes; },
    async send(goal) { await pause(10); const before = requests('ai_agent_step').length; q('#ai-input').value = goal; q('#ai-input').dispatchEvent(new w.Event('input', { bubbles: true })); q('#ai-send').click(); await until(() => requests('ai_agent_step').length > before, 'panel model'); return requests('ai_agent_step').at(-1); },
    async resolve(request, value) { const task = pending.get(request.requestId); assert.ok(task, 'pending ' + request.requestId); pending.delete(request.requestId); task.resolve(value); await pause(15); },
    async idle() { await until(() => !w.OpsAgent.isRunning() && !q('#ai-send').disabled, 'panel idle'); },
    async close() { A.stop(); for (const task of pending.values()) task.resolve(task.name === 'agent_exec' ? output() : reply()); await pause(10); w.close(); },
  };
}

{
  const e = panel();
  try {
    const model = await e.send('Authorize remaining fixture commands'); await e.resolve(model, reply(command('ui-one'), command('ui-two', 'pwd')));
    check('AR16 Real panel renders all three command decisions together', e.q('[data-ai-approve]')?.textContent === '允许本次执行' && e.q('[data-ai-approve-all]')?.textContent === '以后全部执行' && e.q('[data-ai-reject]')?.textContent === '拒绝并停止');
    const all = e.q('[data-ai-approve-all]'); all.click(); all.click(); await until(() => e.requests('agent_exec').length === 1, 'first approved UI execution');
    check('AR17 Repeated clicks on the all-remaining button grant exactly one first execution', e.requests('agent_exec').length === 1 && !e.q('[data-ai-approval]'));
    await until(() => !!e.q('.ai-agent-auto-note'), 'automatic mode render');
    check('AR17b Real panel makes the temporary automatic mode visible without changing saved preferences', !e.q('#ai-confirm-commands').checked && e.q('#ai-confirm-commands').disabled && e.q('.ai-agent-auto-note')?.textContent.includes('本任务已授权') && e.T.s.ai.confirmCommands === true);
    await e.resolve(e.requests('agent_exec')[0], output()); await until(() => e.requests('agent_exec').length === 2, 'second auto execution');
    check('AR18 Current batch continues without another approval card', !e.q('[data-ai-approval]') && e.requests('agent_exec')[1].command === 'pwd');
    await e.resolve(e.requests('agent_exec')[1], output()); await until(() => e.requests('ai_agent_step').length === 2, 'next model round');
    await e.resolve(e.requests('ai_agent_step')[1], reply(command('ui-danger-later', 'reboot'))); await until(() => e.requests('agent_exec').length === 3, 'later high-impact auto command');
    check('AR19 Real panel current-task authorization includes subsequent high-impact commands', !e.q('[data-ai-approval]') && e.requests('agent_exec')[2].command === 'reboot');
    await e.resolve(e.requests('agent_exec')[2], output()); await until(() => e.requests('ai_agent_step').length === 3, 'last model');
    await e.resolve(e.requests('ai_agent_step')[2], reply()); await e.idle();
    check('AR20 All-remaining leaves the saved per-command preference enabled', e.T.s.ai.confirmCommands === true && e.q('#ai-confirm-commands').checked === true && e.snapshots.every(value => !JSON.stringify(value).includes('allowRemaining')));
    const next = await e.send('Separate new task'); await e.resolve(next, reply(command('new-task-needs-approval')));
    check('AR21 New task through the real panel returns to normal approval', !!e.q('[data-ai-approval]') && e.requests('agent_exec').length === 3);
    all.click(); await pause(10);
    check('AR22 Detached button from the earlier task cannot approve a new task', !!e.q('[data-ai-approval]') && e.requests('agent_exec').length === 3);
    e.q('[data-ai-reject]').click(); await e.idle();
    check('AR23 Existing reject button stops the new task without executing', e.requests('agent_exec').length === 3 && !e.q('[data-ai-approval]'));
  } finally { await e.close(); }
}

{
  const e = panel();
  try {
    const model = await e.send('Keep one-time approval behavior'); await e.resolve(model, reply(command('ui-once'), command('ui-second')));
    e.q('[data-ai-approve]').click(); await until(() => e.requests('agent_exec').length === 1, 'one-time execution');
    await e.resolve(e.requests('agent_exec')[0], output()); await until(() => !!e.q('[data-ai-approval]'), 'next confirmation');
    check('AR24 Existing allow-once button continues to require the next confirmation', e.requests('agent_exec').length === 1 && e.q('[data-ai-approval]').textContent.includes('printf fixture'));
    const late = e.q('[data-ai-approve-all]'); e.A.stop(); await e.idle(); late.click(); await pause(10);
    check('AR25 A late click after panel stop cannot execute the pending command', e.requests('agent_exec').length === 1 && !e.q('[data-ai-approval]'));
  } finally { await e.close(); }
}

{
  const e = panel({ memory: true });
  try {
    const model = await e.send('Authorize commands then confirm memory'); await e.resolve(model, reply(command('ui-before-memory'), memoryWrite('ui-memory')));
    e.q('[data-ai-approve-all]').click(); await until(() => e.requests('agent_exec').length === 1, 'command before memory');
    await e.resolve(e.requests('agent_exec')[0], output()); await until(() => !!e.q('[data-ai-approval]'), 'memory confirmation');
    check('AR26 Memory write confirmation never exposes all-remaining authorization', !e.q('[data-ai-approve-all]') && e.q('[data-ai-approve]')?.textContent === '保存这条记忆' && e.writes === 0);
    e.q('[data-ai-approve]').click(); await until(() => e.requests('ai_agent_step').length === 2, 'post-memory model');
    check('AR27 Explicit save still permits exactly the reviewed memory write', e.writes === 1);
    await e.resolve(e.requests('ai_agent_step')[1], reply()); await e.idle();
  } finally { await e.close(); }
}
check('AR28 All real panel interactions finish without JavaScript or DOM errors', errors.length === 0);
console.log(`\nAI allow remaining: ${checks.length}/${checks.length} checks passed. Native/model transports controlled.`);
