// Real controller/kernel with test-only persistence and native execution bridges.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { installHarnessFixture } from './harness-fixture.mjs';
let checks = 0;
const check = (name, value) => { assert.ok(value, name); checks++; console.log('PASS ' + name); };
const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async fn => { const end = Date.now()+3000; while (!fn()) { if (Date.now()>end) throw Error('harness controller deadline'); await tick(); } };
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };
const call = (id, command='printf inspected') => ({id,name:'run_command',arguments:JSON.stringify({command,purpose:'验证状态'})});
const reply = (...toolCalls) => ({content:toolCalls.length?'执行目的':'已验证完成',toolCalls});
const output = () => ({stdout:'verified',stderr:'',exitCode:0,durationMs:1,timedOut:false,cancelled:false,truncated:false});
function env({ model, exec, persist } = {}) {
  const dom = new JSDOM('<!doctype html>',{runScripts:'outside-only',url:'http://tauri.localhost/'}), w=dom.window;
  w.TextEncoder=TextEncoder; const trace=[],calls=[],events=[];
  const tab={id:'original-ui',ptyId:'native-one',title:'fixture',_connectionGeneration:1,
    session:{protocol:'ssh',host:'machine.invalid',user:'ops',port:22,password:'not-persisted'}};
  const T=w.WT={term:{tabs:{[tab.id]:tab},ptyId:t=>t.ptyId,isLive:t=>t===tab&&!t.exited,activeTab:()=>tab},listen:async()=>()=>{},
    invoke:async(name,args)=>{trace.push(name);calls.push({name,args:structuredClone(args)});
      if(name==='ai_agent_step') return model?.(args,calls)??reply();
      if(name==='agent_exec') return exec?.(args,calls)??output();
      if(name==='ai_chat') return {content:'较早记录已整理，继续验证。'};
      return null;
    }};
  const fixture=installHarnessFixture(w,T,{intercept:(name,args,storage)=>{
    trace.push(args.kind||name);return persist?.(name,args,storage);
  }});
  for(const file of ['ai-context.js','ai-agent.js'])w.eval(readFileSync(new URL('../src/'+file,import.meta.url),'utf8'));
  const options={goal:'验证服务',endpoint:'https://model.invalid/v1',model:'fixture',apiKey:'fixture-secret-api-key',tab,confirmEachCommand:false,onEvent:e=>events.push(e)};
  return {w,T,tab,trace,calls,events,fixture,run:extra=>w.OpsAgent.run({...options,...extra}),resume:(id,extra)=>w.OpsAgent.resume({...options,sessionId:id,...extra}),count:name=>calls.filter(c=>c.name===name).length,close:()=>w.close()};
}
{
  let round=0;const e=env({model:()=>++round===1?reply(call('inspect')):reply()});
  const result=await e.run(), record=e.fixture.records.get(result.sessionId);
  check('H01 Built-in profile mounts model, tools, policy, context, memory, session, view and loop services',result.status==='complete'&&result.plugins.length===8&&e.events.some(e=>e.type==='session'&&e.plugins.length===8));
  const kinds=record.events.map(e=>e.kind), t=e.trace;
  check('H02 Session events are contiguous committed facts',record.events.every((e,i)=>e.seq===i+1)&&kinds[0]==='session/start'&&kinds.at(-1)==='turn/end');
  check('H03 Durable model proposal, call and dispatch precede native operation',t.indexOf('assistant/message')<t.indexOf('tool/call')&&t.indexOf('tool/call')<t.indexOf('tool/dispatch')&&t.indexOf('tool/dispatch')<t.indexOf('agent_exec'));
  check('H04 Durable tool result precedes the next model observation',t.indexOf('tool/result')<t.lastIndexOf('ai_agent_step'));
  const model=e.calls.filter(c=>c.name==='ai_agent_step');
  check('H05 Next model request is projected from committed structured tool results',JSON.parse(model[1].args.request.messages.find(m=>m.role==='tool').content).stdout==='verified');
  check('H06 Credentials are excluded from persisted records',!JSON.stringify(record).includes('fixture-secret-api-key')&&!JSON.stringify(record).includes('not-persisted'));
  check('H07 Terminal binding identifiers are runtime-only',!('sessionId'in record.metadata.target)&&!('generation'in record.metadata.target));
  check('H08 Teardown releases live agent after persisted completion',!e.w.OpsAgent.isRunning());
  e.close();
}
{
  const e=env({model:()=>reply(call('blocked-by-storage')),persist:(name,args)=>name==='harness_append'&&args.kind==='tool/dispatch'?Promise.reject(Error('private disk error')):undefined});
  const result=await e.run();
  check('H09 Storage failure before dispatch prevents native execution',result.status==='error'&&e.count('agent_exec')===0);
  check('H10 Storage failures do not leak raw private errors',!result.summary.includes('private disk'));
  check('H11 Failed persistence halts further planning',e.count('ai_agent_step')===1&&!e.w.OpsAgent.isRunning());e.close();
}
{
  const e=env({model:()=>reply(call('unknown-side-effect')),persist:(name,args)=>name==='harness_append'&&args.kind==='tool/result'?Promise.reject(Error('disk full')):undefined});
  const result=await e.run(),record=e.fixture.records.get(result.sessionId),replay=e.w.AiHarness.createJournal(e.T).replay(record);
  check('H12 Lost durable result never retries an executed operation',result.status==='error'&&e.count('agent_exec')===1&&e.count('ai_agent_step')===1);
  check('H13 Unknown outcome is explicit and not recorded as success',replay.pending.length===1&&replay.pending[0].dispatched&&JSON.parse(replay.repairMessages[0].content).code==='TOOL_OUTCOME_UNKNOWN');e.close();
}
{
  let round=0;const execution=deferred();const e=env({model:()=>++round===1?reply(call('old-unknown'),call('old-unstarted','printf not-started')):reply(call('verify-new','printf check-status')),exec:()=>execution.promise});
  const first=e.run();await until(()=>e.count('agent_exec')===1);e.w.OpsAgent.stop();const stopped=await first;
  const record=e.fixture.records.get(stopped.sessionId),before=structuredClone(record),r=e.w.AiHarness.createJournal(e.T).replay(record);
  check('H14 Interrupted batch distinguishes dispatched and not-started calls',r.pending.length===2&&r.pending[0].dispatched&&!r.pending[1].dispatched);
  e.tab.ptyId='native-reconnected';e.tab._connectionGeneration++;
  const approval=deferred();const resumed=e.resume(stopped.sessionId,{confirmEachCommand:false,approve:()=>approval.promise});
  await until(()=>e.events.some(e=>e.type==='approval'));
  check('H15 Resume does not execute old commands or inherit auto-approval',e.count('agent_exec')===1&&e.w.OpsAgent.isRunning());
  const prompt=e.calls.filter(c=>c.name==='ai_agent_step').at(-1).args.request.messages;
  const restored=prompt.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
  check('H16 Resumed model sees unknown and not-started evidence, not fabricated successes',restored[0].code==='TOOL_OUTCOME_UNKNOWN'&&restored[1].code==='TOOL_NOT_STARTED');
  check('H17 Resumed task keeps original goal and asks reconciliation',prompt[1].content==='验证服务'&&prompt.some(m=>m.content?.includes('不能重放')));
  approval.resolve(false);const result=await resumed;
  check('H18 Rejecting fresh confirmation stops before another native operation',result.status==='stopped'&&e.count('agent_exec')===1);
  check('H19 Recovery appends events without rewriting earlier evidence',JSON.stringify(record.events.slice(0,before.events.length))===JSON.stringify(before.events));
  check('H20 Resumption binds new native connection identifiers',e.w.OpsAgent.getTarget()===null&&e.events.filter(e=>e.type==='approval').at(-1).sessionId==='native-reconnected');
  execution.resolve(output());await tick();e.close();
}
{
  let round=0;const e=env({model:()=>++round===1?reply(call('original')):reply(),exec:()=>{throw Error('transport lost');}});
  const first=await e.run();const record=e.fixture.records.get(first.sessionId),count=record.events.length;
  e.tab.session.host='different.invalid';
  const result=await e.resume(first.sessionId);
  check('H21 Wrong-machine recovery is rejected before model/native execution',result.status==='stopped'&&result.summary.includes('另一台机器')&&e.count('ai_agent_step')===1&&e.count('agent_exec')===1);
  check('H22 Rejected wrong-target recovery cannot modify original journal',record.events.length===count);e.close();
}
{
  const e=env();const first=await e.run();const record=e.fixture.records.get(first.sessionId),count=record.events.length;
  const result=await e.resume(first.sessionId);
  check('H23 Completed sessions are view-only and cannot silently re-execute',result.status==='error'&&record.events.length===count&&e.count('ai_agent_step')===1);
  const invalid=await e.resume(undefined);check('H24 Invalid recovery cannot start a fresh task',invalid.status==='error'&&e.fixture.records.size===1);e.close();
}
console.log(`\nAI harness controller: ${checks}/${checks} checks passed. Native/model services controlled.`);
