/** Offline only. Node 24: node scripts/eval/run.ts --data-dir ... --out ... */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { estimateFormants as productionEstimator } from '../../src/audio/estimator.ts';
import { VowelTracker } from '../../src/audio/tracker.ts';
import { spectralCues } from '../../src/audio/cues.ts';
import { labelFrame, median, mixAtSnr, phoneGroup, readWav, referenceAt, type Phone, type Reference } from './core.ts';

type Clip={id:string;corpus:string;speaker:string;group:string;split:string;path:string;sha256:string;phones:Phone[];references?:Reference[]};
type Row={id:string;corpus:string;speaker:string;group:string;split:string;noise:string;phone:string;phoneGroup:string;timestampMs:number;raw:boolean;accepted:boolean;reason:string;f1?:number;f2?:number;rawF1?:number;rawF2?:number;candidateF3?:number;errorF3?:number;errorF1?:number;errorF2?:number;rawErrorF1?:number;rawErrorF2?:number;rms:number;periodicity:number;lowVsMidDb?:number;lowVsHighDb?:number;loudnessDb?:number;dropDb:number};
const args=process.argv.slice(2), option=(name:string)=>args[args.indexOf(name)+1];
if(!args.includes('--data-dir')||!args.includes('--out')) throw new Error('Required --data-dir PATH --out PATH');
const dataDir=resolve(option('--data-dir')), out=resolve(option('--out'));
const manifest=JSON.parse(readFileSync(resolve(dataDir,'manifest.json'),'utf8')) as {clips:Clip[];noise:string;noiseSha256:string};
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const estimator= args.includes('--estimator') ? (await import(pathToFileURL(resolve(option('--estimator'))).href)).estimateFormants as typeof productionEstimator : productionEstimator;
const noise=readWav(resolve(dataDir,manifest.noise)).samples;
if(hash(resolve(dataDir,manifest.noise))!==manifest.noiseSha256) throw new Error('Noise checksum mismatch');
const conditions=args.includes('--clean-only')?['clean']:['clean','20','15','10','5'];
const rows:Row[]=[], counts={allFrames:0,boundaryOrUnknown:0,overRangeSamples:0};
const clips=manifest.clips.filter(c=>!args.includes('--corpus') || c.corpus===option('--corpus'));
for (const [clipIndex,clip] of clips.entries()) {
  const path=resolve(dataDir,clip.path);
  if(hash(path)!==clip.sha256) throw new Error(`Checksum mismatch: ${clip.id}`);
  const {samples,rate}=readWav(path);
  let power=0,activeSamples=0;
  for(const p of clip.phones){
    if(!p.group&&!phoneGroup(p.phoneme)) continue;
    for(let i=Math.ceil(p.start*rate);i<Math.min(samples.length,Math.floor(p.end*rate));i++){power+=samples[i]**2;activeSamples++;}
  }
  const activeRms=Math.sqrt(power/activeSamples);
  if(!Number.isFinite(activeRms)||activeRms<=0) throw new Error(`Missing active speech: ${clip.id}`);
  const offset=Number.parseInt(createHash('sha256').update(clip.id).digest('hex').slice(0,8),16)%noise.length;
  for(const condition of conditions){
    const mixed=condition==='clean'?{samples,overRange:0}:mixAtSnr(samples,noise,Number(condition),activeRms,offset);
    counts.overRangeSamples+=mixed.overRange;
    const tracker=new VowelTracker(), levels:{time:number;rms:number}[]=[];
    let priorRms=0;
    for(let end=2400;end<=mixed.samples.length;end+=1200){
      const start=end-2400,frame=mixed.samples.subarray(start,end),time=end/rate*1000;
      const estimate=estimator(frame,rate), tracked=tracker.push(estimate,time);
      const candidateF3=(estimate as {candidateF3?:number}).candidateF3;
      counts.allFrames++;
      const dropDb=priorRms>0&&estimate.rms>0?20*Math.log10(estimate.rms/priorRms):0;
      priorRms=estimate.rms;
      while(levels.length&&levels[0].time<time-3000) levels.shift();
      if(estimate.valid||estimate.reason==='uncertain') levels.push({time,rms:estimate.rms});
      const phone=labelFrame(clip.phones,start/rate*1000,time);
      if(!phone){counts.boundaryOrUnknown++;continue;}
      const ref=clip.references?referenceAt(clip.references,time-25):null;
      const cue=condition==='clean'&&clip.corpus==='librispeech'&&(estimate.valid||estimate.reason==='uncertain')?spectralCues(frame,rate):null;
      const loudest=Math.max(...levels.map(v=>v.rms));
      rows.push({id:clip.id,corpus:clip.corpus,speaker:clip.speaker,group:clip.group,split:clip.split,noise:condition,phone:phone.phoneme,phoneGroup:phone.group,timestampMs:time,raw:estimate.valid,accepted:!!tracked.point,reason:tracked.status,
        ...(tracked.point?{f1:tracked.point.f1,f2:tracked.point.f2}:{}),
        ...(estimate.valid?{rawF1:estimate.f1,rawF2:estimate.f2}:{}),
        ...(ref&&tracked.point?{errorF1:Math.abs(tracked.point.f1-ref.f1),errorF2:Math.abs(tracked.point.f2-ref.f2)}:{}),
        ...(ref&&estimate.valid?{rawErrorF1:Math.abs(estimate.f1-ref.f1),rawErrorF2:Math.abs(estimate.f2-ref.f2)}:{}),
        ...(candidateF3?{candidateF3,...(ref&&ref.f3>0?{errorF3:Math.abs(candidateF3-ref.f3)}:{})}:{}),
        rms:estimate.rms,periodicity:estimate.periodicity,...cue,...(loudest>0&&estimate.rms>0?{loudnessDb:20*Math.log10(estimate.rms/loudest)}:{}),dropDb});
    }
  }
  if(clipIndex%20===0) console.log(`${clipIndex+1}/${clips.length}: ${clip.id}`);
}
function table(corpus:string,dimension:'group'|'phone'|'phoneGroup'){
  const lines=[`| Split | Noise dB | ${dimension} | Frames | Raw accepted | Tracked accepted | Error N | Median abs F1 / F2 Hz |`, '|---|---|---|---:|---:|---:|---:|---:|'];
  const groups=new Map<string,Row[]>();
  for(const row of rows.filter(r=>r.corpus===corpus)){
    const key=[row.split,row.noise,row[dimension]].join(' | ');
    if(!groups.has(key))groups.set(key,[]); groups.get(key)!.push(row);
  }
  const med=(r:Row[],key:'errorF1'|'errorF2')=>median(r.flatMap(v=>v[key]===undefined?[]:[v[key]!]))?.toFixed(1)??'—';
  for(const [key,r] of [...groups.entries()].sort()){
    const raw=r.filter(v=>v.raw).length,accepted=r.filter(v=>v.accepted).length;
    lines.push(`| ${key} | ${r.length} | ${raw} (${(100*raw/r.length).toFixed(1)}%) | ${accepted} (${(100*accepted/r.length).toFixed(1)}%) | ${r.filter(v=>v.errorF1!==undefined).length} | ${med(r,'errorF1')} / ${med(r,'errorF2')} |`);
  }
  return lines.join('\n');
}
mkdirSync(dirname(out),{recursive:true});
writeFileSync(out+'.frames.json.gz',gzipSync(JSON.stringify(rows)));
writeFileSync(out+'.json',JSON.stringify({estimatorSha256:hash(args.includes('--estimator')?resolve(option('--estimator')):resolve('src/audio/estimator.ts')),manifestSha256:hash(resolve(dataDir,'manifest.json')),clips:clips.map(({phones,references,...c})=>c),counts,conditions},null,2));
const note=`# ${args.includes('--label')?option('--label'):'Evaluation'}\n\n50 ms windows / 25 ms hops at 48 kHz, production estimateFormants + VowelTracker, default 5,500 Hz ceiling.\nOnly windows wholly inside a labeled phone are counted. References are linearly interpolated between original Hillenbrand 10–80% samples at frame centers. Errors condition on accepted frames with measurable reference F1/F2; lower acceptance can hide error. LibriSpeech has no formant truth (—).\n\nClips: ${clips.length}. Total analyzed frames: ${counts.allFrames}; excluded boundary/unknown frames: ${counts.boundaryOrUnknown}; mixed samples beyond ±1: ${counts.overRangeSamples}.\n\n`;
writeFileSync(out+'.md',note+'## Hillenbrand by speaker group\n\n'+table('hillenbrand','group')+'\n\n## Hillenbrand by vowel\n\n'+table('hillenbrand','phone')+'\n\n## LibriSpeech phone groups\n\n'+table('librispeech','phoneGroup')+'\n\n## LibriSpeech individual phones\n\n'+table('librispeech','phone')+'\n');
console.log(`Saved ${rows.length} labeled frame rows to ${out}.*`);
