import { REFERENCE_V1 } from './data';

export type CalibrationVowel = 'eh' | 'ae' | 'er';
export type TargetVowel = 'iy' | 'ah';
export type Location = 'quiet' | 'hall';
type Formants = { f1: number; f2: number };

export interface Prompt { kind: 'calibration' | 'target'; vowel: CalibrationVowel | TargetVowel; word: string; say: string }
export interface Hold { prompt: number; value: Formants | null; count: number }
export interface Run { location: Location; holds: Hold[] }
export interface Check { id: string; label: string; pass: boolean | null; detail: string; meaning: string }

const calibration: Prompt[] = [
  { kind: 'calibration', vowel: 'eh', word: 'head', say: 'ehhh' },
  { kind: 'calibration', vowel: 'ae', word: 'had', say: 'aaah (as in cat)' },
  { kind: 'calibration', vowel: 'er', word: 'heard', say: 'errr' },
];
const target = (vowel: TargetVowel, word: string, say: string): Prompt => ({ kind: 'target', vowel, word, say });
export const PROMPTS: Prompt[] = [
  ...calibration, ...calibration,
  ...Array.from({ length: 3 }, () => target('iy', 'heed', 'eeee')),
  ...Array.from({ length: 3 }, () => target('ah', 'father', 'ahhh')),
];

export const HOLD_MS = 1500;
/** About 300 ms of tracked sound at the 25 ms hop, matching game calibration. */
export const MIN_POINTS = 12;
/** Pass/fail thresholds agreed before the live check; engineering heuristics, not clinical cutoffs. */
export const THRESHOLDS = { nearRadii: 1.5, hallMeasured: 4, factorShareOfRadius: 0.25, hallDistanceShift: 0.5 };

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const meanRadius = (['iy', 'ah'] as const).flatMap((v): number[] => [...REFERENCE_V1.radius[v]]).reduce((a, b) => a + b) / 4;

export function holdValue(points: Formants[]): (Formants & { count: number }) | null {
  if (points.length < MIN_POINTS) return null;
  return {
    f1: Math.exp(median(points.map((p) => Math.log(p.f1)))),
    f2: Math.exp(median(points.map((p) => Math.log(p.f2)))),
    count: points.length,
  };
}

/** One uniform log shift from head/had/heard only, so a target vowel can never move its own reference. */
export function factorFrom(values: { vowel: CalibrationVowel; value: Formants }[]): number | null {
  const shifts = values.flatMap(({ vowel, value }) => {
    const [m1, m2] = REFERENCE_V1.means[vowel];
    return [Math.log(value.f1) - m1, Math.log(value.f2) - m2];
  });
  return shifts.length ? shifts.reduce((a, b) => a + b) / shifts.length : null;
}

export function voiceFactor(holds: Hold[]): number | null {
  return factorFrom(holds.flatMap((hold) => {
    const prompt = PROMPTS[hold.prompt];
    return prompt.kind === 'calibration' && hold.value ? [{ vowel: prompt.vowel as CalibrationVowel, value: hold.value }] : [];
  }));
}

/** Normalised distance from the scaled reference: 1 = one reference radius. */
export function distance(value: Formants, vowel: TargetVowel, factor: number) {
  const [m1, m2] = REFERENCE_V1.means[vowel], [r1, r2] = REFERENCE_V1.radius[vowel];
  return Math.hypot((Math.log(value.f1) - m1 - factor) / r1, (Math.log(value.f2) - m2 - factor) / r2);
}

/** Points around the scaled reference at `radii` reference radii, for drawing. */
export function outline(vowel: TargetVowel | 'uw', factor: number, radii = 1, steps = 48): Formants[] {
  const [m1, m2] = REFERENCE_V1.means[vowel], [r1, r2] = REFERENCE_V1.radius[vowel];
  return Array.from({ length: steps }, (_, i) => {
    const angle = (2 * Math.PI * i) / steps;
    return { f1: Math.exp(m1 + factor + radii * r1 * Math.sin(angle)), f2: Math.exp(m2 + factor + radii * r2 * Math.cos(angle)) };
  });
}

export const centre = (vowel: TargetVowel | 'uw', factor: number) =>
  ({ f1: Math.exp(REFERENCE_V1.means[vowel][0] + factor), f2: Math.exp(REFERENCE_V1.means[vowel][1] + factor) });

function targetDistances(run: Run, vowel: TargetVowel) {
  const factor = voiceFactor(run.holds);
  if (factor === null) return [];
  return run.holds.flatMap((hold) => PROMPTS[hold.prompt].vowel === vowel && hold.value ? [distance(hold.value, vowel, factor)] : []);
}

const names: Record<TargetVowel, string> = { iy: '“ee”', ah: '“ah”' };
const fmt = (x: number) => x.toFixed(2);

export function evaluate(quiet?: Run, hall?: Run): Check[] {
  const checks: Check[] = [];
  if (quiet) {
    const measured = quiet.holds.filter((h) => PROMPTS[h.prompt].kind === 'calibration' && h.value).length;
    checks.push({ id: 'quiet-calibration', label: 'Quiet: calibration words heard', pass: measured === 6, detail: `${measured} of 6 measured`,
      meaning: 'The tracker could follow your head / had / heard holds.' });
    for (const vowel of ['iy', 'ah'] as const) {
      const d = targetDistances(quiet, vowel);
      checks.push({ id: `quiet-${vowel}`, label: `Quiet: your ${names[vowel]} lands near the reference`, pass: d.length ? median(d) <= THRESHOLDS.nearRadii : false,
        detail: d.length ? `typical distance ${fmt(median(d))} (pass ≤ ${THRESHOLDS.nearRadii})` : 'no measured holds',
        meaning: 'Your sound and the voice-size–adjusted reference roughly agree. Far away means dialect or tracker—we can’t tell which yet.' });
    }
  }
  if (hall) {
    const measured = hall.holds.filter((h) => PROMPTS[h.prompt].kind === 'target' && h.value).length;
    checks.push({ id: 'hall-coverage', label: 'Hall: enough holds survive the noise', pass: measured >= THRESHOLDS.hallMeasured, detail: `${measured} of 6 ee/ah holds measured (pass ≥ ${THRESHOLDS.hallMeasured})`,
      meaning: 'The tracker still hears you over the crowd.' });
    const qf = quiet ? voiceFactor(quiet.holds) : null, hf = voiceFactor(hall.holds);
    const shift = qf !== null && hf !== null ? Math.abs(hf - qf) / meanRadius : null;
    checks.push({ id: 'hall-factor', label: 'Hall: voice-size setting matches quiet', pass: shift === null ? null : shift <= THRESHOLDS.factorShareOfRadius,
      detail: shift === null ? 'needs both runs' : `moved ${fmt(shift)} of a reference radius (pass ≤ ${THRESHOLDS.factorShareOfRadius})`,
      meaning: 'Noise did not change where the reference is drawn for you.' });
    for (const vowel of ['iy', 'ah'] as const) {
      const h = targetDistances(hall, vowel), q = quiet ? targetDistances(quiet, vowel) : [];
      const delta = h.length && q.length ? Math.abs(median(h) - median(q)) : null;
      checks.push({ id: `hall-${vowel}`, label: `Hall: your ${names[vowel]} reads the same as in quiet`, pass: delta === null ? null : delta <= THRESHOLDS.hallDistanceShift,
        detail: delta === null ? 'needs measured holds in both runs' : `distance changed by ${fmt(delta)} (pass ≤ ${THRESHOLDS.hallDistanceShift})`,
        meaning: 'Feedback in the hall would match feedback somewhere quiet.' });
    }
  }
  return checks;
}

export function resultsText(quiet?: Run, hall?: Run) {
  const lines = [`Articulate reference check · ${REFERENCE_V1.id} v${REFERENCE_V1.version} · ${new Date().toISOString()}`];
  for (const run of [quiet, hall]) {
    if (!run) continue;
    const factor = voiceFactor(run.holds);
    lines.push(`\n${run.location.toUpperCase()} · voice-size factor ${factor === null ? '—' : factor.toFixed(3)}`);
    for (const hold of run.holds) {
      const p = PROMPTS[hold.prompt];
      const d = p.kind === 'target' && hold.value && factor !== null ? ` · distance ${fmt(distance(hold.value, p.vowel as TargetVowel, factor))}` : '';
      lines.push(`  ${p.word.padEnd(7)} ${hold.value ? `${Math.round(hold.value.f1)}/${Math.round(hold.value.f2)} Hz` : 'not measured'} · ${hold.count} pts${d}`);
    }
  }
  lines.push('');
  for (const c of evaluate(quiet, hall)) lines.push(`${c.pass === null ? '…' : c.pass ? 'PASS' : 'FAIL'}  ${c.label} — ${c.detail}`);
  return lines.join('\n');
}
