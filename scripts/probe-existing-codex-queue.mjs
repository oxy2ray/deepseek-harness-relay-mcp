#!/usr/bin/env node
// Operator P0 probe, not a Relay RPC client. Creates two read-only test threads.
// Uses a real model for three tiny turns; attach a remote TUI at attach_primary,
// then press Enter here. Never targets an existing user thread or changes daemon settings.
import {CodexDaemonClient,createCodexUnixWebSocketTransport} from '../src/wake/codex-daemon-client.ts';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {createInterface} from 'node:readline';
const args=Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2],process.argv[3+i*2]]));
if(!args['--root']||!args['--socket']||!args['--model'])throw Error('Usage: node --import tsx scripts/probe-existing-codex-queue.mjs --root ABSOLUTE_TEST_ROOT --socket UNIX_SOCKET --model DISCOVERED_MODEL');
const root=resolve(args['--root'])+'/';
await mkdir(root+'workspace',{recursive:true});
const socket=args['--socket'];
const make=async()=>{const c=new CodexDaemonClient({transport:createCodexUnixWebSocketTransport({socket}),requestTimeoutMs:15000});await c.initialize();return c;};
const c=await make();const w=await make();
const events=[];for(const [name,x]of [['main',c],['witness',w]])x.onNotification(n=>{events.push({name,...n});});
const wait=async(pred,ms=120000)=>{const start=Date.now();while(Date.now()-start<ms){const hit=events.find(pred);if(hit)return hit;await new Promise(r=>setTimeout(r,50));}throw Error('notification timeout');};
const req=(m,p)=>c.request(m,p);
const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
const threads=[];const report={context:[],checks:{},threads};
try{
for(let i=0;i<2;i++){
 const r=await req('thread/start',{cwd:root+'workspace',model:args['--model'],approvalPolicy:'on-request',sandbox:'read-only',config:{mcp_servers:{'mcp-thread-context-probe':{command:process.execPath,args:[new URL('../tests/fixtures/mcp-thread-context-probe.mjs',import.meta.url).pathname]}}}});
 const id=r.thread.id;threads.push(id);
 const p=await req('mcpServer/tool/call',{threadId:id,server:'mcp-thread-context-probe',tool:'codex_thread_context_probe',arguments:{}});
 const data=JSON.parse(p.content.find(x=>x.type==='text').text);
 report.context.push({threadId:id,metaThreadId:data.metaThreadId,envThreadId:data.codexThreadId});
 if(data.metaThreadId!==id)throw Error('host meta binding mismatch');
}
const id=threads[0];await req('thread/resume',{threadId:id,excludeTurns:true}).catch(()=>{});
const seed=await req('turn/start',{threadId:id,input:[{type:'text',text:'只回复P0_READY'}],effort:'low'});
await wait(e=>e.method==='turn/completed'&&e.params?.turn?.id===seed.turn.id);
await w.request('thread/resume',{threadId:id,excludeTurns:true});
emit({phase:'attach_primary',threadId:id,context:report.context});
await new Promise(resolve=>{const input=createInterface({input:process.stdin});input.once('line',()=>{input.close();resolve();});});
const A='QPA'+randomUUID().replaceAll('-','').slice(0,12).toUpperCase();
const B='QPB'+randomUUID().replaceAll('-','').slice(0,12).toUpperCase();report.markers={A,B};
const add=async(text,key)=>req('thread/queue/add',{threadId:id,input:[{type:'text',text}],clientUserMessageId:key});
const a=await add('Call codex_queue_probe_wait exactly once, then reply exactly '+A,randomUUID());
try{await req('thread/queue/start',{threadId:id,queuedSubmissionId:a.queuedSubmission.id});}catch{} // TUI may win
const busy=await wait(e=>e.method==='item/started'&&e.params?.threadId===id&&e.params?.item?.type==='mcpToolCall'&&e.params.item.tool==='codex_queue_probe_wait');
report.checks.busyToolObserved=true;
const b=await add('Reply exactly '+B,randomUUID());
try{await req('thread/queue/start',{threadId:id,queuedSubmissionId:b.queuedSubmission.id});throw Error('busy admitted');}
catch(e){if(e.message==='busy admitted')throw e;report.checks.busyRejected=e.code===-32600;if(!report.checks.busyRejected)throw e;}
const queue=await req('thread/queue/list',{threadId:id});
report.checks.busyRetained=queue.data.some(x=>x.id===b.queuedSubmission.id);
if(!report.checks.busyRetained)throw Error('B not retained');
await wait(e=>e.method==='item/completed'&&e.params?.item?.type==='agentMessage'&&e.params.item.text.includes(B));
const doneB=events.find(e=>e.method==='item/completed'&&e.params?.item?.type==='agentMessage'&&e.params.item.text.includes(B));
await wait(e=>e.method==='turn/completed'&&e.params?.turn?.id===doneB.params.turnId);
report.checks.witnessReceived=events.some(e=>e.name==='witness'&&e.method==='item/completed'&&e.params?.item?.type==='agentMessage'&&e.params.item.text.includes(B));
const reconnect=await make();
try{
 const history=await reconnect.request('thread/read',{threadId:id,includeTurns:true});
 const count=marker=>history.thread.turns.filter(t=>t.items.some(i=>i.type==='agentMessage'&&i.text===marker)).length;
 report.checks.markerAOnce=count(A)===1;report.checks.markerBOnce=count(B)===1;report.checks.persistedAfterReconnect=true;
}finally{await reconnect.close();}
emit({phase:'complete',...report});
if(!Object.values(report.checks).every(Boolean))throw Error('P0 check failed');
} catch(e){report.error=e.message;emit({phase:'failed',...report});process.exitCode=1;}
finally{await writeFile(root+'report.json',JSON.stringify(report,null,2),{mode:0o600});await c.close();await w.close();}

