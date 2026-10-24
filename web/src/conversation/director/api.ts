import type { CueId } from '../../live/liveCoach';
import type { SoundId } from '../../state/types';

/** Typed client for the conversational session endpoints. Every call throws on failure (incl. 20 s timeout). */
export type TurnAction = 'demonstrate' | 'prompt_attempt' | 'await_reply' | 'next_sound' | 'end_session';

export interface SessionTurn {
  sessionId: string;
  say: string;
  action: TurnAction;
  sound: SoundId;
  cueId: CueId | null;
  showSideView: boolean;
  source: 'agent' | 'fallback' | 'scripted';
  timingsMs: { llm: number; total: number } | null;
}

export type SessionStart = SessionTurn;

export interface AttemptCoachSummary {
  caption: string;
  cueId: CueId | null;
  nextAction: 'retry' | 'next_sound' | 'rest';
  audioVerdict: string;
  videoVerdict: string | null;
}

export type ControlKind = 'ready' | 'show_again' | 'skip' | 'end';

export type SessionEvent =
  | { kind: 'utterance'; text: string; currentSound: SoundId }
  | { kind: 'attempt_feedback'; attemptId: string; currentSound: SoundId; coach: AttemptCoachSummary }
  | { kind: 'control'; control: ControlKind }
  | { kind: 'silence'; seconds: number }
  | { kind: 'analysis_ready'; attemptId: string; currentSound: SoundId };

const TIMEOUT_MS = 20_000;
const ACTIONS: TurnAction[] = ['demonstrate', 'prompt_attempt', 'await_reply', 'next_sound', 'end_session'];

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

function checkTurn(t: SessionTurn): SessionTurn {
  if (!t || typeof t.say !== 'string' || !ACTIONS.includes(t.action) || typeof t.sessionId !== 'string') {
    throw new Error('Malformed session turn');
  }
  return t;
}

export function startSession(
  req: { profileId: string; displayName: string; sounds: SoundId[] | null },
  signal?: AbortSignal,
): Promise<SessionStart> {
  return post<SessionStart>('/v1/live/session/start', req, signal).then(checkTurn);
}

export type ArticulationStatus = 'pending' | 'ready' | 'none' | 'delivered' | 'unknown';
const STATUSES: ArticulationStatus[] = ['pending', 'ready', 'none', 'delivered', 'unknown'];
const STATUS_TIMEOUT_MS = 5_000;

/** Status of the background articulation analysis for one attempt. Throws on network error or non-2xx. */
export async function getArticulationStatus(
  attemptId: string,
  profileId: string,
  signal?: AbortSignal,
): Promise<{ status: ArticulationStatus; sound: SoundId | null }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), STATUS_TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  if (signal?.aborted) ctl.abort();
  else signal?.addEventListener('abort', onAbort);
  try {
    const url = `/v1/live/articulation/${encodeURIComponent(attemptId)}?profileId=${encodeURIComponent(profileId)}`;
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`${url} failed (${res.status})`);
    const j = (await res.json()) as { status?: ArticulationStatus; sound?: SoundId | null };
    if (!j || !STATUSES.includes(j.status as ArticulationStatus)) throw new Error('Malformed articulation status');
    return { status: j.status as ArticulationStatus, sound: j.sound ?? null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function sendTurn(
  req: { sessionId: string; profileId: string; event: SessionEvent },
  signal?: AbortSignal,
): Promise<SessionTurn> {
  return post<SessionTurn>('/v1/live/session/turn', req, signal).then(checkTurn);
}
