/** Offline only. Node 24: node scripts/eval/model-path.ts --dir PATH --group men|women|boys|girls [--write] [--note TEXT]
 * Tracks the model voice's head-<take>.wav and uh-<take>.wav clips (or the save tool's articulate-head-… / articulate-uh-… files)
 * with the production estimator and tracker, builds the per-point log-median "head" path and its pass mark, and sizes the
 * model voice with the same "uh" + voice group rule as learners. --write regenerates src/reference/headModel.ts and copies
 * the closest take, trimmed to the word, to public/head-model.wav. */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { basename, resolve } from 'node:path';

// App modules are written for the bundler (extensionless imports, parameter properties).
register('./ts-hooks.mjs', import.meta.url);
const { estimateFormants } = await import('../../src/audio/estimator.ts');
const { VowelTracker } = await import('../../src/audio/tracker.ts');
const { holdValue } = await import('../../src/reference/check.ts');
const { VOICE_SIZE_V1 } = await import('../../src/reference/data.ts');
const { modelFromTakes, pathDistance, resamplePath, wordPath } = await import('../../src/game/head.ts');
const { uhFactor } = await import('../../src/game/targets.ts');
const { readWav } = await import('./core.ts');

type Formants = { f1: number; f2: number };
type Point = Formants & { timestampMs: number; segment: number };
type Group = keyof typeof VOICE_SIZE_V1.groupFactor;

const args = process.argv.slice(2), option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const dirArg = option('--dir'), group = option('--group') as Group | undefined;
if (!dirArg) throw new Error('Required --dir PATH');
if (!group || !(group in VOICE_SIZE_V1.groupFactor)) throw new Error(`Required --group ${Object.keys(VOICE_SIZE_V1.groupFactor).join('|')}`);
const dir = resolve(dirArg), note = option('--note');
const root = resolve(import.meta.dirname, '../..');

function track(path: string): Point[] {
  const { samples, rate } = readWav(path);
  const tracker = new VowelTracker(), points: Point[] = [];
  // Same 50 ms window and 25 ms hop as the browser worker and scripts/eval/run.ts.
  for (let end = 2400; end <= samples.length; end += 1200) {
    const tracked = tracker.push(estimateFormants(samples.subarray(end - 2400, end), rate), end / rate * 1000);
    if (tracked.point) points.push(tracked.point);
  }
  return points;
}

const files = readdirSync(dir).filter((n) => /^(?:articulate-)?(head|uh)-.+\.wav$/.test(n)).sort();
const kind = (name: string) => name.match(/^(?:articulate-)?(head|uh)-/)![1];

const heads = files.filter((n) => kind(n) === 'head').map((name) => {
  const word = wordPath(track(resolve(dir, name)));
  return { name, word, points: word.length, ms: word.length ? word.at(-1)!.timestampMs - word[0].timestampMs : 0, path: resamplePath(word) };
});
const uhs = files.filter((n) => kind(n) === 'uh').map((name) => {
  const value = holdValue(track(resolve(dir, name)));
  return { name, value: value && { f1: value.f1, f2: value.f2 } };
});

const measured = heads.filter((h) => h.path) as (typeof heads[number] & { path: Formants[] })[];
const uhValues = uhs.flatMap((u) => u.value ? [u.value] : []);
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const uh = uhValues.length ? { f1: Math.exp(med(uhValues.map((v) => Math.log(v.f1)))), f2: Math.exp(med(uhValues.map((v) => Math.log(v.f2)))) } : null;

if (measured.length < 3 || !uh) {
  for (const h of heads) console.log(`head ${h.name}: ${h.path ? 'ok' : 'missed'} (${h.points} pts, ${Math.round(h.ms)} ms)`);
  for (const u of uhs) console.log(`uh   ${u.name}: ${u.value ? `${Math.round(u.value.f1)}/${Math.round(u.value.f2)} Hz` : 'missed'}`);
  console.log(`WARNING: need ≥3 measured head takes (have ${measured.length}) and ≥1 measured uh (have ${uhValues.length}).`);
  process.exit(1);
}

const model = modelFromTakes(measured.map((h) => h.path));
const median = model.path.map(([f1, f2]) => ({ f1: Math.exp(f1), f2: Math.exp(f2) }));
const distances = new Map(measured.map((h) => [h.name, pathDistance(h.path, median)]));
const best = measured.reduce((a, b) => distances.get(a.name)! <= distances.get(b.name)! ? a : b);
const factor = uhFactor(uh, group);

console.log('take'.padEnd(44), 'points', ' ms  ', 'to median (radii)');
for (const h of heads) {
  const d = distances.get(h.name);
  console.log(h.name.padEnd(44), String(h.points).padStart(6), String(Math.round(h.ms)).padStart(5), d === undefined ? ' missed' : ` ${d.toFixed(3)}${h === best ? '  ← best' : ''}`);
}
for (const u of uhs) console.log(u.name.padEnd(44), u.value ? `uh ${Math.round(u.value.f1)}/${Math.round(u.value.f2)} Hz` : 'uh missed');
console.log(`uh ${Math.round(uh.f1)}/${Math.round(uh.f2)} Hz · group ${group} · factor ${factor.toFixed(3)}`);
console.log(`spread ${model.spread.map((s) => s.toFixed(3)).join(' ')} · threshold ${model.threshold.toFixed(3)} radii · path ${Math.round(median[0].f1)}/${Math.round(median[0].f2)} → ${Math.round(median.at(-1)!.f1)}/${Math.round(median.at(-1)!.f2)} Hz`);

/** The best take cut to its tracked word plus 150 ms each side, with 10 ms fades. A point's timestamp is the end of its 50 ms window. */
function trimmed(name: string, word: Point[]) {
  const { samples, rate } = readWav(resolve(dir, name));
  const ms = (t: number) => Math.round(t / 1000 * rate);
  const start = Math.max(0, ms(word[0].timestampMs - 50 - 150)), end = Math.min(samples.length, ms(word.at(-1)!.timestampMs + 150));
  const fade = ms(10), cut = samples.slice(start, end).map((v, i, all) => v * Math.min(1, i / fade, (all.length - 1 - i) / fade));
  const wav = Buffer.alloc(44 + cut.length * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + cut.length * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(cut.length * 2, 40);
  cut.forEach((v, i) => wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return { wav, leadMs: Math.round(word[0].timestampMs - start / rate * 1000) };
}

if (args.includes('--write')) {
  const pair = (a: number, b: number, dp: number) => `[${a.toFixed(dp)}, ${b.toFixed(dp)}]`;
  const audio = trimmed(best.name, best.word);
  const body = [
    `  id: 'head-model-voice', version: 1, word: 'head', takes: ${measured.length},`,
    `  path: [${model.path.map(([f1, f2]) => pair(f1, f2, 5)).join(', ')}],`,
    `  factor: ${factor.toFixed(5)}, threshold: ${model.threshold.toFixed(4)},`,
    `  spread: [${model.spread.map((x) => x.toFixed(4)).join(', ')}],`,
    `  group: '${group}', uh: [${Math.round(uh.f1)}, ${Math.round(uh.f2)}], bestTake: '${basename(best.name)}',`,
    `  durationMs: ${Math.round(best.ms)}, audioLeadMs: ${audio.leadMs},`,
  ].join('\n');
  writeFileSync(resolve(root, 'src/reference/headModel.ts'), [
    `// Generated by scripts/eval/model-path.ts from ${measured.length} takes. Do not edit by hand.`,
    ...(note ? [`// ${note}`] : []),
    `import type { HeadModel } from '../game/head';`,
    '',
    '/** One model voice saying "head", measured by this tracker; natural-log Hz. Sized to each learner by one voice multiplier. */',
    `export const HEAD_MODEL_V1 = {\n${body}\n} as const;`,
    'HEAD_MODEL_V1 satisfies HeadModel;',
    '',
  ].join('\n'));
  mkdirSync(resolve(root, 'public'), { recursive: true });
  writeFileSync(resolve(root, 'public/head-model.wav'), audio.wav);
  console.log(`wrote src/reference/headModel.ts and public/head-model.wav (${best.name}, trimmed to the word)`);
}
