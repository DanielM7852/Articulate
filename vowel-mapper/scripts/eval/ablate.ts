/** Analysis-only copies generated from the current estimator; never imported by the app. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const dir=process.argv[2];
if(!dir) throw new Error('Usage: node scripts/eval/ablate.ts OUTPUT_DIRECTORY');
mkdirSync(dir,{recursive:true});
const source=readFileSync('src/audio/estimator.ts','utf8');
const mask='maskedF1 || maskedF2 || ';
if(source.split(mask).length!==2) throw new Error('Estimator changed: review ablation generation');
writeFileSync(resolve(dir,'without-masks.ts'),source.replace(mask,''));
writeFileSync(resolve(dir,'without-mask-f1.ts'),source.replace('maskedF1 || ',''));
writeFileSync(resolve(dir,'without-mask-f2.ts'),source.replace('maskedF2 || ',''));
// This is a naive third eligible pole, not a validated F3 estimator.
const validReturn='return { valid: true, f1: first.frequency, f2: second.frequency, confidence, rms, periodicity };';
if(!source.includes(validReturn)) throw new Error('Estimator changed: review F3 diagnostic');
writeFileSync(resolve(dir,'third-pole.ts'),source.replace(validReturn,`return { valid: true, f1: first.frequency, f2: second.frequency, confidence, rms, periodicity, candidateF3: poles.filter(({ frequency, bandwidth }) => frequency > 180 && frequency < 5000 && bandwidth > 15 && bandwidth < 600)[2]?.frequency };`));
console.log('Wrote analysis-only variants to',resolve(dir));
