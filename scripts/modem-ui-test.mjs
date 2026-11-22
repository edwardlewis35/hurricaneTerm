// Run the production controller against controlled native operations, not real files.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
const source = readFileSync(new URL('../src/modem.js', import.meta.url), 'utf8');
const errors = [], console = new VirtualConsole(); console.on('jsdomError', e => errors.push(e.message));
const dom = new JSDOM('<!doctype html><button id="previous">传输</button><main id="main-area"></main>', { runScripts:'outside-only', pretendToBeVisual:true, virtualConsole:console });
const w = dom.window, d = w.document, pending = new Map(), calls = [], rows = new Map(), tabs = {};
let selected, capabilitiesDelay, cancelOperation, passed = 0;
const settle = async () => { for (let i=0;i<8;i++) await new Promise(r => setImmediate(r)); };
const check = (condition, message) => { assert.ok(condition, message); passed++; };
const tab = (id, protocol='ssh') => {
  const wrap = d.createElement('div'); wrap.className = 'term-wrap'; d.body.append(wrap);
  return tabs[id] = {id,ptyId:id+'-pty',title:id,wrap,_connectionGeneration:1,_connectionIdentity:{protocol,host:id,user:'tester'},_resetInput(){this.reset=true;} };
};
const a=tab('machine-a'), b=tab('machine-b'); selected=a;
w.TransferQueue = { upsert(task, options) { rows.set(task.id,{...task,controls:options.controls}); }, open(){this.opened=true;} };
w.WT = {term:{tabs,activeTab:()=>selected,ptyId:t=>t.ptyId,isLive:t=>!!t&&!t.exited&&!t._closing&&tabs[t.id]===t&&!!t.ptyId,findByPty:id=>Object.values(tabs).find(t=>t.ptyId===id)},
  ui:{toast(message){calls.push({toast:message});}}, invoke:async(command,args)=>{
    calls.push({command,args});
    if(command==='modem_capabilities') return capabilitiesDelay ? capabilitiesDelay : {available:true,protocols:['xmodem','ymodem','zmodem']};
    if(command==='modem_transfer_start') return new Promise((resolve,reject)=>pending.set(args.request.transferId,{resolve,reject,request:args.request}));
    if(command==='modem_transfer_cancel') {
      if(cancelOperation) return cancelOperation(args);
      pending.get(args.transferId)?.resolve({status:'cancelled',done:0,total:0});return;
    }
    if(command==='fs_realpath') return args.path||'/tmp/local';
    if(command==='fs_list') return [{name:'<img src=x onerror=alert(1)>.bin',path:'/tmp/local/<img src=x onerror=alert(1)>.bin',is_dir:false,size:12},{name:'folder',path:'/tmp/local/folder',is_dir:true}];
    throw new Error('Unexpected native operation '+command);
  }};
w.eval(source); const api=w.ModemTransfer;
try {
  d.querySelector('#previous').focus(); await api.open();
  check(api.isOpen() && d.querySelector('[role=dialog]'), 'a connected terminal opens the real form');
  check(d.querySelector('[data-start]').disabled===false,'capabilities enable submission');
  check(d.querySelector('[name=paths]').getAttribute('autocapitalize')==='off','file path input does not capitalize');
  d.querySelector('[name=protocol]').value='xmodem'; d.querySelector('[name=protocol]').dispatchEvent(new w.Event('change'));
  d.querySelector('[name=direction]').value='download';d.querySelector('[name=direction]').dispatchEvent(new w.Event('change'));
  check(!d.querySelector('[data-trim]').hidden && d.querySelector('[name=trimPadding]').checked===false,'binary padding is preserved by default');
  check(d.querySelector('[data-dest-label]').textContent.includes('完整路径'),'XMODEM receive asks for explicit filename');
  api.close();check(d.activeElement.id==='previous','closing restores previous focus');

  await assert.rejects(api.enqueue({tab:a,protocol:'xmodem',paths:['/one','/two']}),/一个文件/);passed++;
  await assert.rejects(api.enqueue({tab:a,paths:['/one\n/two']}),/换行/);passed++;
  await assert.rejects(api.enqueue({tab:a,direction:'download'}),/接收/);passed++;
  w.OpsAgent={isRunning:()=>true,getTarget:()=>({sessionId:a.ptyId})};
  await assert.rejects(api.enqueue({tab:a,paths:['/one']}),/运维/);passed++;delete w.OpsAgent;

  const one=await api.enqueue({tab:a,protocol:'xmodem',paths:['/one'],packetSize:128}); await settle();
  const two=await api.enqueue({tab:a,protocol:'ymodem',paths:['/two','/three']});
  const other=await api.enqueue({tab:b,protocol:'zmodem',direction:'download',destination:'/downloads'}); await settle();
  check(pending.size===2&&two.status==='queued','one native session is serialized while another can run');
  check(api.isBusy(a)&&api.isBusy(b)&&a.reset,'input is suspended before native invocation');
  const request=pending.get(one.nativeTransferId).request;
  check(request.sessionId===a.ptyId&&request.protocol==='xmodem'&&request.packetSize===128,'native request includes captured target and protocol');
  api.progress({transferId:one.nativeTransferId,sessionId:b.ptyId,status:'running',done:999,total:1000});
  check(one.done===0,'progress from another native session is ignored');
  api.progress({transferId:one.nativeTransferId,sessionId:a.ptyId,status:'running',done:16,total:128,name:'one'});
  check(rows.get(one.id).done===16&&one.status==='running','valid progress reaches the global queue');
  pending.get(one.nativeTransferId).resolve({status:'completed',done:128,total:128});await settle();
  check(one.status==='completed'&&two.status==='preparing','the next task starts only after the prior operation finishes');
  check(rows.get(two.id).protocol==='YMODEM','queue identifies each transfer protocol');
  await rows.get(two.id).controls.cancel(); await settle();
  check(two.status==='cancelled'&&!api.isBusy(a),'cancelling releases the exclusive frontend session');
  pending.get(other.nativeTransferId).reject(new Error('CRC retry limit exceeded'));await settle();
  check(other.status==='failed'&&rows.get(other.id).error.includes('CRC'),'native errors stay visible in the queue');
  const previousAttempt=other.nativeTransferId;
  rows.get(other.id).controls.retry(); await settle();
  check(other.nativeTransferId!==previousAttempt&&rows.get(other.id).id===other.id,'retry retains the row and uses a fresh native attempt');
  api.progress({transferId:previousAttempt,sessionId:b.ptyId,done:500,total:600,status:'running'});
  check(other.done===0,'late progress from a prior attempt is ignored');
  b.exited=true;b.ptyId=null;api.onConnectionChange(b);await settle();
  check(other.status==='cancelled'&&!api.isBusy(b),'disconnect cancels the active original target');
  assert.throws(()=>rows.get(other.id).controls.retry(),/原连接/);passed++;

  const waitingFirst=await api.enqueue({tab:a,paths:['/four']});
  const waitingSecond=await api.enqueue({tab:a,paths:['/five']});await settle();
  await rows.get(waitingSecond.id).controls.cancel();
  check(waitingSecond.status==='cancelled'&&!pending.has(waitingSecond.nativeTransferId),'queued cancellation never starts native transfer');
  pending.get(waitingFirst.nativeTransferId).resolve(undefined);await settle();
  check(waitingFirst.status==='failed'&&waitingFirst.error.includes('完成状态'),'missing native completion cannot become success');

  // Cancellation is a request; only the native outcome proves what happened.
  const refused=await api.enqueue({tab:a,paths:['/cancel-refused']});await settle();
  api.progress({transferId:refused.nativeTransferId,sessionId:a.ptyId,status:'running',done:10,total:100});
  cancelOperation=async()=>{throw Error('native cancellation denied');};
  await assert.rejects(rows.get(refused.id).controls.cancel(),/native cancellation denied/);passed++;
  check(refused.status==='running'&&!refused.cancelled&&!refused.cancelPending&&rows.get(refused.id).error.includes('native cancellation denied'),'rejected cancellation restores running state and reports the native error');
  api.progress({transferId:refused.nativeTransferId,sessionId:a.ptyId,status:'running',done:60,total:100});
  check(refused.done===60&&rows.get(refused.id).done===60,'progress resumes after a cancellation rejection');
  pending.get(refused.nativeTransferId).resolve({status:'completed',done:100,total:100});await settle();
  check(refused.status==='completed'&&!refused.cancelled&&refused.done===100&&refused.error==='','native success after a rejected cancellation remains completed');

  const retryCancel=await api.enqueue({tab:a,paths:['/retry-cancel']});await settle();
  api.progress({transferId:retryCancel.nativeTransferId,sessionId:a.ptyId,status:'negotiating',done:0,total:100});
  await assert.rejects(rows.get(retryCancel.id).controls.cancel(),/native cancellation denied/);passed++;
  check(retryCancel.status==='negotiating'&&!retryCancel.cancelled&&typeof rows.get(retryCancel.id).controls.cancel==='function','a failed cancellation restores the previous negotiating phase and permits another cancel');
  cancelOperation=null;await rows.get(retryCancel.id).controls.cancel();await settle();
  check(retryCancel.status==='cancelled'&&!api.isBusy(a),'a second cancellation can be accepted after the first one failed');

  const completeBeforeCancel=await api.enqueue({tab:a,paths:['/completion-wins']});await settle();
  let acceptCancel;
  cancelOperation=()=>new Promise(resolve=>{acceptCancel=resolve;});
  const cancellation=rows.get(completeBeforeCancel.id).controls.cancel();await settle();
  const cancelCalls=calls.filter(call=>call.command==='modem_transfer_cancel').length;
  await rows.get(completeBeforeCancel.id).controls.cancel();
  check(completeBeforeCancel.status==='cancelling'&&calls.filter(call=>call.command==='modem_transfer_cancel').length===cancelCalls,'a pending native cancellation cannot be dispatched twice');
  pending.get(completeBeforeCancel.nativeTransferId).resolve({status:'completed',done:2048,total:2048});await settle();
  check(completeBeforeCancel.status==='completed'&&!completeBeforeCancel.cancelled&&completeBeforeCancel.done===2048&&!api.isBusy(a),'actual completion wins while cancellation IPC is still pending');
  acceptCancel();await cancellation;await settle();
  check(completeBeforeCancel.status==='completed'&&!completeBeforeCancel.cancelPending,'a late successful cancellation acknowledgement cannot overwrite completion');

  const lateRejection=await api.enqueue({tab:a,paths:['/late-rejection']});await settle();
  let rejectCancel;
  cancelOperation=()=>new Promise((_,reject)=>{rejectCancel=reject;});
  const lateCancellation=rows.get(lateRejection.id).controls.cancel();await settle();
  pending.get(lateRejection.nativeTransferId).resolve({status:'completed',done:512,total:512});await settle();
  rejectCancel(Error('reply arrived after commit'));await lateCancellation;await settle();
  check(lateRejection.status==='completed'&&lateRejection.done===512&&!lateRejection.cancelled&&!lateRejection.cancelPending&&lateRejection.error==='','a late cancellation rejection cannot revert or dirty an already completed result');

  const acknowledged=await api.enqueue({tab:a,paths:['/cancel-ack-before-complete']});await settle();
  cancelOperation=async()=>{};await rows.get(acknowledged.id).controls.cancel();
  check(acknowledged.status==='cancelling'&&api.isBusy(a),'cancellation IPC acknowledgement alone does not release the transfer session');
  pending.get(acknowledged.nativeTransferId).resolve({status:'completed',done:256,total:256});await settle();
  check(acknowledged.status==='completed'&&!acknowledged.cancelled&&acknowledged.done===256,'even an acknowledged cancel cannot replace a later authoritative completion');

  const oldReply=await api.enqueue({tab:a,paths:['/attempt-isolation']});await settle();
  let rejectOldCancel;
  cancelOperation=()=>new Promise((_,reject)=>{rejectOldCancel=reject;});
  const oldCancellation=rows.get(oldReply.id).controls.cancel();await settle();
  const oldAttempt=oldReply.nativeTransferId;
  pending.get(oldAttempt).reject(Error('传输已取消或连接已断开'));await settle();
  check(oldReply.status==='cancelled'&&!oldReply.working,'a native cancellation error finalizes the original attempt');
  rows.get(oldReply.id).controls.retry();await settle();
  api.progress({transferId:oldReply.nativeTransferId,sessionId:a.ptyId,status:'running',done:32,total:64});
  rejectOldCancel(Error('old attempt cancellation failed'));await oldCancellation;await settle();
  check(oldReply.nativeTransferId!==oldAttempt&&oldReply.status==='running'&&oldReply.done===32&&oldReply.error===''&&!oldReply.cancelled,'a stale cancellation failure cannot roll back a new retry attempt');
  pending.get(oldReply.nativeTransferId).resolve({status:'completed',done:64,total:64});await settle();

  const unrelatedFailure=await api.enqueue({tab:a,paths:['/native-failure']});await settle();
  cancelOperation=async()=>{};await rows.get(unrelatedFailure.id).controls.cancel();
  pending.get(unrelatedFailure.nativeTransferId).reject(Error('CRC retry limit exceeded'));await settle();
  check(unrelatedFailure.status==='failed'&&unrelatedFailure.error.includes('CRC'),'an unrelated native transfer failure is not relabeled as cancelled merely because cancel was requested');
  cancelOperation=null;

  selected=a;await api.open();
  d.querySelector('[data-upload] button').click();await settle();
  check(!d.querySelector('[data-browser]').hidden&&d.querySelectorAll('[data-files] img').length===0,'local file browser renders filenames as inert text');
  const checkbox=d.querySelector('[data-files] input[type=checkbox]');checkbox.checked=true;checkbox.dispatchEvent(new w.Event('change'));
  check(d.querySelector('[name=paths]').value.includes('<img'),'selecting a local file fills its original path');
  selected=b; // Switching active tabs must not redirect the already-open form.
  d.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();
  const latest=api.tasks.at(-1);
  check(latest.sessionId===a.ptyId&&latest.machine===a.title,'form submission keeps its displayed target after a tab switch');
  pending.get(latest.nativeTransferId).resolve({status:'completed',done:12,total:12});await settle();

  let reply; capabilitiesDelay=new Promise(resolve=>{reply=resolve;});selected=a;
  const opening=api.open();await settle();api.close();reply({available:true,protocols:['xmodem']});await opening;
  check(!api.isOpen(),'late capability results do not reopen a closed dialog');capabilitiesDelay=null;
  selected=b;await api.open();check(!api.isOpen(),'disconnected tabs cannot open a transfer form');
  check(errors.length===0,'no JavaScript errors');
  process.stdout.write(JSON.stringify({passed,total:passed,errors})+'\n');
} finally { api.close(false);dom.window.close(); }
