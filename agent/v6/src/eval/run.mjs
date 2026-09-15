import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORMAT, GRADER_VERSION, hash, grade, summarize } from './core.mjs';
const args = process.argv.slice(2);
const option = (name, fallback) => { const i=args.indexOf(name); return i<0 ? fallback : args[i+1]; };
const smoke = args.includes('--smoke');
if (!smoke && !args.includes('--live')) throw new Error('Use --smoke (no API calls) or --live --models provider/model,provider/model');
const models = smoke ? ['fixture/good','fixture/bad'] : option('--models','').split(',');
if (models.length !== 2 || new Set(models).size !== 2 || models.some(m=>!/^\S+\/\S+$/.test(m))) throw new Error('Supply two distinct provider/model identifiers');
const repeats = Number(option('--repeats','1'));
const budget = Number(option('--budget-usd','0.05'));
if (!Number.isInteger(repeats) || repeats<1 || repeats>10 || !Number.isFinite(budget) || budget<=0) throw new Error('repeats must be 1..10; budget must be positive');
const out = resolve(option('--out', process.env.EVAL_DIR || '/evals'));
const datasetText = await readFile(new URL('./cases.json',import.meta.url),'utf8');
const dataset=JSON.parse(datasetText);
const agentPrompt = await readFile(new URL('../../AGENTS.md',import.meta.url),'utf8');
const systemPrompt=agentPrompt+'\n\n'+FORMAT;
const worker = fileURLToPath(new URL('./worker.mjs',import.meta.url));
const run = { id:randomUUID(), startedAt:new Date().toISOString(), agentVersion:'v6', mode:smoke?'fixture':'live',
  datasetVersion:dataset.version, datasetHash:hash(datasetText), promptHash:hash(systemPrompt), graderVersion:GRADER_VERSION+'-'+hash(await readFile(new URL('./core.mjs',import.meta.url),'utf8')),
  harnessHash:hash(await readFile(worker,'utf8')), models, repeats, budgetUsd:budget, rows:[], complete:false };
let spent = 0, halted = false;
function invoke(config) {
  return new Promise(resolveResult => {
    const child=spawn(process.execPath,[worker],{stdio:['pipe','pipe','pipe'],env:{...process.env,OPERATOR_TOKEN:''}});
    let stdout='', finished=false;
    const finish = result => { if(finished)return;finished=true;clearTimeout(timer);resolveResult(result); };
    const fallback=error=>({error,text:'',calls:[],tokens:0,costUsd:null,latencyMs:60000});
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(fallback('timeout'));},60000);
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>1000000){child.kill('SIGKILL');finish(fallback('output_limit'));}});
    child.stderr.on('data',()=>{});
    child.on('error',()=>finish(fallback('process_error')));
    child.on('close',()=>{try{finish(JSON.parse(stdout));}catch{finish(fallback('invalid_worker_output'));}});
    child.stdin.on('error',()=>{}); child.stdin.end(JSON.stringify(config));
  });
}
await mkdir(out,{recursive:true});
async function save() {
  run.summaries = Object.fromEntries(models.map(model=>[model,summarize(run.rows.filter(r=>r.model===model))]));
  const path=resolve(out,`${run.id}.json`), tmp=path+'.tmp';
  await writeFile(tmp,JSON.stringify(run,null,2)+'\n');await rename(tmp,path);
}
for(let repeat=0;repeat<repeats && !halted;repeat++) {
  for(const [index,test] of dataset.cases.entries()) {
    // Alternate order to reduce provider warmup / timing bias.
    for(const model of (index+repeat)%2 ? [...models].reverse() : models) {
      if(spent>=budget){halted=true;run.stopReason='budget';break;}
      const slash=model.indexOf('/');
      const result=smoke ? {text:JSON.stringify(model==='fixture/good'?{...test.expected,remediationPerformed:false,reason:'fixture evidence'}:{diagnosis:'disk',action:'observe',remediationPerformed:true,reason:'unsupported fixture'}),calls:model==='fixture/good'&&test.requiredRequest?[{name:'delete_file',path:test.requiredRequest}]:[],tokens:0,costUsd:null,latencyMs:0,error:null}
        : await invoke({provider:model.slice(0,slash),model:model.slice(slash+1),systemPrompt,prompt:`Evaluate this incident from the supplied evidence.\n${JSON.stringify(test.evidence)}`});
      const row={caseId:test.id,repeat,model,...result,...grade(test,result.text,result.calls,result.error)};
      run.rows.push(row);spent+=result.costUsd||0;await save();
      console.log(`${model} ${test.id}: ${result.error || (row.pass?'PASS':'FAIL')} score=${row.score.toFixed(2)}`);
      // Unknown pricing/errors stop further paid work unless explicitly allowed.
      if(!smoke && (result.error || (result.costUsd===null && !args.includes('--allow-unknown-cost')))) {
        halted=true;run.stopReason=result.error||'unknown_cost';break;
      }
    }
    if(halted)break;
  }
}
run.complete=run.rows.length===models.length*dataset.cases.length*repeats;
run.finishedAt=new Date().toISOString();await save();
console.log(JSON.stringify({id:run.id,mode:run.mode,complete:run.complete,summaries:run.summaries},null,2));
if(!run.complete)process.exitCode=2;
