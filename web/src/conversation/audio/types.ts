import type { TrackedFrame } from '@vowel-mapper/audio/tracker';

export type { TrackedFrame };

export type SegmentKind = 'attempt' | 'reply';

export interface SegmentResult {
  kind: SegmentKind;
  /** performance.now() clock (ms). */
  startedAt: number;
  endedAt: number;
  durationMs: number;
  voicedFraction: number;
  /** 0..1, higher = steadier F1/F2. */
  formantStability: number;
  transcript: string | null;
  sttError: string | null;
}

export type ListenMode = 'off' | 'attempt' | 'reply' | 'either';
export type BargeInMode = 'aec' | 'gated' | 'headphones' | 'off';

export interface ConversationAudio {
  readonly listening: ListenMode;
  /** Learner voice currently detected (a segment is in progress). */
  readonly speaking: boolean;
  readonly sttReady: boolean;
  /** Arm segmentation; 'off' disarms. */
  listen(mode: ListenMode): void;
  /** Learner began speaking (director starts attempt recording here). */
  onSegmentStart(fn: () => void): () => void;
  /** Finished segment, classified. */
  onSegment(fn: (r: SegmentResult) => void): () => void;
  /** Director tells us when TTS is playing: mutes segmentation, arms barge-in. */
  setTeacherSpeaking(active: boolean): void;
  /** Learner started talking over the teacher. Fires once per teacher utterance. */
  onBargeIn(fn: () => void): () => void;
  bargeInMode: BargeInMode;
  setBargeInMode(m: BargeInMode): void;
  /**
   * Optional extra (superset of the agreed interface) for the "gated" strategy: call with the teacher
   * playback RMS (0..1 float scale) every ~30 ms while speaking. Without it the echo residual is
   * taken from a calibration window.
   */
  setTeacherLevel(rms: number): void;
  /**
   * PCM of the last finished attempt segment (16 kHz mono Int16, incl. ~300 ms pre-roll, max 8.5 s), handed out
   * once. null for replies/discards. startMs is the performance.now() time of the first sample (estimated).
   */
  takeAttemptPcm(): { pcm: Int16Array; startMs: number } | null;
  dispose(): void;
}

/** One analysis frame as consumed by the segmenter. */
export interface LevelFrame {
  /** performance.now() ms. */
  t: number;
  rms: number;
  /** 0..1 */
  periodicity: number;
  /** Formant estimate valid. */
  valid: boolean;
  f1: number;
  f2: number;
}
