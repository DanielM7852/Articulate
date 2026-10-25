import { livePost } from './transport';

/** Client for POST /v1/live/consonant: one "tr" / "ck" attempt in the word "track", judged by the backend's OpenAI coach. */

export type ConsonantPart = 'tr' | 'ck';
export type ConsonantVerdict = 'got_it' | 'try_again' | 'unclear';

export interface ConsonantHistoryItem {
  verdict: ConsonantVerdict;
  caption: string;
}

export interface ConsonantRequest {
  word: 'track';
  part: ConsonantPart;
  /** Base64 of a mono 16 kHz WAV. */
  audioWav: string;
  /** Up to 6 previous attempts on this part, most recent last. */
  history?: ConsonantHistoryItem[];
}

export interface AzurePhoneme {
  phoneme: string;
  accuracy: number | null;
  nbest: { phoneme: string; score: number | null }[];
}

/** Azure Pronunciation Assessment evidence; available is false when Azure is not configured or failed. */
export interface AzureEvidence {
  available: boolean;
  partScore: number | null;
  phonemes: AzurePhoneme[];
  accuracy: number | null;
  fluency: number | null;
  completeness: number | null;
  pron: number | null;
  errorType: string | null;
}

export const NO_AZURE: AzureEvidence = { available: false, partScore: null, phonemes: [], accuracy: null, fluency: null, completeness: null, pron: null, errorType: null };

export interface ConsonantResponse {
  verdict: ConsonantVerdict;
  caption: string;
  cue: string;
  fallback: boolean;
  model: string | null;
  timingsMs: { acoustics: number; model: number; total: number; azure?: number };
  acoustics: Record<string, unknown>;
  azure: AzureEvidence;
}

const VERDICTS: ConsonantVerdict[] = ['got_it', 'try_again', 'unclear'];

/**
 * livePost adds the learner/guest profileId when the backend uses shared identity and handles job polling.
 * Throws on any failure; the caller must never treat a failure as a pass.
 */
export async function requestConsonant(
  { part, audioWav, history }: Pick<ConsonantRequest, 'part' | 'audioWav' | 'history'>,
  signal?: AbortSignal,
): Promise<ConsonantResponse> {
  const body: ConsonantRequest = { word: 'track', part, audioWav, history: (history ?? []).slice(-6) };
  const r = await livePost<ConsonantResponse>('/v1/live/consonant', body, signal);
  if (!r || !VERDICTS.includes(r.verdict) || typeof r.caption !== 'string') throw new Error('Malformed consonant response');
  const a = r.azure as Partial<AzureEvidence> | undefined;
  const azure: AzureEvidence =
    a && a.available === true && Array.isArray(a.phonemes)
      ? { ...NO_AZURE, ...a, available: true, phonemes: a.phonemes.filter((p) => p && typeof p.phoneme === 'string') }
      : NO_AZURE;
  return { ...r, cue: typeof r.cue === 'string' ? r.cue : '', azure };
}
