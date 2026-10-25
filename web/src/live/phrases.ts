import { LiveHttpError, getLiveIdentity, livePost } from './transport';

export interface Phrase { id: string; text: string; targets: string[]; tip: string }
export type PhraseOverall = 'clear' | 'almost' | 'try_again' | 'unclear';
export type PhraseWordResult = 'clear' | 'try_again' | 'missed';
export interface PhraseAssessment {
  /** False only when scoring isn't set up; when true but `scored` is false the clip couldn't be checked. */
  scoringAvailable: boolean;
  scored: boolean;
  overall: PhraseOverall;
  words: { word: string; result: PhraseWordResult }[];
}

/** An HTTP failure from the phrase endpoints; `status` lets the screen tell rate limits (429) from other errors. */
export class PhrasesHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function asHttpError(error: unknown): unknown {
  return error instanceof LiveHttpError ? new PhrasesHttpError(error.status, error.message) : error;
}

async function resolveProfileId(profileId: string): Promise<string> {
  // The guest cookie identity wins over the local id, as it does for livePost.
  const principal = await getLiveIdentity().catch(() => null);
  return principal?.shared && principal.profileId ? principal.profileId : profileId;
}

export async function getAbout(profileId: string, signal?: AbortSignal): Promise<string | null> {
  const id = await resolveProfileId(profileId);
  const response = await fetch(`/v1/live/about?profileId=${encodeURIComponent(id)}`, { credentials: 'same-origin', signal });
  if (!response.ok) throw new PhrasesHttpError(response.status, `about failed (${response.status})`);
  return ((await response.json()) as { aboutMe: string | null }).aboutMe;
}

export async function saveAbout(profileId: string, aboutMe: string, signal?: AbortSignal): Promise<string | null> {
  const id = await resolveProfileId(profileId);
  const response = await fetch('/v1/live/about', {
    method: 'PUT', credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: id, aboutMe }),
  });
  if (!response.ok) throw new PhrasesHttpError(response.status, `about failed (${response.status})`);
  return ((await response.json()) as { aboutMe: string | null }).aboutMe;
}

export async function makePhrases(
  body: { profileId: string; recapId: string | null; aboutMe: string | null }, signal?: AbortSignal,
): Promise<Phrase[]> {
  try {
    return (await livePost<{ phrases: Phrase[] }>('/v1/live/phrases', body, signal)).phrases;
  } catch (error) {
    throw asHttpError(error);
  }
}

export async function assessPhrase(
  body: { profileId: string; text: string; audioWav: string }, signal?: AbortSignal,
): Promise<PhraseAssessment> {
  try {
    return await livePost<PhraseAssessment>('/v1/live/phrases/assess', body, signal);
  } catch (error) {
    throw asHttpError(error);
  }
}
