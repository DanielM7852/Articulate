import type { LipFrame } from '../vision/lipTelemetry';
import type { VoiceFrames } from '../audio/useVoiceFrames';
import type { WordAttemptResult, WordSpec } from '../game/types';

/**
 * STUB, replaced by the board worker.
 * The word game board: a tongue-space plot (front/back by high/low, no Hz shown to the
 * learner), the zone sequence for `spec.zones`, a tuner strip for tuner zones, stop
 * markers, and a cursor whose size is loudness, fill is voicing, ring is lip shape.
 */
export interface WordBoardProps {
  spec: WordSpec;
  frames: VoiceFrames;
  /** Latest camera lip frame, or null when the camera is off or unusable. */
  lip: LipFrame | null;
  /** idle: zones dimmed. demo: play the zone sequence as Ava's example. live: score the learner. */
  mode: 'idle' | 'demo' | 'live';
  /** Attempt id for the result; a new value starts a new live attempt. */
  attemptId: string;
  /** Fires once per live attempt when the sequence completes or times out. */
  onAttemptEnd?: (result: WordAttemptResult) => void;
  /** Which zone to emphasise (the one Ava is coaching), or null. */
  focusZoneId?: string | null;
}

export function WordBoard(_props: WordBoardProps) {
  return <div className="word-board" />;
}
