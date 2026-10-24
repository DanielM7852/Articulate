/**
 * Stop release bursts: a closure of near-silence followed by a sudden broadband onset.
 *
 * Capture frames overlap, so the detector keeps its own sample position and analyses only samples it
 * has not seen, in short blocks. A release is therefore flagged on exactly one frame: the one whose
 * new samples contain the onset block. Acoustic orientation only, not a judgement of the stop.
 */
export interface BurstOnset {
  /** Start of the onset block, on the same clock as the frame timestamps (ms). */
  timestampMs: number;
  /** RMS frequency of the onset block (its second spectral moment), a cheap spectral-centroid proxy. Hz. */
  frequencyHz: number;
  /** Onset level above the closure, dB. */
  jumpDb: number;
}

export const BURST_SETTINGS = {
  /** Analysis block. */
  blockMs: 5,
  /** Shortest closure of near-silence before a release. */
  minClosureMs: 40,
  /** A block is near-silent below whichever is higher: recent speech minus this, or the noise floor plus `closureAboveNoiseDb`. */
  closureBelowSpeechDb: 20,
  closureAboveNoiseDb: 10,
  /** Rise over the closure's mean level that marks an onset, reached within `onsetBlocks` of the closure ending. */
  jumpDb: 12,
  onsetBlocks: 2,
  /** Broadband (noise-like) onsets cross zero often; a vowel onset after silence is dominated by F1 and crosses far less. */
  minCrossingsPerSecond: 3000,
  /** Absolute floor on the onset level, so tiny fluctuations over digital silence never count. */
  minOnsetRms: 0.002,
  /** No second release within this time; a velar's double burst counts once. */
  refractoryMs: 80,
  /** Audio needed before the first detection, so the level trackers have settled. */
  warmupMs: 200,
  /** Recent speech level decays at this rate between peaks. */
  speechDecayDbPerSecond: 6,
  /** The noise floor falls instantly and rises at this rate. */
  noiseRiseDbPerSecond: 2,
  highpassHz: 100,
};

type Settings = typeof BURST_SETTINGS;

const gain = (db: number) => 10 ** (db / 20);

export class BurstDetector {
  private sampleRate = 0;
  /** Absolute index of the next sample to analyse; -1 before the first frame. */
  private next = -1;
  private analysed = 0;
  private hpIn = 0;
  private hpOut = 0;
  private noise = 0;
  private speech = 0;
  private closureBlocks = 0;
  private closureEnergy = 0;
  /** Blocks since a qualifying closure ended, or -1 when no release is pending. */
  private sinceClosure = -1;
  private closureLevel = 0;
  private lastBurst = -Infinity;

  constructor(private readonly settings: Settings = BURST_SETTINGS) {}

  /** Analyse a capture frame whose last sample has absolute index `endSample - 1`. */
  push(frame: Float32Array, sampleRate: number, endSample: number): BurstOnset | null {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(endSample)) return null;
    if (sampleRate !== this.sampleRate) this.restart(sampleRate);
    const start = endSample - frame.length;
    // A gap (dropped frames) or a clock jump breaks continuity: the closure in progress is no longer known.
    if (this.next < start || this.next > endSample) this.discontinuity(start, frame[0] ?? 0);
    const block = Math.max(1, Math.round(sampleRate * this.settings.blockMs / 1000));
    let found: BurstOnset | null = null;
    while (this.next + block <= endSample) {
      const onset = this.block(frame, this.next - start, block);
      if (onset && !found) found = onset;
      this.next += block;
    }
    return found;
  }

  private restart(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.next = -1;
    this.analysed = 0;
    this.noise = 0;
    this.speech = 0;
    this.lastBurst = -Infinity;
    this.closureBlocks = 0;
    this.closureEnergy = 0;
    this.sinceClosure = -1;
  }

  private discontinuity(start: number, first: number) {
    this.next = start;
    this.hpIn = first;
    this.hpOut = 0;
    this.closureBlocks = 0;
    this.closureEnergy = 0;
    this.sinceClosure = -1;
  }

  private block(frame: Float32Array, offset: number, length: number): BurstOnset | null {
    const s = this.settings;
    const rate = this.sampleRate;
    const r = Math.exp(-2 * Math.PI * s.highpassHz / rate);
    let energy = 0;
    let slope = 0;
    let crossings = 0;
    let previous = this.hpOut;
    for (let i = 0; i < length; i++) {
      const x = frame[offset + i];
      const y = r * (this.hpOut + x - this.hpIn);
      this.hpIn = x;
      this.hpOut = y;
      energy += y * y;
      slope += (y - previous) ** 2;
      if ((y >= 0) !== (previous >= 0)) crossings++;
      previous = y;
    }
    const rms = Math.sqrt(energy / length);
    const blockSeconds = length / rate;
    const position = this.next;
    this.analysed += length;

    const floor = Math.max(this.noise * gain(s.closureAboveNoiseDb), this.speech * gain(-s.closureBelowSpeechDb));
    let onset: BurstOnset | null = null;
    if (this.noise > 0 && rms < floor) {
      this.closureBlocks++;
      this.closureEnergy += rms * rms;
      this.sinceClosure = -1;
    } else {
      if (this.closureBlocks * blockSeconds * 1000 >= s.minClosureMs) {
        this.closureLevel = Math.sqrt(this.closureEnergy / this.closureBlocks);
        this.sinceClosure = 0;
      }
      this.closureBlocks = 0;
      this.closureEnergy = 0;
      if (this.sinceClosure >= 0) {
        const crossingRate = crossings / blockSeconds;
        const ready = this.analysed / rate * 1000 >= s.warmupMs && (position - this.lastBurst) / rate * 1000 >= s.refractoryMs;
        if (ready && rms >= s.minOnsetRms && rms >= Math.max(this.closureLevel, 1e-6) * gain(s.jumpDb) && crossingRate >= s.minCrossingsPerSecond) {
          onset = {
            timestampMs: position / rate * 1000,
            // For a sinusoid, mean squared first difference / mean square = 4 sin²(πf/rate).
            frequencyHz: rate / Math.PI * Math.asin(Math.min(1, Math.sqrt(slope / Math.max(energy, 1e-20)) / 2)),
            jumpDb: 20 * Math.log10(rms / Math.max(this.closureLevel, 1e-6)),
          };
          this.lastBurst = position;
          this.sinceClosure = -1;
        } else if (++this.sinceClosure >= s.onsetBlocks) {
          this.sinceClosure = -1;
        }
      }
    }

    // Exact digital silence carries no information about the room's noise floor.
    if (rms > 1e-6) {
      this.noise = this.noise === 0 || rms < this.noise ? Math.max(rms, 1e-5) : this.noise * gain(s.noiseRiseDbPerSecond * blockSeconds);
    }
    this.speech = Math.max(rms, this.speech * gain(-s.speechDecayDbPerSecond * blockSeconds));
    return onset;
  }
}
