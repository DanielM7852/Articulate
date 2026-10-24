/** Offline only. Node 24: node scripts/eval/reference-voice.ts --dir PATH [--learner-factor -0.2]
 * Tracks <word>-<take>.wav clips (head, had, heard, see, spa) with the production estimator and tracker,
 * sizes that voice from head/had/heard, and reports how far its ee and ah sit from the pooled reference. */
import { readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { estimateFormants } from '../../src/audio/estimator.ts';
import { VowelTracker } from '../../src/audio/tracker.ts';
import { distance, factorFrom, holdValue } from '../../src/reference/check.ts';
import { readWav } from './core.ts';

const args = process.argv.slice(2), option = (name: string) => args[args.indexOf(name) + 1];
if (!args.includes('--dir')) throw new Error('Required --dir PATH');
const dir = resolve(option('--dir'));
const learner = args.includes('--learner-factor') ? Number(option('--learner-factor')) : null;

type Formants = { f1: number; f2: number };
const clips: Record<string, { take: string; count: number; value: Formants | null }[]> = {};
for (const name of readdirSync(dir).filter((n) => /^[a-z]+-[\d.]+\.wav$/.test(n)).sort()) {
  const [word, take] = name.replace(/\.wav$/, '').split('-');
  const { samples, rate } = readWav(resolve(dir, name));
  const tracker = new VowelTracker(), points: Formants[] = [];
  // Same 50 ms window and 25 ms hop as the browser worker and scripts/eval/run.ts.
  for (let end = 2400; end <= samples.length; end += 1200) {
    const tracked = tracker.push(estimateFormants(samples.subarray(end - 2400, end), rate), end / rate * 1000);
    if (tracked.point) points.push({ f1: tracked.point.f1, f2: tracked.point.f2 });
  }
  const value = holdValue(points);
  (clips[word] ??= []).push({ take, count: points.length, value: value && { f1: value.f1, f2: value.f2 } });
}

const logMedian = (values: Formants[]) => {
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  return values.length ? { f1: Math.exp(med(values.map((v) => Math.log(v.f1)))), f2: Math.exp(med(values.map((v) => Math.log(v.f2)))) } : null;
};
const word = (w: string) => logMedian((clips[w] ?? []).flatMap((c) => c.value ? [c.value] : []));
const calibration = (['head', 'had', 'heard'] as const).map((w, i) => ({ vowel: (['eh', 'ae', 'er'] as const)[i], value: word(w) }));
const factor = calibration.every((c) => c.value) ? factorFrom(calibration.map((c) => ({ vowel: c.vowel, value: c.value! }))) : null;
const see = word('see'), spa = word('spa');
const result = {
  clips,
  words: Object.fromEntries(['head', 'had', 'heard', 'see', 'spa'].map((w) => [w, word(w)])),
  voiceFactor: factor,
  // Distance in reference radii between this voice's vowel and the pooled reference, both sized to this voice.
  // The same number holds for any learner: one multiplier moves both targets together.
  eeFromPooled: factor !== null && see ? distance(see, 'iy', factor) : null,
  ahFromPooled: factor !== null && spa ? distance(spa, 'ah', factor) : null,
  learnerTargets: learner !== null && factor !== null && see && spa ? {
    ee: { f1: see.f1 * Math.exp(learner - factor), f2: see.f2 * Math.exp(learner - factor) },
    ah: { f1: spa.f1 * Math.exp(learner - factor), f2: spa.f2 * Math.exp(learner - factor) },
  } : null,
};
writeFileSync(resolve(dir, 'reference-voice.json'), JSON.stringify(result, null, 1));
for (const [w, takes] of Object.entries(clips)) {
  console.log(w.padEnd(6), takes.map((t) => `${t.take}: ${t.value ? `${Math.round(t.value.f1)}/${Math.round(t.value.f2)}` : 'missed'} (${t.count} pts)`).join('  '));
}
console.log(`voice factor ${factor?.toFixed(3) ?? '—'} · ee ${result.eeFromPooled?.toFixed(2) ?? '—'} · ah ${result.ahFromPooled?.toFixed(2) ?? '—'} radii from the pooled reference`);
