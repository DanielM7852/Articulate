/**
 * Ghost-path model contract. The same shape is produced offline as JSON (source 'cartesia-avg' or
 * 'recorded'), so keep it exactly in step with that producer.
 */
export type GhostMarkerKind = 'stop' | 'liquid' | 'nasal' | 'fricative';

/** One sample of the model voice. t in [0,1] of the word; Hz at the model's `factor`. */
export interface GhostPoint {
  t: number;
  f1: number;
  f2: number;
}

/** A contiguous voiced stretch. `spread` has one value per point, in ln units (the close-zone radius). */
export interface GhostSegment {
  points: GhostPoint[];
  spread: number[];
}

/** A consonant on the timeline. Only stops are scored. */
export interface GhostMarker {
  kind: GhostMarkerKind;
  zoneId: string;
  phoneme: string;
  t: number;
  scored: boolean;
}

/** A practice part of the word. Parts are contiguous and cover [0,1] in order. */
export interface GhostPart {
  id: string;
  label: string;
  zoneIds: string[];
  t0: number;
  t1: number;
}

export interface GhostPathModel {
  version: 1;
  word: string;
  source: 'synthetic' | 'cartesia-avg' | 'recorded';
  /** The model voice's ln voice factor (Karsten's single multiplier). 0 = the reference size. */
  factor: number;
  durationMs: number;
  segments: GhostSegment[];
  markers: GhostMarker[];
  parts: GhostPart[];
  provenance: string;
}

export type GhostVoiceGroup = 'man' | 'woman' | 'boy' | 'girl';

/** What the learner practises in one attempt: some zones of the word, in word order. */
export interface GhostUnit {
  id: string;
  label: string;
  zoneIds: string[];
  partIds: string[];
}
