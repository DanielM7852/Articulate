import type { VoiceFrame } from '../game/types';

/**
 * STUB, replaced by the audio-features worker.
 * Subscribes to the vowel-mapper engine on a stream the caller owns and emits every
 * analysis frame (voiced or not) with rms, periodicity, F1/F2/F3 and a stop-burst flag.
 */
export interface VoiceFrames {
  /** Latest frame, null before the first. */
  latest: VoiceFrame | null;
  /** Register a per-frame listener (for the board's rAF loop); returns an unsubscribe. */
  subscribe(listener: (frame: VoiceFrame) => void): () => void;
  status: 'off' | 'starting' | 'tracking' | 'paused' | 'error';
}

export function useVoiceFrames(_stream: MediaStream | null): VoiceFrames {
  return { latest: null, subscribe: () => () => undefined, status: 'off' };
}
