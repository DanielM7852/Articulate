import { describe, expect, it } from 'vitest';
import { REFERENCE_V1 } from '../src/reference/data';
import { PROMPTS, distance, evaluate, holdValue, voiceFactor, type Hold, type Run } from '../src/reference/check';

const at = (vowel: keyof typeof REFERENCE_V1.means, scale = 1) => ({
  f1: Math.exp(REFERENCE_V1.means[vowel][0]) * scale,
  f2: Math.exp(REFERENCE_V1.means[vowel][1]) * scale,
});

/** One measured hold per prompt, every formant multiplied by `scale`; targets shifted by `offset` radii on F1. */
function run(location: Run['location'], scale = 1, offset = 0, missing: number[] = []): Run {
  const holds: Hold[] = PROMPTS.map((prompt, index) => {
    if (missing.includes(index)) return { prompt: index, value: null, count: 4 };
    const value = at(prompt.vowel, scale);
    if (prompt.kind === 'target') value.f1 *= Math.exp(offset * REFERENCE_V1.radius[prompt.vowel as 'iy' | 'ah'][0]);
    return { prompt: index, value, count: 40 };
  });
  return { location, holds };
}

const verdicts = (quiet?: Run, hall?: Run) => Object.fromEntries(evaluate(quiet, hall).map((check) => [check.id, check.pass]));

describe('reference check', () => {
  it('asks for head/had/heard twice, then ee and ah three times each', () => {
    expect(PROMPTS.map((p) => p.vowel).join(' ')).toBe('eh ae er eh ae er iy iy iy ah ah ah');
  });

  it('needs enough tracked points for a hold and uses the log median', () => {
    expect(holdValue(Array.from({ length: 11 }, () => ({ f1: 500, f2: 1500 })))).toBeNull();
    const value = holdValue([...Array.from({ length: 12 }, () => ({ f1: 400, f2: 2000 })), { f1: 900, f2: 900 }]);
    expect(value?.count).toBe(13);
    expect(value?.f1).toBeCloseTo(400, 6);
    expect(value?.f2).toBeCloseTo(2000, 6);
  });

  it('estimates one voice-size factor from the calibration words only', () => {
    expect(voiceFactor(run('quiet').holds)).toBeCloseTo(0, 6);
    expect(voiceFactor(run('quiet', 1.2).holds)).toBeCloseTo(Math.log(1.2), 6);
    expect(voiceFactor(run('quiet', 1, 3).holds)).toBeCloseTo(0, 6);
    expect(voiceFactor(run('quiet', 1, 0, [0, 1, 2, 3, 4, 5]).holds)).toBeNull();
  });

  it('measures distance from the scaled reference in reference radii', () => {
    const factor = Math.log(1.2);
    expect(distance(at('iy', 1.2), 'iy', factor)).toBeCloseTo(0, 6);
    const oneRadius = { ...at('iy', 1.2), f1: at('iy', 1.2).f1 * Math.exp(REFERENCE_V1.radius.iy[0]) };
    expect(distance(oneRadius, 'iy', factor)).toBeCloseTo(1, 6);
  });

  it('passes a quiet run near the reference and fails one that is far or missing calibration', () => {
    expect(verdicts(run('quiet', 1.15, 0.5))).toMatchObject({ 'quiet-calibration': true, 'quiet-iy': true, 'quiet-ah': true });
    expect(verdicts(run('quiet', 1, 2))).toMatchObject({ 'quiet-iy': false, 'quiet-ah': false });
    expect(verdicts(run('quiet', 1, 0, [2]))).toMatchObject({ 'quiet-calibration': false });
  });

  it('compares the hall with the quiet run', () => {
    expect(verdicts(run('quiet'), run('hall', 1.01, 0.3))).toMatchObject({ 'hall-coverage': true, 'hall-factor': true, 'hall-iy': true, 'hall-ah': true });
    expect(verdicts(run('quiet'), run('hall', 1.1, 0.8, [6, 7, 9]))).toMatchObject({ 'hall-coverage': false, 'hall-factor': false, 'hall-ah': false });
    expect(verdicts(undefined, run('hall'))).toMatchObject({ 'hall-factor': null });
  });
});
