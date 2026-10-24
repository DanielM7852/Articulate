import type { SoundId } from '../state/types';
import type { AudioFrame, RecordedLipFrame } from './attemptRecorder';

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

const TIMEOUT_MS = 20_000;

/** Learner name slugged to [A-Za-z0-9_.:@-]{1,64}; "guest" when nothing usable remains. */
export function profileIdFor(name: string | null | undefined): string {
  const slug = (name ?? '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_.:@-]/g, '')
    .slice(0, 64);
  return slug || 'guest';
}

async function post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`${url} failed (${res.status})`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function requestLiveCoach(req: LiveCoachRequest, signal?: AbortSignal): Promise<LiveCoachResponse> {
  return post<LiveCoachResponse>('/v1/live/coach', req, signal).then((r) => {
    if (!r || typeof r.caption !== 'string' || typeof r.observation !== 'string') throw new Error('Malformed coach response');
    return r;
  });
}

export function requestLiveNotes(profileId: string, signal?: AbortSignal): Promise<LiveNotes> {
  return post<LiveNotes>('/v1/live/notes', { profileId }, signal);
}
