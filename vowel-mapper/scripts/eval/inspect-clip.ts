/** Offline only. Node 24: node scripts/eval/inspect-clip.ts FILE.wav
 * Runs the production estimator at several LPC ceilings over the middle of a held-vowel clip, to separate a
 * speaker's vowel from an estimator artefact (e.g. a spurious pole in the wide F1–F2 gap of a low voice's "ee"). */
import { DEFAULT_SETTINGS, estimateFormants } from '../../src/audio/estimator.ts';
import { readWav } from './core.ts';

const file = process.argv[2];
if (!file) throw new Error('Usage: inspect-clip.ts FILE.wav');
const { samples, rate } = readWav(file);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };
const from = Math.floor(samples.length * 0.2), to = Math.floor(samples.length * 0.8);
for (const [ceilingHz, harmonicEnvelope] of [4000, 4500, 5000, 5500, 6000].flatMap((c) => [[c, false], [c, true]] as const)) {
  const f1: number[] = [], f2: number[] = [];
  let frames = 0;
  for (let end = from + 2400; end <= to; end += 1200, frames++) {
    const e = estimateFormants(samples.subarray(end - 2400, end), rate, { ...DEFAULT_SETTINGS, ceilingHz, harmonicEnvelope });
    if (e.valid) { f1.push(e.f1); f2.push(e.f2); }
  }
  console.log(`${harmonicEnvelope ? 'harmonic' : 'burg    '} ceiling ${ceilingHz}${ceilingHz === DEFAULT_SETTINGS.ceilingHz ? ' (app default)' : ''}: valid ${f1.length}/${frames} · F1 ${Math.round(median(f1))} · F2 ${Math.round(median(f2))} Hz`);
}
