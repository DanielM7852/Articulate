#!/usr/bin/env python3
"""Summarise deterministic frame outputs. Diagnostic gates never change runtime."""
import argparse,collections,gzip,json,pathlib,statistics,itertools
p=argparse.ArgumentParser();p.add_argument('--data-dir',required=True);p.add_argument('--out',required=True);a=p.parse_args()
root=pathlib.Path(a.data_dir);out=pathlib.Path(a.out);out.mkdir(parents=True,exist_ok=True)
load=lambda name:json.load(gzip.open(root/(name+'.frames.json.gz')))
base=load('baseline')

def med(rows,key):
 v=[x[key] for x in rows if key in x]
 return round(statistics.median(v),1) if v else '—'

def summary(rows):
 return f"{len(rows)} | {100*sum(x['accepted'] for x in rows)/len(rows):.1f}% | {med(rows,'errorF1')} / {med(rows,'errorF2')}"

lines=['# Real-speech evaluation decision','',
'No production estimator, tracking threshold, or nasal gate changed. The offline study found substantial consonant leakage, and the candidate nasal rule did not meet the development criterion. The opt-in UI is a scripted representation preview only.','',
'## Held-out baseline (and unchanged runtime after this work)','',
'All percentages below use eligible full-window frames as denominator. These are descriptive frame-weighted results from small speaker samples, not independent-frame statistical confidence estimates.','',
'| Source | Noise dB | Group | Eligible frames | Tracked acceptance | Median absolute F1 / F2 error Hz |','|---|---|---|---:|---:|---:|']
for corpus in ['hillenbrand','librispeech']:
 for noise in ['clean','20','15','10','5']:
  for group in (['vowel'] if corpus=='hillenbrand' else ['vowel','nasal','voiced-fricative','unvoiced-fricative','stop','glide-liquid']):
   rows=[x for x in base if x['corpus']==corpus and x['noise']==noise and x['phoneGroup']==group and x['split']=='heldout']
   lines.append(f"| {'H95 exploratory' if corpus=='hillenbrand' else 'LibriSpeech'} | {noise} | {group} | {summary(rows)} |")
lines+=['','Hillenbrand is supplementary/exploratory because the authorised mirror has a repository MIT licence, but the original audio has no separately stated licence in the archived readme. LibriSpeech and DEMAND have explicit corpus licences. Error cells are conditional on acceptance and measurable reference values; LibriSpeech has no F1/F2 truth. Rejection can lower apparent error by excluding difficult frames.','']
# Evaluate a simple upper-bound post-tracker filter. Select using development ONLY.
clean=[x for x in base if x['corpus']=='librispeech' and x['noise']=='clean' and x['accepted']]
def gate(x,t):
 mid,high,level=t
 return x.get('lowVsMidDb',-999)>mid and x.get('lowVsHighDb',-999)>high and x.get('loudnessDb',999)<=level

def removed(split,group,t):
 rows=[x for x in clean if x['split']==split and x['phoneGroup']==group]
 return sum(gate(x,t) for x in rows),len(rows)

candidates=[]
for t in itertools.product([-99,0,5,10,15,20],[-99,5,10,15,20,25,30],[0,-3,-6,-9,-12,-15,-18]):
 nv,v=removed('development','vowel',t);nn,n=removed('development','nasal',t)
 if nv/v<=.05:candidates.append((nn/n,-nv/v,t))
chosen=max(candidates)[2]
lines+=['## Nasal rejection experiment — not shipped','',
'The development screen required at least 70% removal of already accepted nasal frames and at most 5% removal of already accepted vowel frames. None of 294 combinations met both. The held-out table reports the development-selected maximum nasal removal among rules within the vowel-loss budget; held-out values did not select the rule. This is an optimistic post-tracker analysis, not a deployed detector or a full rerun of tracker acquisition under a gate.','',
f'Selected diagnostic rule: low/mid > {chosen[0]} dB, low/high > {chosen[1]} dB, level relative to loudest voiced frame in 3 s ≤ {chosen[2]} dB. Thresholds and budget are provisional engineering screening choices, not speech-science constants.','',
'| Split | Phone group | Baseline accepted | Removed by candidate | Removed fraction |','|---|---|---:|---:|---:|']
for split in ['development','heldout']:
 for group in ['vowel','nasal','voiced-fricative','unvoiced-fricative','stop','glide-liquid']:
  n,total=removed(split,group,chosen)
  lines.append(f'| {split} | {group} | {total} | {n} | {100*n/total:.1f}% |')
lines+=['','The band cues overlap: quiet/back vowels can be removed and many nasals survive. Loudness alone is also confounded by ordinary vowel level variation. No consonant-identification claim is justified. The r/w/l/y group has acoustic transitions useful for glide exercises, but is not a categorical vowel label.','']
# Word-initial/post-vowel contexts from published alignment metadata (not runtime oracle).
source=json.loads((root/'librispeech-source-rows.json').read_text());metadata={x['row']['id']:x['row'] for x in source}
lines+=['### Candidate confounders (held-out, clean)','', '| Context | Baseline accepted frames | Candidate removes |','|---|---:|---:|']
contexts=collections.defaultdict(list)
for x in clean:
 if x['split']!='heldout':continue
 row=metadata[x['id']];time=x['timestampMs']/1000-.025
 phone=next(p for p in row['phonemes'] if p['start']<=time<=p['end'])
 if x['phoneGroup']=='nasal':
  initial=any(abs(w['start']-phone['start'])<.011 for w in row['words'])
  contexts['word-initial nasal' if initial else 'other nasal'].append(x)
 if x['phoneGroup']=='vowel':
  contexts['unstressed vowel' if x['phone'].endswith('0') else 'stressed vowel'].append(x)
  if x['loudnessDb']<-12:contexts['vowel >12 dB below recent peak'].append(x)
for name,rows in contexts.items():lines.append(f'| {name} | {len(rows)} | {sum(gate(x,chosen) for x in rows)} ({100*sum(gate(x,chosen) for x in rows)/len(rows):.1f}%) |')
lines+=['','Word starts and stress derive from automatic alignments; no claim of hand-verified onset timing. Fading-out and word-initial murmurs need targeted recordings beyond this convenience sample.','']
if (root/'without-masks.frames.json.gz').exists():
 ablated=load('without-masks');key=lambda x:(x['id'],x['noise'],x['timestampMs']);lookup={key(x):x for x in base}
 lines+=['## Existing masking gates: ablation, not a shipped change','',
 'Both maskedF1 and maskedF2 were removed in an analysis-only generated copy of the actual estimator. No other computation changed. The comparison below includes all speaker splits; the gates were not retuned.','',
 '| Source | Noise | Baseline tracked % | Without masks tracked % | Baseline median errors | Without masks median errors | Additional raw accepted | Their median raw errors | Gross-error pairs / measured pairs |','|---|---|---:|---:|---:|---:|---:|---:|---:|']
 for corpus in ['hillenbrand','librispeech']:
  for noise in ['clean','20','15','10','5']:
   b=[x for x in base if x['corpus']==corpus and x['noise']==noise and x['phoneGroup']=='vowel'];v=[x for x in ablated if x['corpus']==corpus and x['noise']==noise and x['phoneGroup']=='vowel']
   new=[x for x in v if x['raw'] and not lookup[key(x)]['raw']]
   lines.append(f"| {corpus} | {noise} | {100*sum(x['accepted'] for x in b)/len(b):.1f} | {100*sum(x['accepted'] for x in v)/len(v):.1f} | {med(b,'errorF1')} / {med(b,'errorF2')} | {med(v,'errorF1')} / {med(v,'errorF2')} | {len(new)} | {med(new,'rawErrorF1')} / {med(new,'rawErrorF2')} | {sum(x.get('rawErrorF1',0)>150 or x.get('rawErrorF2',0)>250 for x in new)} / {sum('rawErrorF1' in x for x in new)} |")
 lines+=['','A gross-error pair here means F1 absolute error >150 Hz or F2 >250 Hz (a descriptive engineering cutoff). The extra raw clean H95 frames include large errors as well as accurate recoveries. Both gates therefore remain unchanged; a higher acceptance rate alone is not enough. These measurements expose the coverage/error trade-off. No extra accepted LibriSpeech frame can be called accurate because that corpus lacks formant ground truth.','']
lines+=['## Clean H95 gate attribution','', '| Ablation | Additional raw accepted | Median raw absolute F1 / F2 error Hz | Gross-error pairs / measured pairs |','|---|---:|---:|---:|']
for name in ['without-mask-f1','without-mask-f2']:
 if not (root/(name+'.frames.json.gz')).exists():continue
 rows=load(name);lookup={(x['id'],x['timestampMs']):x for x in base if x['noise']=='clean'}
 new=[x for x in rows if x['corpus']=='hillenbrand' and x['raw'] and not lookup[(x['id'],x['timestampMs'])]['raw']]
 lines.append(f"| {name} | {len(new)} | {med(new,'rawErrorF1')} / {med(new,'rawErrorF2')} | {sum(x.get('rawErrorF1',0)>150 or x.get('rawErrorF2',0)>250 for x in new)} / {sum('rawErrorF1' in x for x in new)} |")
lines+=['','The 0.55 F2 masking rule is not universally harmless to real front vowels; it excludes accurate examples as well as preventing gross relabelling. Changing it safely needs a larger benchmark and a discriminating feature, not a relaxed threshold chosen from these few speakers.','']
if (root/'third-pole.frames.json.gz').exists():
 rows=load('third-pole');lines+=['## F3 diagnostic — no display shipped','',
 'A generated analysis-only copy returns the third pole passing the existing bandwidth/frequency filter. This is deliberately a naive candidate, not an F3 label. Measured only on clean H95, not on independently annotated r/w.','',
 '| Held-out group | Eligible frames | F3 error pairs | Median absolute error Hz | 90th percentile Hz | Error >300 Hz |','|---|---:|---:|---:|---:|---:|']
 for group in ['men','women','boys','girls']:
  a=[x for x in rows if x['split']=='heldout' and x['group']==group];e=sorted(x['errorF3'] for x in a if 'errorF3' in x)
  lines.append(f'| {group} | {len(a)} | {len(e)} | {statistics.median(e):.1f} | {e[int(len(e)*.9)]:.1f} | {100*sum(v>300 for v in e)/len(e):.1f}% |')
 lines+=['','The long error tail and absent r/w-specific truth do not support shipping an F3 display or a universal r threshold.','']
(out/'decision.md').write_text('\n'.join(lines)+'\n')
print('Wrote',out/'decision.md')
