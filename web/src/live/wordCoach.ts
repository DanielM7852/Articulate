import type { WordAttemptResult, ZoneResult } from '../game/types';
import type { LiveCoachRequest, LiveCoachResponse, WordScore } from './liveCoach';
import { livePost } from './transport';

/**
 * Word coaching on /v1/live/coach (word mode), plus the same deterministic line the backend falls back to,
 * for when the backend cannot be reached. The roll-up and the fallback mirror backend/app/live/scoring.py
 * (score_word) and backend/app/live/decision.py (word_fallback_line); keep them in sync.
 */

/** Word mode still sends a vowel so stored history keeps its shape: the word's vowel nucleus. */
const WORD_SOUND: Record<string, 'i' | 'u' | 'a'> = { track: 'a', sheep: 'i', rent: 'a', brain: 'a' };

interface ZoneLines {
  /** Where the zone sits in the word, for the spoken line. Mirrors ZoneInfo.position in backend/app/live/words.py. */
  position: string;
  /** Mirrors ZoneInfo.hint. */
  hint: string;
  /** Mirrors ZoneInfo.hint_no_camera: no lip/jaw words (those are only named with a usable camera). */
  noCamera: string;
}

const R_HINT = 'Curl the tongue tip back, or bunch it up, and keep the voice going.';
const N_HINT = 'Tongue tip up behind the teeth and let the voice hum through the nose.';
const T_HINT = 'Tongue tip up behind the teeth, then let go.';

const same = (position: string, hint: string): ZoneLines => ({ position, hint, noCamera: hint });

/** Mirrors the zone table in backend/app/live/words.py (track, sheep, rent, brain). */
const ZONE_LINES: Record<string, Record<string, ZoneLines>> = {
  track: {
    t: same('at the start', T_HINT),
    r: same('after the t', R_HINT),
    a: { position: 'in the middle', hint: 'Jaw open, tongue low and forward.', noCamera: 'Open wide, tongue low and forward.' },
    k: same('at the end', 'Back of the tongue up, then release.'),
  },
  sheep: {
    sh: same('at the start', 'Pull the tongue back a little, then push a long, soft stream of air.'),
    ee: { position: 'in the middle', hint: 'Lips spread wide, tongue high and forward.', noCamera: 'Tongue high and forward, held steady.' },
    p: {
      position: 'at the end',
      hint: 'Close the lips, build a little air, then let it pop.',
      noCamera: 'Seal the front of the mouth, build a little air, then let it pop.',
    },
  },
  rent: {
    r: same('at the start', R_HINT),
    e: {
      position: 'in the middle',
      hint: 'Jaw half open, tongue in the middle and a little forward.',
      noCamera: 'Tongue in the middle and a little forward.',
    },
    n: same('after the e', N_HINT),
    t: same('at the end', T_HINT),
  },
  brain: {
    b: {
      position: 'at the start',
      hint: 'Close the lips, then pop them open with your voice on.',
      noCamera: 'Seal the front of the mouth, then pop it open with your voice on.',
    },
    r: same('after the b', R_HINT),
    ai: {
      position: 'in the middle',
      hint: 'Start with the jaw half open, then glide up toward a smile.',
      noCamera: 'Start with the tongue in the middle, then glide up and forward.',
    },
    n: same('at the end', N_HINT),
  },
};

const MISSING: ZoneResult['verdict'][] = ['miss', 'skipped'];

const isPhoneJudged = (z: ZoneResult) => z.evidence?.judgedByPhones === 1;

/** Advisory zones (liquid, fricative, nasal) are guidance only and never count toward a score, unless the phone model judged them. */
const isAdvisory = (z: ZoneResult) =>
  !isPhoneJudged(z) && (z.advisory === true || z.kind === 'liquid' || z.kind === 'fricative' || z.kind === 'nasal');

/**
 * Mirrors score_word. With `practice` the roll-up covers only the listed zones. When no counted zone is left
 * (a cue-only or liquid-only part) the verdict is "close" with zoneCount 0: that is "not scored", never a score.
 */
export function scoreWord(
  result: WordAttemptResult,
  practice?: string[] | null,
): Pick<WordScore, 'verdict' | 'hitCount' | 'zoneCount' | 'weakestZoneId'> {
  const zones = practice ? result.zones.filter((z) => practice.includes(z.zoneId)) : result.zones;
  const counted = zones.filter((z) => !isAdvisory(z));
  const hitCount = counted.filter((z) => z.verdict === 'hit').length;
  if (result.quality !== 'usable') return { verdict: 'insufficient', hitCount, zoneCount: counted.length, weakestZoneId: null };
  if (counted.length === 0) return { verdict: 'close', hitCount: 0, zoneCount: 0, weakestZoneId: zones[0]?.zoneId ?? null };
  const missed = counted.find((z) => MISSING.includes(z.verdict))?.zoneId ?? null;
  const partial = counted.find((z) => z.verdict === 'partial')?.zoneId ?? null;
  const verdict = missed ? 'off' : partial ? 'close' : 'on_target';
  return { verdict, hitCount, zoneCount: counted.length, weakestZoneId: missed ?? partial };
}

/** True when the roll-up counted at least one zone, i.e. its verdict is a real score. */
export const isScored = (score: { zoneCount: number | null | undefined }) => (score.zoneCount ?? 0) > 0;

const firstSentence = (text: string) => text.trim().split(/(?<=[.!?])\s+/)[0] ?? text.trim();

/** The labels the fallback names; both the offline GhostWordSpec and the old WordSpec fit. */
export interface FallbackSpec {
  zones: { id: string; label: string }[];
}

/** Joined labels of the practised zones when they are a strict part of the word (the backend's _practice_label), else null. */
function partLabel(spec: FallbackSpec, practice?: string[] | null): string | null {
  if (!practice || practice.length === 0) return null;
  const part = spec.zones.filter((z) => practice.includes(z.id));
  if (part.length === 0 || part.length >= spec.zones.length) return null;
  return part.map((z) => z.label).join('') || null;
}

/** What the learner is asked to say: the practised part ("the tr in track") or the whole word. */
function spokenName(spec: FallbackSpec, word: string, practice?: string[] | null): string {
  if (!practice || practice.length === 0) return word;
  const part = spec.zones.filter((z) => practice.includes(z.id));
  if (part.length === 0 || part.length >= spec.zones.length) return word;
  return `the ${part.map((z) => z.label).join('')} in ${word}`;
}

/** The caption the backend's deterministic fallback would produce, and the zone it coaches. */
export function wordFallbackLine(
  spec: FallbackSpec,
  result: WordAttemptResult,
  practice?: string[] | null,
): { caption: string; focusZoneId: string | null } {
  const word = result.word;
  const score = scoreWord(result, practice);
  if (score.verdict === 'insufficient') {
    const name = spokenName(spec, word, practice);
    const caption =
      result.qualityReason === 'clipped'
        ? `That was a bit loud for me. Say ${name} once more, a little softer.`
        : result.qualityReason === 'too-short'
          ? `That went by quickly. Say ${name} once more, at an easy pace.`
          : `I couldn't catch ${name} that time. Say it once more, clear and steady.`;
    return { caption, focusZoneId: null };
  }
  const id = score.weakestZoneId;
  if (!id) {
    const part = partLabel(spec, practice);
    return { caption: part ? `The ${part} in ${word} landed. Nice work.` : practice ? `That part of ${word} landed. Nice work.` : `Every part of ${word} landed. Nice work.`, focusZoneId: null };
  }
  const zone = result.zones.find((z) => z.zoneId === id)!;
  const label = spec.zones.find((z) => z.id === id)?.label ?? zone.phoneme;
  const lines = ZONE_LINES[word]?.[id];
  const where = lines?.position ? ` ${lines.position}` : '';
  const hint = firstSentence((result.lipUsable ? lines?.hint : lines?.noCamera) || 'Watch the side view, then try once more.');
  if (isAdvisory(zone)) return { caption: `Let's work on the ${label}${where}. ${hint}`, focusZoneId: id };
  let lead: string;
  if (isPhoneJudged(zone) && (zone.kind === 'liquid' || zone.kind === 'fricative' || zone.kind === 'nasal')) {
    lead = zone.verdict === 'partial' ? `The ${label}${where} was faint.` : `The ${label}${where} didn't come through.`;
  } else if (zone.verdict === 'partial') lead = zone.kind === 'stop' ? `The ${label}${where} was faint.` : `The ${label}${where} was nearly there.`;
  else lead = zone.kind === 'stop' || zone.verdict === 'skipped' ? `The ${label}${where} went missing.` : `The ${label}${where} didn't reach its target yet.`;
  return { caption: `${lead} ${hint}`, focusZoneId: id };
}

export interface WordCoachInput {
  result: WordAttemptResult;
  profileId: string;
  /** The zones of the part being practised; absent means the whole word. Sent top-level. */
  practiceZoneIds?: string[];
  /** Short WAV of the attempt; omitted from the request when null/undefined. */
  audio?: { format: 'wav'; data: string; durationMs: number } | null;
}

/** POST one word attempt. Throws on any failure so the caller can use wordFallbackLine. */
export function requestWordCoach({ result, profileId, practiceZoneIds, audio }: WordCoachInput, signal?: AbortSignal): Promise<LiveCoachResponse> {
  const sound = WORD_SOUND[result.word] ?? 'a';
  const request: LiveCoachRequest & { practiceZoneIds?: string[] } = {
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
    ...(practiceZoneIds ? { practiceZoneIds } : {}),
    ...(audio ? { attemptAudio: audio } : {}),
  };
  // Loaded on demand: liveCoach pulls in telemetry (import.meta.env), which the pure helpers here must not need in tests.
  return import('./liveCoach').then((m) => m.requestLiveCoach(request, signal));
}

export interface WordAskInput {
  profileId: string;
  word: string;
  question: string;
  lastCoaching: { caption: string; focusZoneId: string | null } | null;
  lastAttempt: { verdict: string | null; hitCount: number | null; zoneCount: number | null; weakestZoneId: string | null } | null;
  tries: number;
  /** The part(s) of the word being practised now; absent means the whole word. */
  practiceZoneIds?: string[];
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
