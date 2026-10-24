import { estimateFormants, type EstimatorSettings } from './estimator';
import { VowelTracker } from './tracker';

const tracker = new VowelTracker();

self.onmessage = (event: MessageEvent<{
  frame: Float32Array;
  sampleRate: number;
  timestampMs: number;
  settings: EstimatorSettings;
}>) => {
  const { frame, sampleRate, timestampMs, settings } = event.data;
  const estimate = estimateFormants(frame, sampleRate, settings);
  self.postMessage(tracker.push(estimate, timestampMs));
};
