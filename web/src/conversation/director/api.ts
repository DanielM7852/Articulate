import type { CueId } from '../../live/liveCoach';
import type { SoundId } from '../../state/types';
import { getLiveIdentity, livePost } from '../../live/transport';

/** Typed client for local turns or durable shared jobs. Calls throw on errors or the transport deadline. */
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
  revision?: number | null;
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

const ACTIONS: TurnAction[] = ['demonstrate', 'prompt_attempt', 'await_reply', 'next_sound', 'end_session'];
const revisions = new Map<string, number>();

function checkTurn(t: SessionTurn): SessionTurn {
  if (!t || typeof t.say !== 'string' || !ACTIONS.includes(t.action) || typeof t.sessionId !== 'string') {
    throw new Error('Malformed session turn');
  }
  if (t.revision != null) revisions.set(t.sessionId, t.revision);
  return t;
}

export function startSession(
  req: { profileId: string; displayName: string; sounds: SoundId[] | null },
  signal?: AbortSignal,
): Promise<SessionStart> {
  return livePost<SessionStart>('/v1/live/session/start', req, signal).then(checkTurn);
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
    let id = profileId;
    try {
      const principal = await getLiveIdentity();
      if (principal.shared && principal.profileId) id = principal.profileId;
    } catch { /* identity unavailable: keep the caller's profile */ }
    const url = `/v1/live/articulation/${encodeURIComponent(attemptId)}?profileId=${encodeURIComponent(id)}`;
    const res = await fetch(url, { credentials: 'same-origin', signal: ctl.signal });
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
  return livePost<SessionTurn>('/v1/live/session/turn', {
    ...req, expectedRevision: revisions.get(req.sessionId),
  }, signal).then(checkTurn);
}
