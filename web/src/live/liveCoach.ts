import type { WordAttemptResult, ZoneResult } from '../game/types';
import type { SoundId } from '../state/types';
import type { AudioFrame, RecordedLipFrame } from './attemptRecorder';
import { livePost } from './transport';
import { emit } from '../telemetry/client';

/** Typed wrappers for the live coaching endpoints. Both throw on any failure so callers can fall back. */
export type CueId = 'round-lips' | 'spread-lips' | 'open-jaw';
export type MetricsSource = 'spacetimedb' | 'inline';

export interface ClientSummary {
  durationSec: number;
  usableVoicedSec: number;
  timeInTargetSec: number | null;
  longestHoldSec: number | null;
  quality: string;
  qualityReason: string | null;
}

export interface LiveCoachRequest {
  attemptId: string;
  profileId: string;
  sound: SoundId;
  metricsSource: MetricsSource;
  clientSummary: ClientSummary;
  frames: { audio: AudioFrame[]; video: RecordedLipFrame[] } | null;
  /** Word mode: the board's attempt. `sound` is then the word's vowel ("a" for track). */
  word?: WordAttemptResult;
  /** Word mode: a short 16 kHz mono PCM16 WAV of the attempt (base64, no data: prefix). Omitted when unavailable. */
  attemptAudio?: { format: 'wav'; data: string; durationMs: number };
}

/** Server roll-up of a word attempt (backend/app/live/scoring.py score_word). */
export interface WordScore {
  word: string;
  verdict: 'on_target' | 'close' | 'off' | 'insufficient';
  zoneCount: number;
  hitCount: number;
  weakestZoneId: string | null;
  zones: ZoneResult[];
  lipUsable: boolean;
}

export interface LiveCoachResponse {
  attemptId: string;
  source: 'agent' | 'fallback';
  metricsSource: MetricsSource;
  audio: Record<string, unknown>;
  video: Record<string, unknown> | null;
  observation: string;
  caption: string;
  cueId: CueId | null;
  showSideView: boolean;
  nextAction: 'retry' | 'next_sound' | 'rest';
  evidence: { field: string; value: unknown }[];
  persisted: boolean;
  /** Word mode only. */
  word?: WordScore | null;
  focusZoneId?: string | null;
}

export interface LiveNotes {
  profileId: string;
  summary: string;
  struggles: { sound: string; pattern: string; count: number; lastAttemptId: string }[];
  habits: string[];
  attemptsConsidered: number;
  source: string;
  persisted: boolean;
}

/** Learner name slugged to [A-Za-z0-9_.:@-]{1,64}; "guest" when nothing usable remains. */
export function profileIdFor(name: string | null | undefined): string {
  const slug = (name ?? '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_.:@-]/g, '')
    .slice(0, 64);
  return slug || 'guest';
}

export function requestLiveCoach(req: LiveCoachRequest, signal?: AbortSignal): Promise<LiveCoachResponse> {
  emit('ui', 'backend', 'coach.request', 'coach request', {
    sound: req.sound,
    mode: req.word ? 'word' : 'sound',
    attemptId: req.attemptId,
  });
  return livePost<LiveCoachResponse>('/v1/live/coach', req, signal).then((r) => {
    if (!r || typeof r.caption !== 'string' || typeof r.observation !== 'string') throw new Error('Malformed coach response');
    return r;
  });
}

export function requestLiveNotes(profileId: string, signal?: AbortSignal): Promise<LiveNotes> {
  return livePost<LiveNotes>('/v1/live/notes', { profileId }, signal);
}
