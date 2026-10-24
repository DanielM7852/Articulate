import type { WordAttemptResult, WordSpec, ZoneResult } from '../game/types';
import { requestLiveCoach, type LiveCoachResponse, type WordScore } from './liveCoach';
import { livePost } from './transport';

/**
 * Word coaching on /v1/live/coach (word mode), plus the same deterministic line the backend falls back to,
 * for when the backend cannot be reached. The roll-up and the fallback mirror backend/app/live/scoring.py
 * (score_word) and backend/app/live/decision.py (word_fallback_line); keep them in sync.
 */

/** Word mode still sends a vowel so stored history keeps its shape: the word's vowel nucleus. */
const WORD_SOUND = { track: 'a' } as const satisfies Record<string, 'i' | 'u' | 'a'>;

/** Where each zone sits in the word, for the spoken line. Mirrors ZoneInfo.position in backend/app/live/words.py. */
const ZONE_POSITION: Record<string, Record<string, string>> = {
  track: { t: 'at the start', r: 'after the t', a: 'in the middle', k: 'at the end' },
};

/** Camera-free hint (no lip/jaw words: those are only named with a usable camera). Mirrors hint_no_camera. */
const NO_CAMERA_HINT: Record<string, Record<string, string>> = {
  track: { a: 'Open wide, tongue low and forward.' },
};

const MISSING: ZoneResult['verdict'][] = ['miss', 'skipped'];

export function scoreWord(result: WordAttemptResult): Pick<WordScore, 'verdict' | 'hitCount' | 'zoneCount' | 'weakestZoneId'> {
  const hitCount = result.zones.filter((z) => z.verdict === 'hit').length;
  const zoneCount = result.zones.length;
  if (result.quality !== 'usable') return { verdict: 'insufficient', hitCount, zoneCount, weakestZoneId: null };
  const missed = result.zones.find((z) => MISSING.includes(z.verdict))?.zoneId ?? null;
  const partial = result.zones.find((z) => z.verdict === 'partial')?.zoneId ?? null;
  const verdict = missed ? 'off' : partial ? 'close' : 'on_target';
  return { verdict, hitCount, zoneCount, weakestZoneId: missed ?? partial };
}

const firstSentence = (text: string) => text.trim().split(/(?<=[.!?])\s+/)[0] ?? text.trim();

/** The caption the backend's deterministic fallback would produce, and the zone it coaches. */
export function wordFallbackLine(spec: WordSpec, result: WordAttemptResult): { caption: string; focusZoneId: string | null } {
  const word = result.word;
  const score = scoreWord(result);
  if (score.verdict === 'insufficient') {
    const caption =
      result.qualityReason === 'clipped'
        ? `That was a bit loud for me. Say ${word} once more, a little softer.`
        : result.qualityReason === 'too-short'
          ? `That went by quickly. Say ${word} once more, at an easy pace.`
          : `I couldn't catch ${word} that time. Say it once more, clear and steady.`;
    return { caption, focusZoneId: null };
  }
  const id = score.weakestZoneId;
  if (!id) return { caption: `Every part of ${word} landed. Nice work.`, focusZoneId: null };
  const zone = result.zones.find((z) => z.zoneId === id)!;
  const specZone = spec.zones.find((z) => z.id === id);
  const label = specZone?.label ?? zone.phoneme;
  const position = ZONE_POSITION[word]?.[id];
  const where = position ? ` ${position}` : '';
  const hintText = (!result.lipUsable && NO_CAMERA_HINT[word]?.[id]) || specZone?.hint || 'Watch the side view, then try once more.';
  const hint = firstSentence(hintText);
  let lead: string;
  if (zone.verdict === 'partial') lead = zone.kind === 'stop' ? `The ${label}${where} was faint.` : `The ${label}${where} was nearly there.`;
  else lead = zone.kind === 'stop' || zone.verdict === 'skipped' ? `The ${label}${where} went missing.` : `The ${label}${where} didn't reach its target yet.`;
  return { caption: `${lead} ${hint}`, focusZoneId: id };
}

export interface WordCoachInput {
  result: WordAttemptResult;
  profileId: string;
}

/** POST one word attempt. Throws on any failure so the caller can use wordFallbackLine. */
export function requestWordCoach({ result, profileId }: WordCoachInput, signal?: AbortSignal): Promise<LiveCoachResponse> {
  const sound = WORD_SOUND[result.word as keyof typeof WORD_SOUND] ?? 'a';
  return requestLiveCoach(
    {
      attemptId: result.attemptId,
      profileId,
      sound,
      metricsSource: 'inline',
      clientSummary: {
        durationSec: Math.round(result.durationMs) / 1000,
        // The board measures zones, not voiced time; the word coach does not use this field.
        usableVoicedSec: 0,
        timeInTargetSec: null,
        longestHoldSec: null,
        quality: result.quality,
        qualityReason: result.qualityReason ?? null,
      },
      frames: { audio: [], video: [] },
      word: result,
    },
    signal,
  );
}

export interface WordAskInput {
  profileId: string;
  word: string;
  question: string;
  lastCoaching: { caption: string; focusZoneId: string | null } | null;
  lastAttempt: { verdict: string | null; hitCount: number | null; zoneCount: number | null; weakestZoneId: string | null } | null;
  tries: number;
}

export interface WordAskResponse {
  say: string;
  source: 'model' | 'fallback';
}

/** POST a learner's speech question to the word coach (Ava delegates these). Throws on any failure. */
export function requestWordAsk(input: WordAskInput, signal?: AbortSignal): Promise<WordAskResponse> {
  return livePost<WordAskResponse>('/v1/live/word/ask', input, signal).then((r) => {
    if (!r || typeof r.say !== 'string' || !r.say.trim()) throw new Error('Malformed ask response');
    return r;
  });
}
