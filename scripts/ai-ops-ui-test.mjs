// Integration: real panel + operations controller + terminal output/write
// boundary, with only the native IPC transport and terminal renderer controlled.
// No provider network requests or machine commands are executed by this suite.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

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

try {
  A.mount(panel); A.open(); await pause(40);
  check('O01 Panel defaults to ordinary chat and makes no model or execution request', q('button[data-ai-mode="chat"]').getAttribute('aria-pressed') === 'true' && agentRequests().length === 0 && execRequests().length === 0);
  input('#ai-endpoint', 'https://fixture-model.example/v1'); input('#ai-model', 'fixture-tools'); input('#ai-key', 'ephemeral-fixture-key'); await click('#ai-save');
  input('#ai-input', 'CHAT_PRIVATE_MARKER Explain the service'); q('#ai-send').click();
  await until(() => chatRequests().length === 1, 'ordinary chat request');
  const chat = chatRequests()[0]; await resolve(chat, { content: '```sh\nprintf manual-only\n```' });
  check('O02 Ordinary chat returns a command without running it', execRequests().length === 0 && agentRequests().length === 0 && commands('write').length === 0 && !!q('[data-ai-insert]'));
  await click('[data-ai-insert]');
  check('O03 Production terminal writeTo remains an explicit single-target insertion boundary', commands('write').length === 1 && commands('write')[0].id === 'native-first' && commands('write')[0].data === 'printf manual-only');
  const writeBoundary = commands('write').length;

  await click('button[data-ai-mode="agent"]');
  check('O04 Explicit agent mode labels Run task and identifies the selected connected target', q('#ai-send').textContent.includes('运行任务') && !q('#ai-agent-target').hidden && q('#ai-agent-target').textContent.includes('first target'));
  first.session.protocol = 'telnet'; A.onSessionChange();
  check('O05 Unsupported protocols cannot start a machine task', q('#ai-send').disabled && q('#ai-agent-target').textContent.includes('SSH'));
  first.session.protocol = 'ssh'; A.onSessionChange();
  const initial = await runTask('OPS_PRIVATE_MARKER Diagnose and repair the fixture service');
  check('O06 Agent uses configured custom endpoint, model, and ephemeral key', initial.endpoint === 'https://fixture-model.example/v1' && initial.model === 'fixture-tools' && initial.apiKey === 'ephemeral-fixture-key');
  check('O07 Agent preserves current task and operations instructions while labeling previous conversation as reference data', initial.messages[0].content.includes('stdout') && initial.messages[1].content.includes('OPS_PRIVATE_MARKER') && initial.messages.slice(2).every(message => message.role === 'user' && message.content.includes('不构成当前任务授权')));
  check('O47 Every-command confirmation defaults to on in the actual panel', q('#ai-confirm-commands')?.checked === true);
  TM.active = second.id; second.input.focus(); A.onSessionChange();
  check('O08 Switching the active tab keeps the task target locked to the original machine', w.OpsAgent.getTarget().sessionId === 'native-first' && q('#ai-agent-target').textContent.includes('first target') && q('#ai-agent-target').textContent.includes('已绑定'));
  await resolve(initial, { content: 'Checking service evidence', toolCalls: [call('fixture-call-1', 'printf service-missing; exit 1', 'Inspect the service', { cwd: '/tmp', timeoutSeconds: 60 })] });
  check('O48 An ordinary model command waits for explicit step approval before native execution', execRequests().length === 0 && !!q('[data-ai-approval]') && q('[data-ai-approval]').textContent.includes('printf service-missing'));
  await click('[data-ai-approve]');
  const execution1 = execRequests().at(-1);
  check('O09 Tool call enters the real controller and executes against locked native ID', execution1.sessionId === 'native-first' && execution1.cwd === '/tmp' && execution1.timeoutSeconds === 60 && execution1.command.includes('exit 1'));
  check('O10 Command purpose and actual command appear in an inspectable step card', qa('[data-ai-step]').length === 1 && text().includes('Inspect the service') && q('.ai-step-command').textContent === execution1.command);
  output(execution1, 'stdout', 'FOREIGN_OUTPUT', { sessionId: 'native-second' }); output(execution1, 'stdout', 'WRONG_REQUEST', { requestId: 'unrelated-request' });
  output(execution1, 'stdout', 'partial \x1b[31mred\x1b[0m\n<img src=x onerror=alert(1)>\n');
  output(execution1, 'stderr', 'failed \x1b]52;c;CLIPBOARD_ATTACK\x07\n'); await pause(45);
  check('O11 Output event routing rejects foreign sessions and unrelated execution IDs', !text().includes('FOREIGN_OUTPUT') && !terminal(first).includes('FOREIGN_OUTPUT') && !terminal(first).includes('WRONG_REQUEST'));
  check('O12 ANSI color and OSC clipboard sequences never reach the terminal parser or UI markup', !/[\x1b\x07]/.test(terminal(first)) && !terminal(first).includes('CLIPBOARD_ATTACK') && !q('#ai-messages img') && text().includes('<img src=x onerror=alert(1)>'));
  check('O13 Command and output mirror through production receiveOutput without SSH write or sync broadcast', terminal(first).includes('[AI 运维') && terminal(first).includes('partial red') && !terminal(second).includes('[AI 运维') && commands('write').length === writeBoundary);
  const rawStdout = 'partial \x1b[31mred\x1b[0m\n<img src=x onerror=alert(1)>\ntail-one\n';
  const rawStderr = 'failed \x1b]52;c;CLIPBOARD_ATTACK\x07\nreason-one\n';
  await resolve(execution1, result(rawStdout, rawStderr, 1));
  const secondModel = agentRequests().at(-1), observation1 = JSON.parse(secondModel.messages.at(-1).content);
  check('O14 Failed execution becomes a paired structured tool result for the next model decision', secondModel.messages.at(-2).role === 'assistant' && secondModel.messages.at(-2).toolCalls[0].id === 'fixture-call-1' && secondModel.messages.at(-1).toolCallId === 'fixture-call-1' && observation1.exitCode === 1 && observation1.stderr.includes('reason-one'));
  check('O15 Final results append missing tails exactly once and display actual exit status', (terminal(first).match(/partial red/g) || []).length === 1 && (terminal(first).match(/tail-one/g) || []).length === 1 && text().includes('退出码 1'));
  const mirroredAtResult = terminal(first); output(execution1, 'stdout', 'LATE_DUPLICATE_STREAM'); await pause(40);
  check('O16 Late output after a final execution result cannot duplicate or append stale data', terminal(first) === mirroredAtResult && !text().includes('LATE_DUPLICATE_STREAM'));
  await resolve(secondModel, { content: 'The service check failed; validate the corrected service path.', toolCalls: [call('fixture-call-2', 'printf corrected-service-ready', 'Verify the corrected service', { cwd: '/tmp' })] });
  check('O49 Approving a command never approves the next ordinary model step', execRequests().length === 1 && !!q('[data-ai-approval]'));
  await click('[data-ai-approve]');
  const execution2 = execRequests().at(-1);
  check('O17 A failed result leads to a different follow-up command on the same locked target', execution2.command !== execution1.command && execution2.sessionId === execution1.sessionId && execution2.timeoutSeconds === 60);
  await resolve(execution2, result('corrected-service-ready\n', '', 0));
  const finalModel = agentRequests().at(-1);
  check('O18 Final model verification retains both call/result pairs and real success status', finalModel.messages.filter(message => message.role === 'assistant' && message.toolCalls).length === 2 && finalModel.messages.filter(message => message.role === 'tool').length === 2 && JSON.parse(finalModel.messages.at(-1).content).exitCode === 0);
  await end(finalModel, 'OPS_SUMMARY_MARKER Corrected service path and verified its healthy output.'); await waitIdle();
  check('O19 A no-tool answer completes the loop and shows summary plus two execution records', qa('[data-ai-step]').length === 2 && text().includes('OPS_SUMMARY_MARKER') && text().includes('任务结束 · 2 条命令') && execRequests().length === 2);
  const stepContainer = q('.ai-agent-steps'), summaryParagraph = [...stepContainer.parentElement.querySelectorAll('p')].find(node => node.textContent.includes('OPS_SUMMARY_MARKER'));
  check('O50 Command and output records precede the final model summary in DOM order', !!summaryParagraph && !!(stepContainer.compareDocumentPosition(summaryParagraph) & w.Node.DOCUMENT_POSITION_FOLLOWING));
  check('O51 Completing a task bound to another tab does not steal terminal input focus', d.activeElement !== first.input);
  check('O20 Mirroring never writes commands to either interactive terminal or broadcasts Enter', commands('write').length === writeBoundary && terminal(second) === '' && terminal(first).includes('退出码 0'));
  check('O21 Completion disposes the per-task execution output subscription', listeners.get('agent-exec-output')?.size === 0);
  await click('button[data-ai-mode="chat"]'); input('#ai-input', 'CHAT_FOLLOWUP_MARKER'); q('#ai-send').click(); await until(() => chatRequests().length === 2, 'chat after task');
  const afterAgent = chatRequests().at(-1), chatHistory = JSON.stringify(afterAgent.messages);
  check('O22 Completed conversations can inform the next chat without replaying executable tool-call messages', chatHistory.includes('CHAT_PRIVATE_MARKER') && afterAgent.messages.every(message => !message.toolCalls && !message.toolCallId && message.role !== 'tool'));
  await resolve(afterAgent, { content: 'Normal chat continues independently.' });

  await freshAgent();
  await click('#ai-confirm-commands');
  check('O52 Disabling per-step confirmation updates the policy for following tasks', q('#ai-confirm-commands').checked === false && T.s.ai.confirmCommands === false);
  const rejectedModel = await runTask('APPROVAL_PRIVATE_MARKER Remove a disposable fixture directory');
  const execBeforeReject = execRequests().length;
  await resolve(rejectedModel, { content: '', toolCalls: [call('danger-reject', 'rm -rf /tmp/hurricane-fixture', 'Remove the user-selected fixture')] });
  check('O23 Recognized irreversible actions pause at explicit approval before native execution', !!q('[data-ai-approval]') && q('[data-ai-approval]').textContent.includes('rm -rf') && execRequests().length === execBeforeReject && q('#ai-status').textContent.includes('等待确认'));
  await click('[data-ai-reject]'); await waitIdle();
  check('O24 Reject stops the task without executing the proposed command', execRequests().length === execBeforeReject && !q('[data-ai-approval]') && text().includes('已拒绝'));
  const afterRejectedTask = await runTask('Continue after rejecting the previous proposal');
  check('O54 A rejected unexecuted approval is never recorded as an executed operation in the next task', !JSON.stringify(afterRejectedTask.messages).includes('APPROVAL_PRIVATE_MARKER') && !JSON.stringify(afterRejectedTask.messages).includes('rm -rf /tmp/hurricane-fixture') && execRequests().length === execBeforeReject);
  await end(afterRejectedTask, 'No further operation requested'); await waitIdle();
  await freshAgent(); const allowedModel = await runTask('Allow exactly one disposable fixture cleanup');
  await resolve(allowedModel, { content: '', toolCalls: [call('danger-allow', 'rm -rf /tmp/hurricane-fixture', 'Clean the confirmed fixture')] });
  const approveButton = q('[data-ai-approve]'); assert.ok(approveButton); approveButton.click(); approveButton.click(); await pause(45);
  const allowedExecution = execRequests().at(-1);
  check('O25 Repeated clicks grant only one execution of the exact displayed command', execRequests().length === execBeforeReject + 1 && allowedExecution.command === 'rm -rf /tmp/hurricane-fixture' && !q('[data-ai-approval]'));
  await resolve(allowedExecution, result('', '', 0)); await end(agentRequests().at(-1), 'Confirmed one cleanup result'); await waitIdle();
  await freshAgent(); const repeatApproval = await runTask('Repeat disposable cleanup as a new task');
  await resolve(repeatApproval, { content: '', toolCalls: [call('danger-next-task', 'rm -rf /tmp/hurricane-fixture', 'Confirm a new cleanup')] });
  check('O26 Approval is not remembered across tasks or reused for later commands', !!q('[data-ai-approval]') && execRequests().length === execBeforeReject + 1);
  await click('#ai-stop'); await waitIdle();
  check('O27 Stop resolves pending approval without executing its command', !q('[data-ai-approval]') && execRequests().length === execBeforeReject + 1 && !w.OpsAgent.isRunning());

  await freshAgent(); const stoppedModel = await runTask('Stop while the provider thinks'); const beforeStopped = execRequests().length;
  await click('#ai-stop'); await waitIdle();
  check('O28 Stop cancels the exact pending provider request', commands('ai_cancel').some(args => args.requestId === stoppedModel.requestId));
  await resolve(stoppedModel, { content: 'late unsafe answer', toolCalls: [call('late-stopped-model', 'printf must-not-run')] });
  check('O29 Late model completion after stop cannot execute a new command', execRequests().length === beforeStopped && !text().includes('late unsafe answer'));
  await freshAgent(); const executionStopModel = await runTask('Stop an in-flight service check');
  await resolve(executionStopModel, { content: '', toolCalls: [call('exec-stop', 'printf pending-check')] });
  const stoppedExecution = execRequests().at(-1), modelCountAtStop = agentRequests().length;
  output(stoppedExecution, 'stdout', 'before-stop\n'); await pause(35); await click('#ai-stop'); await waitIdle();
  const mirrorAfterStop = terminal(first); output(stoppedExecution, 'stdout', 'AFTER_STOP_OUTPUT'); await resolve(stoppedExecution, result('AFTER_STOP_FINAL', '', 0));
  check('O30 Stop cancels the exact native execution and does not issue another model step', commands('agent_exec_cancel').some(args => args.requestId === stoppedExecution.requestId) && agentRequests().length === modelCountAtStop);
  check('O31 Cancelled tasks ignore late execution output and final result', terminal(first) === mirrorAfterStop && !text().includes('AFTER_STOP_FINAL') && !text().includes('AFTER_STOP_OUTPUT'));
  check('O32 Stopped incomplete step remains visible with stopped state', q('[data-ai-step]')?.textContent.includes('已停止') && text().includes('pending-check'));
  const afterUnknownResult = await runTask('Inspect the actual state before retrying a stopped operation');
  const uncertainReference = afterUnknownResult.messages.slice(2).map(message => message.content).join('\n');
  check('O55 A command already dispatched before Stop remains uncertain reference evidence instead of disappearing', uncertainReference.includes('pending-check') && uncertainReference.includes('不构成当前任务授权') && uncertainReference.includes('完成状态未知') && uncertainReference.includes('可能已产生副作用') && afterUnknownResult.messages.every(message => !message.toolCalls && message.role !== 'tool'));
  await end(afterUnknownResult, 'Check state before repeating an operation'); await waitIdle();

  await freshAgent(); const closedPanelModel = await runTask('Close the AI panel during a task'); const beforePanelClose = execRequests().length;
  A.close(); await until(() => !w.OpsAgent.isRunning(), 'panel close cancellation');
  await resolve(closedPanelModel, { content: '', toolCalls: [call('panel-close-late', 'printf must-not-run')] });
  check('O33 Closing the AI panel cancels generation and blocks late actions', !A.isOpen() && commands('ai_cancel').some(args => args.requestId === closedPanelModel.requestId) && execRequests().length === beforePanelClose);

  await freshAgent(); const closedTargetModel = await runTask('Close the selected terminal during analysis'); const beforeTargetClose = execRequests().length;
  first._closing = true; delete TM.tabs[first.id]; A.onSessionChange(); await until(() => !w.OpsAgent.isRunning(), 'closed target cancellation');
  await resolve(closedTargetModel, { content: '', toolCalls: [call('target-close-late', 'printf must-not-run')] });
  check('O34 Closing the target terminal invalidates the task and cancels its model request', commands('ai_cancel').some(args => args.requestId === closedTargetModel.requestId) && execRequests().length === beforeTargetClose && text().includes('目标连接已关闭'));

  await freshAgent(); const reconnectModel = await runTask('Reconnect the target during command execution');
  await resolve(reconnectModel, { content: '', toolCalls: [call('reconnect-exec', 'printf pending-reconnect')] });
  const oldNativeExecution = execRequests().at(-1), modelsBeforeReconnect = agentRequests().length;
  first.ptyId = 'native-first-reconnected'; first._connectionGeneration++; A.onSessionChange(); await until(() => !w.OpsAgent.isRunning(), 'connection generation cancellation');
  const mirrorAfterReconnect = terminal(first); output(oldNativeExecution, 'stdout', 'OLD_CONNECTION_OUTPUT'); await resolve(oldNativeExecution, result('OLD_CONNECTION_FINAL', '', 0));
  check('O35 Reconnecting cancels execution bound to the old native ID without migrating work', commands('agent_exec_cancel').some(args => args.requestId === oldNativeExecution.requestId) && agentRequests().length === modelsBeforeReconnect && terminal(first) === mirrorAfterReconnect);
  check('O36 Old-generation command output cannot appear in the reconnected terminal or task', !text().includes('OLD_CONNECTION_OUTPUT') && !text().includes('OLD_CONNECTION_FINAL'));
  await freshAgent(); const newNativeModel = await runTask('Inspect newly connected terminal');
  await resolve(newNativeModel, { content: '', toolCalls: [call('new-native-exec', 'printf new-connection')] });
  const newNativeExecution = execRequests().at(-1);
  check('O37 A newly started task explicitly captures the new native connection identity', newNativeExecution.sessionId === 'native-first-reconnected');
  await resolve(newNativeExecution, result('new-connection\n')); await end(agentRequests().at(-1)); await waitIdle();

  await freshAgent(); first.session.protocol = 'local'; A.onSessionChange(); const localModel = await runTask('Inspect selected local terminal');
  await resolve(localModel, { content: '', toolCalls: [call('local-exec', 'printf local-check')] }); const localExecution = execRequests().at(-1);
  check('O38 Explicit operations mode also supports a selected local terminal', localExecution.sessionId === first.ptyId && w.OpsAgent.getTarget().protocol === 'local');
  await resolve(localExecution, result('local-check\n')); await end(agentRequests().at(-1)); await waitIdle();
  await freshAgent(); const noToolsModel = await runTask('Question that needs no command'); const execBeforeNoTools = execRequests().length;
  await end(noToolsModel, 'No changes are necessary.'); await waitIdle();
  check('O53 Finishing a task on its still-selected live terminal restores input focus without Enter', d.activeElement === first.input && commands('write').length === writeBoundary);
  check('O39 A model answer without tool calls issues zero machine commands and discloses the boundary', execRequests().length === execBeforeNoTools && q('#ai-status').textContent.includes('模型未调用命令'));

  await freshAgent(); const completedBeforeStop = await runTask('RETAIN_COMPLETED_OPERATION Verify a completed action before planning');
  await resolve(completedBeforeStop, { content: '', toolCalls: [call('completed-then-stop', 'printf COMPLETED_OPERATION_FACT')] });
  await resolve(execRequests().at(-1), result('KNOWN_COMPLETED_RESULT\n', '', 0));
  const interruptedPlan = agentRequests().at(-1); await click('#ai-stop'); await waitIdle();
  const countBeforeRetry = execRequests().length, retryStoppedTask = await runTask('Continue from known execution facts without repeating changes');
  const stoppedReference = retryStoppedTask.messages.slice(2).map(message => message.content).join('\n');
  check('O56 Completed steps from a stopped task remain labeled reference facts in the next request', stoppedReference.includes('KNOWN_COMPLETED_RESULT') && stoppedReference.includes('COMPLETED_OPERATION_FACT') && stoppedReference.includes('stopped') && stoppedReference.includes('不构成当前任务授权'));
  check('O57 Restoring stopped-task facts never replays a command or the previous tool-call protocol', execRequests().length === countBeforeRetry && retryStoppedTask.messages.every(message => !message.toolCalls && !message.toolCallId && message.role !== 'tool'));
  await end(retryStoppedTask, 'Prior result is available for verification'); await waitIdle();
  await resolve(interruptedPlan, { content: 'late stopped plan', toolCalls: [call('never-replay-stopped', 'printf must-not-run')] });

  const persisted = JSON.stringify(saved);
  check('O40 Panel saves only connection and behavior preferences with no secret, task, output, mode or approval state', Object.keys(T.s.ai).sort().join(',') === 'autoCompact,confirmCommands,contextWindow,endpoint,model,rememberKey,width' && !['ephemeral-fixture-key', 'OPS_PRIVATE_MARKER', 'APPROVAL_PRIVATE_MARKER', 'service-missing', 'OPS_SUMMARY_MARKER', 'fixture-call-', 'approval', 'toolCalls'].some(value => persisted.includes(value)));
  const coreDom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://tauri.localhost/' });
  const cw = coreDom.window, nativeSaves = [], add = cw.document.addEventListener.bind(cw.document);
  cw.document.addEventListener = (type, ...args) => type === 'DOMContentLoaded' ? undefined : add(type, ...args);
  cw.__TAURI__ = { core: { invoke(command, args) { if (command === 'ui_state_save') nativeSaves.push(args); return Promise.resolve(null); } }, event: { listen() { return Promise.resolve(() => {}); } } };
  cw.eval(readFileSync(source + 'core.js', 'utf8'));
  cw.WT.s.ai = { endpoint: 'https://fixture.example/v1', model: 'fixture', width: 380, apiKey: 'injected-key', mode: 'agent', tasks: ['private-goal'], approval: { allowed: true }, messages: ['private-output'] };
  cw.WT.persistSettings(); const allowlisted = nativeSaves.find(value => value.name === 'settings').value;
  check('O41 Production core persistence rejects injected agent secrets, task state and approval flags', Object.keys(JSON.parse(allowlisted).ai).sort().join(',') === 'autoCompact,confirmCommands,contextWindow,endpoint,model,rememberKey,width' && !['injected-key', 'private-goal', 'private-output', 'approval'].some(value => allowlisted.includes(value)));
  coreDom.window.close();
  A.newChat(); A.fillConfig();
  check('O42 New conversation clears task records and approvals while preserving only runtime credentials', qa('[data-ai-step]').length === 0 && !q('[data-ai-approval]') && q('#ai-key').value === 'ephemeral-fixture-key' && !w.OpsAgent.isRunning());
  check('O43 Complete controller and panel integration never enters the interactive write path automatically', commands('write').length === writeBoundary);
  check('O44 Task output subscription is disposed after every complete, stopped and invalidated run', listeners.get('agent-exec-output')?.size === 0);
  check('O45 Complete operations UI integration has no JavaScript or DOM errors', errors.length === 0);
  check('O46 Every agent mirror uses the real receiveOutput queue with automatic triggers explicitly disabled', mirrors.length > 0 && mirrors.every(item => item.options?.triggers === false) && commands('triggers_feed').length === 0);
  console.log(`\nRESULT ${checks.length} passed, ${errors.length} JavaScript errors`);
} finally {
  A.stop(); for (const value of pending.values()) value.resolve(value.command === 'agent_exec' ? result('', '', null, { cancelled: true }) : { content: 'cleanup', toolCalls: [] });
  await pause(40); dom.window.close();
}
