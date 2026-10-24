import type { CueId } from '../../live/liveCoach';
import type { SoundId } from '../../state/types';
import { livePost } from '../../live/transport';

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
  | { kind: 'silence'; seconds: number };

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

export function sendTurn(
  req: { sessionId: string; profileId: string; event: SessionEvent },
  signal?: AbortSignal,
): Promise<SessionTurn> {
  return livePost<SessionTurn>('/v1/live/session/turn', {
    ...req, expectedRevision: revisions.get(req.sessionId),
  }, signal).then(checkTurn);
}
