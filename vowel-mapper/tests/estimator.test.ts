import { describe, expect, it } from 'vitest';
import { estimateFormants } from '../src/audio/estimator';
import { noiseSignal, vowelSignal, withNoise } from './signals';

describe('formant estimation from an audio frame', () => {
  it('finds the known first two resonances of a sustained synthetic ee vowel', () => {
    const signal = vowelSignal();
    const estimate = estimateFormants(signal.slice(-2400), 48000);
    expect(estimate.valid).toBe(true);
    if (!estimate.valid) throw new Error(estimate.reason);
    expect(estimate.f1).toBeGreaterThan(220);
    expect(estimate.f1).toBeLessThan(380);
    expect(estimate.f2).toBeGreaterThan(2150);
    expect(estimate.f2).toBeLessThan(2450);
  });

  it.each([
    { formants: [750, 1200, 2600], pitch: 120, sampleRate: 48000 },
    { formants: [350, 800, 2400], pitch: 120, sampleRate: 44100 },
    { formants: [400, 2600, 3300], pitch: 200, sampleRate: 48000 },
  ])('tracks separate known vowel resonances at $sampleRate Hz / pitch $pitch', ({ formants, pitch, sampleRate }) => {
    const frame = vowelSignal({ formants, pitch, sampleRate }).slice(-Math.round(sampleRate * 0.05));
    const result = estimateFormants(frame, sampleRate);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error(result.reason);
    expect(Math.abs(result.f1 - formants[0])).toBeLessThan(110);
    expect(Math.abs(result.f2 - formants[1])).toBeLessThan(160);
  });

  // oo at 370 / 930 / 2800 Hz: in noise, losing a formant must not promote the next one into its place.
  const slippedNoisyOo = (pitch: number, snrDb: number) => {
    const signal = withNoise(vowelSignal({ formants: [370, 930, 2800], pitch, seconds: 2 }), snrDb);
    const slipped: string[] = [];
    for (let start = 0; start + 2400 <= signal.length; start += 1200) {
      const estimate = estimateFormants(signal.slice(start, start + 2400), 48000);
      if (estimate.valid && (estimate.f1 > 650 || estimate.f2 > 1600)) slipped.push(`${Math.round(estimate.f1)}/${Math.round(estimate.f2)}`);
    }
    return slipped;
  };

  it('never reports a noisy oo’s F2 as its F1 when noise broadens F1', () => {
    expect(slippedNoisyOo(110, 15)).toEqual([]);
  });

  it.each([15, 10])('never reports a noisy oo’s F3 as its F2 when noise broadens F2 (%i dB SNR)', (snrDb) => {
    expect(slippedNoisyOo(200, snrDb)).toEqual([]);
  });

  // The spare broad pole LPC places in clean front vowels sits close to F2, unlike a dropped F2.
  it.each([
    [300, 2300, 3000], [380, 2100, 2900], [400, 2600, 3300], [450, 1900, 2700], [540, 1650, 2500],
    [675, 1320, 2500], [570, 840, 2400], [370, 930, 2800],
  ])('keeps accepting every frame of a clean %i / %i Hz vowel across pitches', (...formants) => {
    for (const pitch of [100, 160, 200, 300]) {
      const signal = vowelSignal({ formants, pitch, seconds: 0.5 });
      for (let start = 0; start + 2400 <= signal.length; start += 1200) {
        expect(estimateFormants(signal.slice(start, start + 2400), 48000).valid, `pitch ${pitch}`).toBe(true);
      }
    }
  });

  // Known gaps: at 10 dB an F1 slip remains at other pitches, and F1 can collapse to a 0 Hz pole.
  it.fails.each([
    { pitch: 110, snrDb: 10 },
    { pitch: 250, snrDb: 10 },
  ])('KNOWN GAP: still slips a noisy oo at pitch $pitch, $snrDb dB SNR', ({ pitch, snrDb }) => {
    expect(slippedNoisyOo(pitch, snrDb)).toEqual([]);
  });

  it.each([110, 250])('keeps accepting an oo through moderate background noise (pitch %i)', (pitch) => {
    const signal = withNoise(vowelSignal({ formants: [370, 930, 2800], pitch, seconds: 2 }), 20);
    let valid = 0;
    let frames = 0;
    for (let start = 0; start + 2400 <= signal.length; start += 1200, frames++) {
      const estimate = estimateFormants(signal.slice(start, start + 2400), 48000);
      if (!estimate.valid) continue;
      valid++;
      // Region check only: LPC reads this low F1 high at higher pitch even without noise.
      expect(estimate.f1).toBeLessThan(650);
      expect(estimate.f2).toBeLessThan(1600);
    }
    expect(valid / frames).toBeGreaterThan(0.9);
  });

  it('rejects silence and unvoiced broadband noise instead of inventing a vowel', () => {
    expect(estimateFormants(new Float32Array(2400), 48000)).toMatchObject({ valid: false, reason: 'quiet' });
    expect(estimateFormants(noiseSignal(2400), 48000)).toMatchObject({ valid: false, reason: 'unvoiced' });
  });

  it('rejects clipped audio and a lone tone', () => {
    const clipped = Float32Array.from(vowelSignal().slice(-2400), (value) => value > 0 ? 1 : -1);
    expect(estimateFormants(clipped, 48000)).toMatchObject({ valid: false, reason: 'clipped' });
    const tone = Float32Array.from({ length: 2400 }, (_, i) => 0.4 * Math.sin(2 * Math.PI * 200 * i / 48000));
    expect(estimateFormants(tone, 48000).valid).toBe(false);
  });

  it('returns an invalid measurement for malformed frames or unsupported settings', () => {
    const frame = vowelSignal().slice(-2400);
    expect(estimateFormants(frame, 0)).toMatchObject({ valid: false, reason: 'invalid' });
    expect(estimateFormants(new Float32Array([NaN, Infinity]), 48000).valid).toBe(false);
    expect(estimateFormants(frame, 48000, { ceilingHz: -1, minimumRms: 0.008 }).valid).toBe(false);
  });
});

describe('third formant', () => {
  // Includes r-coloured vowels, whose F3 sits close above F2.
  it.each([
    [300, 2300, 3000], [400, 2600, 3300], [540, 1650, 2500], [675, 1320, 2500], [750, 1200, 2600],
    [570, 840, 2400], [370, 930, 2800], [470, 1300, 1700], [450, 1150, 1600], [500, 1400, 1900],
  ])('reports F3 of a clean %i / %i / %i Hz vowel on every accepted frame', (...formants) => {
    for (const pitch of [100, 160]) {
      const signal = vowelSignal({ formants, pitch, seconds: 0.3 });
      for (let start = 0; start + 2400 <= signal.length; start += 1200) {
        const estimate = estimateFormants(signal.slice(start, start + 2400), 48000);
        if (!estimate.valid) throw new Error(estimate.reason);
        expect(estimate.f3, `pitch ${pitch}`).toBeDefined();
        expect(Math.abs(estimate.f3! - formants[2]), `pitch ${pitch}`).toBeLessThan(150);
      }
    }
  });

  // Noise broadens a close F3 past a formant's bandwidth; the spare pole above must not be promoted into its place.
  const misplacedF3 = (formants: number[], snrDb: number) => {
    const misplaced: string[] = [];
    for (const pitch of [100, 160, 220]) {
      const signal = withNoise(vowelSignal({ formants, pitch, seconds: 0.5 }), snrDb);
      for (let start = 0; start + 2400 <= signal.length; start += 1200) {
        const estimate = estimateFormants(signal.slice(start, start + 2400), 48000);
        if (estimate.valid && estimate.f3 !== undefined && Math.abs(estimate.f3 - formants[2]) >= 250) {
          misplaced.push(`pitch ${pitch}: ${Math.round(estimate.f3)}`);
        }
      }
    }
    return misplaced;
  };

  it.each([
    { formants: [470, 1300, 1700], snrDb: 20 }, { formants: [470, 1300, 1700], snrDb: 15 },
    { formants: [450, 1150, 1600], snrDb: 20 }, { formants: [450, 1150, 1600], snrDb: 15 },
    { formants: [500, 1400, 1900], snrDb: 20 },
    { formants: [675, 1320, 2500], snrDb: 20 }, { formants: [675, 1320, 2500], snrDb: 15 },
  ])('withholds rather than misplaces F3 of a noisy $formants Hz vowel ($snrDb dB SNR)', ({ formants, snrDb }) => {
    expect(misplacedF3(formants, snrDb)).toEqual([]);
  });

  // Known gap: a narrow pole near 3.6 kHz can stand in for a lost 1.9 kHz F3.
  it.fails('KNOWN GAP: misplaces F3 of a noisy 500 / 1400 / 1900 Hz vowel at 15 dB SNR', () => {
    expect(misplacedF3([500, 1400, 1900], 15)).toEqual([]);
  });

  it('keeps level and voicing on clipped frames while withholding formants', () => {
    const clipped = Float32Array.from(vowelSignal().slice(-2400), (value) => Math.max(-1, Math.min(1, value * 4)));
    const estimate = estimateFormants(clipped, 48000);
    expect(estimate).toMatchObject({ valid: false, reason: 'clipped' });
    expect(estimate.rms).toBeGreaterThan(0.1);
    expect(estimate.periodicity).toBeGreaterThan(0.65);
  });
});
