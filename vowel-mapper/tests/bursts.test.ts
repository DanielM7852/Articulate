import { describe, expect, it } from 'vitest';
import { BurstDetector, type BurstOnset } from '../src/audio/bursts';
import { vowelSignal } from './signals';

/** Seeded uniform noise at a given RMS. */
function noise(seconds: number, rms: number, sampleRate: number, seed = 99): Float32Array {
  let state = seed;
  const scale = rms * Math.sqrt(3);
  return Float32Array.from({ length: Math.round(seconds * sampleRate) }, () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state / 0xffffffff * 2 - 1) * scale;
  });
}

/** Concatenates segments over a quiet room-noise bed, so closures are near-silent rather than digital zero. */
function utterance(sampleRate: number, ...segments: Float32Array[]): { signal: Float32Array; starts: number[] } {
  const length = segments.reduce((sum, segment) => sum + segment.length, 0);
  const signal = noise(length / sampleRate, 0.0005, sampleRate, 5);
  const starts: number[] = [];
  let offset = 0;
  for (const segment of segments) {
    starts.push(offset);
    for (let i = 0; i < segment.length; i++) signal[offset + i] += segment[i];
    offset += segment.length;
  }
  return { signal, starts };
}

const silence = (seconds: number, sampleRate: number) => new Float32Array(Math.round(seconds * sampleRate));
const vowel = (seconds: number, sampleRate: number, formants = [700, 1200, 2600]) =>
  Float32Array.from(vowelSignal({ formants, sampleRate, seconds }), (value) => value * 0.5);

/** Runs the detector over 50 ms frames with a 25 ms hop, as the capture worklet posts them. */
function detect(signal: Float32Array, sampleRate: number, drop: (index: number) => boolean = () => false) {
  const detector = new BurstDetector();
  const frameSize = Math.round(sampleRate * 0.05);
  const hop = Math.round(sampleRate * 0.025);
  const flagged: { endSample: number; onset: BurstOnset }[] = [];
  for (let end = frameSize, index = 0; end <= signal.length; end += hop, index++) {
    if (drop(index)) continue;
    const onset = detector.push(signal.slice(end - frameSize, end), sampleRate, end);
    if (onset) flagged.push({ endSample: end, onset });
  }
  return { flagged, hop };
}

describe('stop burst detection', () => {
  it.each([48000, 44100])('flags exactly one frame for silence, a noise burst and a vowel (%i Hz)', (sampleRate) => {
    const { signal, starts } = utterance(sampleRate,
      silence(0.3, sampleRate), noise(0.008, 0.05, sampleRate), noise(0.025, 0.01, sampleRate, 3), vowel(0.25, sampleRate));
    const { flagged, hop } = detect(signal, sampleRate);
    expect(flagged).toHaveLength(1);
    const [{ endSample, onset }] = flagged;
    const burstMs = starts[1] / sampleRate * 1000;
    expect(Math.abs(onset.timestampMs - burstMs)).toBeLessThanOrEqual(5);
    // The flagged frame is the one whose new samples hold the onset.
    expect(onset.timestampMs).toBeGreaterThanOrEqual((endSample - hop) / sampleRate * 1000 - 5);
    expect(onset.timestampMs).toBeLessThan(endSample / sampleRate * 1000);
    expect(onset.jumpDb).toBeGreaterThan(12);
    expect(onset.frequencyHz).toBeGreaterThan(3000);
  });

  it('does not mistake a vowel starting out of silence for a release', () => {
    for (const formants of [[700, 1200, 2600], [300, 2300, 3000], [370, 930, 2800]]) {
      const { signal } = utterance(48000, silence(0.3, 48000), vowel(0.3, 48000, formants));
      expect(detect(signal, 48000).flagged, formants.join('/')).toEqual([]);
    }
  });

  it('flags a word-medial release after a closure following a vowel', () => {
    const { signal, starts } = utterance(48000,
      silence(0.3, 48000), vowel(0.2, 48000), silence(0.06, 48000), noise(0.01, 0.04, 48000), vowel(0.2, 48000));
    const { flagged } = detect(signal, 48000);
    expect(flagged).toHaveLength(1);
    expect(Math.abs(flagged[0].onset.timestampMs - starts[3] / 48)).toBeLessThanOrEqual(5);
  });

  it('needs a closure of at least 40 ms', () => {
    const { signal } = utterance(48000,
      silence(0.3, 48000), vowel(0.2, 48000), silence(0.025, 48000), noise(0.01, 0.04, 48000), vowel(0.2, 48000));
    expect(detect(signal, 48000).flagged).toEqual([]);
  });

  it('counts a second burst within the refractory period once', () => {
    const { signal } = utterance(48000,
      silence(0.3, 48000), noise(0.005, 0.05, 48000), silence(0.045, 48000), noise(0.008, 0.05, 48000, 4), vowel(0.2, 48000));
    expect(detect(signal, 48000).flagged).toHaveLength(1);
  });

  it('flags each release in a two-stop phrase', () => {
    const { signal, starts } = utterance(48000,
      silence(0.3, 48000), noise(0.008, 0.05, 48000), vowel(0.2, 48000),
      silence(0.08, 48000), noise(0.008, 0.03, 48000, 8), vowel(0.15, 48000));
    const { flagged } = detect(signal, 48000);
    expect(flagged).toHaveLength(2);
    [starts[1], starts[4]].forEach((start, i) => expect(Math.abs(flagged[i].onset.timestampMs - start / 48)).toBeLessThanOrEqual(5));
  });

  it('survives a single dropped frame without duplicating or losing the release', () => {
    const { signal } = utterance(48000,
      silence(0.3, 48000), noise(0.008, 0.05, 48000), noise(0.025, 0.01, 48000, 3), vowel(0.25, 48000));
    for (let dropped = 8; dropped < 16; dropped++) {
      expect(detect(signal, 48000, (index) => index === dropped).flagged, `dropped ${dropped}`).toHaveLength(1);
    }
  });

  it('ignores steady noise and silence', () => {
    expect(detect(utterance(48000, silence(1, 48000)).signal, 48000).flagged).toEqual([]);
    expect(detect(noise(1, 0.02, 48000), 48000).flagged).toEqual([]);
  });
});
