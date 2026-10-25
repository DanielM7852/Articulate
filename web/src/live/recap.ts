import { LiveHttpError, getLiveIdentity, livePost } from './transport';

export type RecapTrend = 'improving' | 'same' | 'new' | 'harder';
export type RecapEmailStatus = 'none' | 'queued' | 'sent' | 'failed' | 'not_configured';

export interface RecapFocusArea { part: string; whatHappened: string; trend: RecapTrend }
export interface RecapHabit { title: string; when: string; how: string; minutes: number }
export interface RecapExercise { title: string; targets: string; steps: string[]; reps: string }
export interface Recap {
  headline: string;
  summary: string;
  wins: string[];
  focusAreas: RecapFocusArea[];
  habits: RecapHabit[];
  exercises: RecapExercise[];
  sessionAttempts: number;
}
export interface RecapStatus {
  recapId: string;
  status: 'pending' | 'ready' | 'failed' | 'empty';
  recap: Recap | null;
  error: string | null;
  emailStatus: RecapEmailStatus;
  emailTo: string | null;
}
export interface StartRecapBody {
  profileId: string;
  attemptIds: string[];
  word: string | null;
  email: string | null;
}

/** An HTTP failure from the recap endpoints; `status` lets the screen tell expired (404) from other errors. */
export class RecapHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const EMAIL_KEY = 'articulate.recapEmail';

export function rememberedRecapEmail(): string {
  try {
    return localStorage.getItem(EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberRecapEmail(email: string): void {
  try {
    localStorage.setItem(EMAIL_KEY, email);
  } catch {
    /* storage blocked: the address just is not remembered */
  }
}

/** Keep the HTTP status livePost carries on its error. */
function asHttpError(error: unknown): unknown {
  return error instanceof LiveHttpError ? new RecapHttpError(error.status, error.message) : error;
}

export async function startRecap(body: StartRecapBody, signal?: AbortSignal): Promise<RecapStatus> {
  try {
    return await livePost<RecapStatus>('/v1/live/recap', body, signal);
  } catch (error) {
    throw asHttpError(error);
  }
}

export async function getRecap(recapId: string, profileId: string, signal?: AbortSignal): Promise<RecapStatus> {
  // The guest cookie identity wins over the local id, as it does for livePost.
  const principal = await getLiveIdentity().catch(() => null);
  const id = principal?.shared && principal.profileId ? principal.profileId : profileId;
  const response = await fetch(
    `/v1/live/recap/${encodeURIComponent(recapId)}?profileId=${encodeURIComponent(id)}`,
    { credentials: 'same-origin', signal },
  );
  if (!response.ok) throw new RecapHttpError(response.status, `recap failed (${response.status})`);
  return (await response.json()) as RecapStatus;
}

export async function emailRecap(recapId: string, profileId: string, email: string, signal?: AbortSignal): Promise<RecapStatus> {
  try {
    return await livePost<RecapStatus>(`/v1/live/recap/${encodeURIComponent(recapId)}/email`, { profileId, email }, signal);
  } catch (error) {
    throw asHttpError(error);
  }
}
