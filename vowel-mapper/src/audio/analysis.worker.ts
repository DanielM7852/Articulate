import { BurstDetector } from './bursts';
import { spectralCues } from './cues';
import { estimateFormants, type EstimatorSettings } from './estimator';
import { VowelTracker } from './tracker';

const tracker = new VowelTracker();
const bursts = new BurstDetector();

// Every frame is posted, voiced or not, so consumers see rms and periodicity through silence and noise.
self.onmessage = (event: MessageEvent<{
  frame: Float32Array;
  sampleRate: number;
  timestampMs: number;
  settings: EstimatorSettings;
}>) => {
  const { frame, sampleRate, timestampMs, settings } = event.data;
  const estimate = estimateFormants(frame, sampleRate, settings);
  // Timestamps are the capture's sample clock (end of frame), so they convert back to a sample index exactly.
  const burst = bursts.push(frame, sampleRate, Math.round(timestampMs * sampleRate / 1000));
  self.postMessage({ ...tracker.push(estimate, timestampMs), cues: estimate.rms > 0 ? spectralCues(frame, sampleRate) : null, burst });
};
