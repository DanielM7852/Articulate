import type { SoundId } from '../state/types';

/**
 * Seam for streaming attempt metrics to a shared store (SpacetimeDB, later).
 * The recorder only calls push() when `connected`. A sink must never claim
 * success it did not get: endAttempt resolves true only when every batch was confirmed.
 */
export interface MetricSink {
  readonly connected: boolean;
  beginAttempt(attemptId: string, sound: SoundId): Promise<void>;
  push(kind: 'audio' | 'video', seq: number, frames: object[]): void;
  /** True when all batches were confirmed by the store. */
  endAttempt(attemptId: string): Promise<boolean>;
}

/** Default sink: nothing is streamed, so the coach request carries the frames inline. */
export const offlineSink: MetricSink = {
  connected: false,
  beginAttempt: async () => undefined,
  push: () => undefined,
  endAttempt: async () => false,
};
