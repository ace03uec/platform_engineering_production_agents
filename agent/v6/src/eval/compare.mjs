import { readFile } from 'node:fs/promises';
const files=process.argv.slice(2);
if(files.length<1 || files.length>2)throw new Error('Usage: compare.mjs RUN.json [BASELINE.json]');
const runs=await Promise.all(files.map(async f=>JSON.parse(await readFile(f,'utf8'))));
if(runs.some(r=>!r.complete))throw new Error('Cannot rank models using incomplete runs');
if(runs.length===2 && ['datasetHash','promptHash','graderVersion','harnessHash','mode'].some(k=>runs[0][k]!==runs[1][k]))throw new Error('Incompatible evaluation versions/modes; do not treat this as a regression comparison');
for(const run of runs) {
 console.log(`${run.id} ${run.finishedAt} mode=${run.mode}`);
 console.table(Object.entries(run.summaries).map(([model,s])=>({model,...s})));
}
if(runs.length===2) {
 console.log('Latest minus baseline (descriptive only, not a significance test):');
 console.table(runs[0].models.filter(m=>runs[1].summaries[m]).map(model=>({model,
  scoreDelta:runs[0].summaries[model].score-runs[1].summaries[model].score,
  passRateDelta:runs[0].summaries[model].passRate-runs[1].summaries[model].passRate})));
}
