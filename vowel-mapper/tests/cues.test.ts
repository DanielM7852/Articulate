import { describe, expect, it } from 'vitest';
import { CueSummary, spectralCues } from '../src/audio/cues';
import type { FormantEstimate } from '../src/audio/estimator';
import { vowelSignal } from './signals';

const tone = (frequency: number) => Float32Array.from({ length: 2400 }, (_, i) => 0.3 * Math.sin(2 * Math.PI * frequency * i / 48000));
const voiced = (rms: number): FormantEstimate => ({ valid: true, f1: 400, f2: 1500, confidence: 0.8, rms, periodicity: 0.9 });
const cues = { lowVsMidDb: 10, lowVsHighDb: 20 };

describe('spectral cues for nasal murmur (diagnostic only)', () => {
  it('assigns energy to the low, mid, and high bands', () => {
    expect(spectralCues(tone(250), 48000)!.lowVsHighDb).toBeGreaterThan(20);
    expect(spectralCues(tone(700), 48000)!.lowVsMidDb).toBeLessThan(-20);
    expect(spectralCues(tone(2000), 48000)!.lowVsHighDb).toBeLessThan(-20);
  });

  it('reads a single low resonance as far more low-heavy than ee', () => {
    const murmur = spectralCues(vowelSignal({ formants: [250] }).slice(-2400), 48000)!;
    const ee = spectralCues(vowelSignal({ formants: [300, 2300, 3000] }).slice(-2400), 48000)!;
    expect(murmur.lowVsHighDb).toBeGreaterThan(ee.lowVsHighDb + 10);
  });

  it('returns null for silence', () => {
    expect(spectralCues(new Float32Array(2400), 48000)).toBeNull();
  });
});

describe('cue summary shown in Tracking details', () => {
  it('has nothing to show before a voiced frame, and ignores silence', () => {
    const summary = new CueSummary();
    expect(summary.push({ valid: false, reason: 'quiet', rms: 0, periodicity: 0 }, null, 0)).toBeNull();
  });

  it('reports medians over the last half second of voiced frames', () => {
    const summary = new CueSummary();
    for (let t = 0; t < 1000; t += 25) summary.push(voiced(0.1), { lowVsMidDb: 0, lowVsHighDb: 0 }, t);
    let readout = null;
    for (let t = 1000; t < 1600; t += 25) readout = summary.push(voiced(0.1), cues, t);
    expect(readout).toMatchObject({ lowVsMidDb: 10, lowVsHighDb: 20 });
  });

  it('keeps the last voiced readout through silence, so it can be read after Finish', () => {
    const summary = new CueSummary();
    for (let t = 0; t < 600; t += 25) summary.push(voiced(0.1), cues, t);
    expect(summary.push({ valid: false, reason: 'quiet', rms: 0, periodicity: 0 }, null, 700)).toMatchObject(cues);
  });

  it('reports loudness relative to the loudest voiced frame in the last 3 seconds', () => {
    const summary = new CueSummary();
    for (let t = 0; t < 1000; t += 25) summary.push(voiced(0.2), cues, t);
    let readout = null;
    for (let t = 1000; t < 1600; t += 25) readout = summary.push(voiced(0.05), cues, t);
    expect(readout!.loudnessDb).toBeCloseTo(-12, 0);
    for (let t = 1600; t < 4600; t += 25) readout = summary.push(voiced(0.05), cues, t);
    expect(readout!.loudnessDb).toBeCloseTo(0, 1);
  });
});
