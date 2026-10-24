/**
 * Shared contracts for word practice (the "track" demo).
 *
 * Measurement (useVoiceFrames) -> board (WordBoard) -> lesson (WordLesson) -> backend coach.
 * Nothing here is a pronunciation judgement; verdicts are acoustic/visual orientation only.
 */

/** One analysis frame from the microphone, voiced or not, every 10-20 ms. */
export interface VoiceFrame {
  timestampMs: number;
  /** Loudness, linear RMS 0..1 of the frame. */
  rms: number;
  /** Periodicity 0..1; `voiced` is the tracker's gate on it. */
  periodicity: number;
  voiced: boolean;
  /** Present only when voiced and the formant estimate was accepted. Hz. */
  f1?: number;
  f2?: number;
  f3?: number;
  /** True on the single frame where a stop release burst was detected (closure silence, then a broadband onset). */
  burst: boolean;
  /** True while the tracker considers the signal clipped. */
  clipped: boolean;
}

/**
 * 'tuner' is the original r strip. The ghost-path engine (src/game/ghost) adds 'liquid' (r judged by
 * path, advisory), 'fricative' and 'nasal' (cue-only, never scored).
 */
export type ZoneKind = 'vowel' | 'tuner' | 'stop' | 'liquid' | 'fricative' | 'nasal';

export interface VowelZoneTarget {
  /** Ellipse centre and radii in Hz. */
  f1: number;
  f2: number;
  /** F2 radius. */
  rx: number;
  /** F1 radius. */
  ry: number;
}

export interface TunerZoneTarget {
  /** Quantity shown on the tuner strip. f3gap = F3 - F2 in Hz (low is good for r). */
  quantity: 'f3gap';
  /** The green band. */
  lowHz: number;
  highHz: number;
  /** Full needle range for the strip. */
  minHz: number;
  maxHz: number;
  /** Direction the learner should push the needle, for the hint arrow. */
  pushTo: 'low' | 'high';
}

export interface StopZoneTarget {
  place: 'alveolar' | 'velar' | 'bilabial';
}

export interface WordZone {
  id: string;
  /** Phoneme label for the backend, e.g. "t", "r", "ae", "k". */
  phoneme: string;
  /** What the learner sees, e.g. "t", "r", "a", "ck". */
  label: string;
  kind: ZoneKind;
  vowel?: VowelZoneTarget;
  tuner?: TunerZoneTarget;
  stop?: StopZoneTarget;
  /** Dwell inside the target needed to count as a hit (vowel/tuner); 0 for stops. */
  holdMs: number;
  /** Body instruction shown with the zone. */
  hint: string;
}

export interface WordSpec {
  word: string;
  zones: WordZone[];
  /** Ideal total duration, for pacing. */
  paceMs: number;
}

export type ZoneVerdict = 'hit' | 'partial' | 'miss' | 'skipped';

export interface ZoneResult {
  zoneId: string;
  phoneme: string;
  kind: ZoneKind;
  verdict: ZoneVerdict;
  /** True when the zone is guidance only and never passes or fails the attempt (liquids, fricatives, nasals). */
  advisory?: boolean;
  /** ms spent inside the target (vowel/tuner); 0 for stops. */
  dwellMs: number;
  startMs: number | null;
  endMs: number | null;
  /**
   * Evidence the backend may cite. Keys per kind:
   *  vowel: f1Median, f2Median, f1Offset, f2Offset (ln(median/target)), inTargetFraction
   *  tuner: valueMedian (Hz), valueBest (Hz), inBandFraction
   *  vowel/liquid on a ghost path: pathDistance (mean distance from the ghost in close-zone units, <= 1 is inside), closeFraction (0..1)
   *  stop:  burstDetected (0|1), burstMs (relative to attempt start, -1 if none), voicedBefore (0|1)
   * plus the lip channel when the camera is usable: spreadMean, roundingMean, lipOpeningMean
   */
  evidence: Record<string, number>;
}

export interface WordAttemptResult {
  word: string;
  attemptId: string;
  durationMs: number;
  zones: ZoneResult[];
  /** Capture quality from the frames: enough voiced frames, not clipped. */
  quality: 'usable' | 'unclear';
  qualityReason?: 'silence' | 'clipped' | 'too-short' | 'no-voice';
  /** Camera availability during the attempt. */
  lipUsable: boolean;
}

/** Live cursor state the board renders each frame, derived from VoiceFrame + LipFrame. */
export interface CursorState {
  /** Tongue-space position in F1/F2 Hz; null when unvoiced or unknown. */
  f1: number | null;
  f2: number | null;
  /** 0..1 loudness for cursor size. */
  loudness: number;
  voiced: boolean;
  /** Lip ring: -1 spread, 0 neutral, +1 rounded; null when the camera is off. */
  lipShape: number | null;
  /** 0..1 lip opening; null when the camera is off. */
  lipOpen: number | null;
}
