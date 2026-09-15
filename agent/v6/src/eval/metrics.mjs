import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function evalMetrics(dir = process.env.EVAL_DIR || '/evals') {
  let files; try { files=await readdir(dir); } catch { return ''; }
  const latest=new Map();
  for(const file of files.filter(f=>f.endsWith('.json'))) {
    try {
      const run=JSON.parse(await readFile(join(dir,file),'utf8'));
      if(!run.finishedAt)continue;
      for(const model of run.models) {
        const key=JSON.stringify([model,run.mode,run.datasetHash,run.promptHash,run.graderVersion,run.harnessHash]);
        if(!latest.has(key) || latest.get(key).run.finishedAt<run.finishedAt) latest.set(key,{run,model});
      }
    }catch{/* Incomplete or corrupt artifacts must not break monitoring. */}
  }
  const lines=[];
  for(const {run,model} of latest.values()) {
    const labels=Object.entries({model,mode:run.mode,suite:run.datasetHash,prompt:run.promptHash,grader:run.graderVersion,harness:run.harnessHash}).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join(',');
    lines.push(`agent_eval_last_run_timestamp_seconds{${labels}} ${Date.parse(run.finishedAt)/1000}`);
    lines.push(`agent_eval_run_complete{${labels}} ${run.complete?1:0}`);
    const summary=run.summaries[model];
    if(!summary?.cases)continue;
    // Only a complete paired run is eligible for quality comparisons.
    if(run.complete) for(const [key,name] of [['score','score'],['passRate','pass_rate'],['latencyMs','latency_ms'],['errorRate','error_rate'],['tokens','tokens'],['costCoverage','cost_coverage']]) {
      if(Number.isFinite(summary[key]))lines.push(`agent_eval_${name}{${labels}} ${summary[key]}`);
    }
    if(run.complete && summary.costCoverage===1)lines.push(`agent_eval_cost_usd{${labels}} ${summary.costUsd}`);
  }
  return lines.join('\n')+'\n';
}
