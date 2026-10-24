import { describe, expect, it } from 'vitest';
import { labelFrame, mixAtSnr, referenceAt } from '../scripts/eval/core';

describe('offline evaluation boundaries', () => {
  it('counts only windows wholly inside a known phone, excluding transitions', () => {
    const phones = [{ start: 0.1, end: 0.2, phoneme: 'N' }, { start: 0.2, end: 0.4, phoneme: 'IY1' }];
    expect(labelFrame(phones, 100, 150)?.group).toBe('nasal');
    expect(labelFrame(phones, 175, 225)).toBeNull();
    expect(labelFrame(phones, 200, 250)?.group).toBe('vowel');
    expect(labelFrame([{ start: 0, end: 1, phoneme: 'spn' }], 100, 150)).toBeNull();
  });
  it('mixes a known active-speech RMS at requested SNR without clipping or renormalizing speech', () => {
    const result = mixAtSnr(new Float32Array([0.1, -0.1, 0, 0]), new Float32Array([0.2, 0.2, -0.2, -0.2]), 20, 0.1, 0);
    expect(Array.from(result.samples)).toEqual(expect.arrayContaining([expect.closeTo(0.11), expect.closeTo(-0.09), expect.closeTo(-0.01)]));
    expect(result.achievedSnrDb).toBeCloseTo(20);
  });
  it('does not interpolate an F3 reference through an unmeasurable sample', () => {
    const refs = [{timeMs:100,f1:500,f2:1500,f3:0},{timeMs:200,f1:700,f2:1900,f3:2700}];
    expect(referenceAt(refs,150)).toEqual({f1:600,f2:1700,f3:0});
  });
  it('interpolates measured references without extrapolating or inventing missing formants', () => {
    const refs = [{timeMs:100,f1:500,f2:1500,f3:2500},{timeMs:200,f1:700,f2:1900,f3:2700}];
    expect(referenceAt(refs,150)).toEqual({f1:600,f2:1700,f3:2600});
    expect(referenceAt(refs,50)).toBeNull();
    expect(referenceAt([{timeMs:100,f1:0,f2:1500,f3:2500},{timeMs:200,f1:700,f2:1900,f3:2700}],150)).toBeNull();
  });
});
