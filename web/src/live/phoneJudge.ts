import type { AttemptAudio } from '../audio/attemptAudio';
import type { WordAttemptResult, ZoneResult, ZoneVerdict } from '../game/types';
import type { GhostUnit } from '../game/ghost/types';
import { emit as telemetryEmit } from '../telemetry/client';
import { phonesHttpBase } from './phonesUrl';

/**
 * Phone-recognizer judging for the ghost board. The formant judge still finds the try, its quality and the live cursor;
 * for words in PHONE_JUDGED_WORDS the zone verdicts of the current unit come from the local phone scorer
 * (POST /v1/phones/score) instead. Pure parts are unit-tested; scorePhones is the only I/O.
 */

/** word -> zone id -> phone symbol the recognizer is asked to score. Add words here, then enable them below. */
export const ZONE_PHONES: Record<string, Record<string, string>> = {
  track: { t: 't', r: 'ɹ', a: 'æ', k: 'k' },
  sheep: { sh: 'ʃ', ee: 'i', p: 'p' },
  rent: { r: 'ɹ', e: 'ɛ', n: 'n', t: 't' },
  brain: { b: 'b', r: 'ɹ', ai: 'eɪ', n: 'n' },
};

/** Words whose verdicts are judged by phones and drawn on the phone map (explicit allow-list; the maps above may be wider). */
export const PHONE_JUDGED_WORDS: ReadonlySet<string> = new Set(['track', 'sheep', 'rent', 'brain']);

/** Calibrated on 10 real speakers plus a "tack" near-miss: posterior and goodness-of-pronunciation (log-ratio) cut-offs. */
export const PHONE_HIT_POST = 0.4;
export const PHONE_HIT_GOP = 0;
export const PHONE_PARTIAL_POST = 0.1;
/** Vowels are lenient: accents shift them, so a not-terrible gop keeps a vowel at partial. */
export const PHONE_VOWEL_PARTIAL_GOP = -4;

const MAX_EVIDENCE_KEYS = 24;
const DEFAULT_TIMEOUT_MS = 1500;
/** The board reports an attempt 600 ms after its last voiced frame (WordLesson's CLIP_TAIL_MS), and the clip ends at that report. */
export const ASSUMED_END_LAG_MS = 600;

/** Formant-tracker failures the phone scorer may overrule (it hears speech the tracker missed). Never clipped or silence. */
export const PHONE_RESCUE_REASONS: readonly string[] = ['no-voice', 'too-short'];
/** A rescuable try's clip is at least this long, so a late formant onset does not cut off the word. */
export const RESCUE_MIN_CLIP_MS = 1500;

export function canPhoneRescue(result: WordAttemptResult): boolean {
  return result.quality === 'unclear' && result.qualityReason !== undefined && PHONE_RESCUE_REASONS.includes(result.qualityReason);
}

export interface PhoneTarget {
  p: string;
  startMs: number;
  endMs: number;
  peakMs: number;
  post: number;
  gop: number;
  best: string;
  bestPost: number;
}

export interface PhoneScoreResponse {
  targets: PhoneTarget[];
  phones: { p: string; startMs: number; endMs: number; conf: number }[];
  alignLogProb?: number;
  inferMs?: number;
  model?: string;
  engine?: string;
}

export function isPhoneJudged(word: string): boolean {
  return PHONE_JUDGED_WORDS.has(word) && word in ZONE_PHONES;
}

/** The unit's zones that have a phone, in unit order. */
export function unitPhoneZones(word: string, unit: GhostUnit): { zoneId: string; phone: string }[] {
  const map = ZONE_PHONES[word];
  if (!map || !isPhoneJudged(word)) return [];
  return unit.zoneIds.filter((z) => z in map).map((z) => ({ zoneId: z, phone: map[z] }));
}

export function verdictFromScore(post: number, gop: number, kind: ZoneResult['kind']): ZoneVerdict {
  if (post >= PHONE_HIT_POST && gop >= PHONE_HIT_GOP) return 'hit';
  if (post >= PHONE_PARTIAL_POST || (kind === 'vowel' && gop > PHONE_VOWEL_PARTIAL_GOP)) return 'partial';
  return 'miss';
}

/**
 * A part that is one vowel zone (the a in track). Cut out of the word, a vowel alone is scored on far less context and
 * often lands at partial (a correct æ: 2/10 hit alone vs 7/10 in the word), so it is judged leniently.
 */
export function isLoneVowelUnit(unit: GhostUnit, zones: readonly { zoneId: string; kind: ZoneResult['kind'] }[]): boolean {
  if (unit.zoneIds.length !== 1) return false;
  return zones.some((z) => z.zoneId === unit.zoneIds[0] && z.kind === 'vowel');
}

/** Verdict for a lone vowel part: what verdictFromScore calls partial counts as a hit, below that stays a miss. */
export function loneVowelVerdict(post: number, gop: number): ZoneVerdict {
  return verdictFromScore(post, gop, 'vowel') === 'miss' ? 'miss' : 'hit';
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validates the service payload; null when it is not shaped as the contract says. */
export function parsePhoneResponse(raw: unknown): PhoneScoreResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.targets)) return null;
  const targets: PhoneTarget[] = [];
  for (const t of r.targets) {
    if (!t || typeof t !== 'object') return null;
    const o = t as Record<string, unknown>;
    if (typeof o.p !== 'string' || !num(o.post) || !num(o.startMs) || !num(o.endMs)) return null;
    targets.push({
      p: o.p,
      startMs: o.startMs,
      endMs: o.endMs,
      peakMs: num(o.peakMs) ? o.peakMs : o.startMs,
      post: Math.min(1, Math.max(0, o.post)),
      gop: num(o.gop) ? o.gop : 0,
      best: typeof o.best === 'string' ? o.best : '',
      bestPost: num(o.bestPost) ? o.bestPost : 0,
    });
  }
  const phones = Array.isArray(r.phones)
    ? r.phones.filter((p): p is PhoneScoreResponse['phones'][number] => !!p && typeof (p as { p?: unknown }).p === 'string')
    : [];
  return {
    targets,
    phones,
    alignLogProb: num(r.alignLogProb) ? r.alignLogProb : undefined,
    inferMs: num(r.inferMs) ? r.inferMs : undefined,
    model: typeof r.model === 'string' ? r.model : undefined,
    engine: typeof r.engine === 'string' ? r.engine : undefined,
  };
}

/**
 * Where the clip starts relative to the attempt start. The clip ends at the report time, ~600 ms after the last voiced
 * frame, and is cut `durationMs + 600 + 250` long, so the attempt starts at clipMs - lag - durationMs into the clip
 * (= the 250 ms pre-roll when the cut is full length; clamped to 0 if the ring buffer was shorter). It is an estimate
 * and only moves reported startMs/endMs; verdicts never depend on it.
 */
export function clipOffsetMs(clipDurationMs: number, result: WordAttemptResult, lagMs = ASSUMED_END_LAG_MS): number {
  return Math.max(0, Math.round(clipDurationMs - result.durationMs - lagMs));
}

const phoneEvidence = (t: PhoneTarget): Record<string, number> => ({
  phonePost: t.post,
  phoneGop: t.gop,
  phoneBestPost: t.bestPost,
  phonePeakMs: t.peakMs,
  judgedByPhones: 1,
});

/**
 * Replace the verdicts of the unit's phone-mapped zones with the recognizer's. `response.targets` are in the order of
 * unitPhoneZones(word, unit); `offsetMs` is the clip start relative to the attempt start (times are shifted by it).
 * Unclear results, other zones, `kind` and quality are untouched. Replaced zones drop `advisory` (a phone-judged zone counts toward the score, whatever its kind). Returns the same object when nothing applies.
 */
export function applyPhoneJudgement(
  result: WordAttemptResult,
  unit: GhostUnit,
  response: PhoneScoreResponse,
  offsetMs: number,
): WordAttemptResult {
  const rescue = canPhoneRescue(result);
  if (result.quality !== 'usable' && !rescue) return result;
  const zones = unitPhoneZones(result.word, unit);
  if (zones.length === 0 || response.targets.length !== zones.length) return result;
  if (rescue) {
    // The formant tracker lost the voice; trust the phone scorer only when it clearly heard at least half the unit.
    const heard = response.targets.filter((t) => t.post >= PHONE_PARTIAL_POST).length;
    if (heard < Math.ceil(response.targets.length / 2)) return result;
  }
  const lone = isLoneVowelUnit(unit, result.zones);
  const byZone = new Map(zones.map((z, i) => [z.zoneId, response.targets[i]]));
  const out: ZoneResult[] = result.zones.map((z) => {
    const t = byZone.get(z.zoneId);
    if (!t) return z;
    const startMs = Math.max(0, Math.round(t.startMs - offsetMs));
    const endMs = Math.max(startMs, Math.round(t.endMs - offsetMs));
    const mine = phoneEvidence(t);
    const evidence: Record<string, number> = { ...z.evidence };
    for (const k of Object.keys(evidence)) if (!Number.isFinite(evidence[k])) delete evidence[k];
    for (const [k, v] of Object.entries(mine)) {
      if (Number.isFinite(v)) evidence[k] = v;
      else delete evidence[k];
    }
    // Stay within the backend's key budget: drop older non-phone keys first.
    for (const k of Object.keys(evidence)) {
      if (Object.keys(evidence).length <= MAX_EVIDENCE_KEYS) break;
      if (!(k in mine)) delete evidence[k];
    }
    const { advisory: _advisory, ...rest } = z;
    return { ...rest, verdict: lone && z.kind === 'vowel' ? loneVowelVerdict(t.post, t.gop) : verdictFromScore(t.post, t.gop, z.kind), startMs, endMs, dwellMs: Math.max(0, endMs - startMs), evidence };
  });
  if (rescue) {
    // The tracker's duration is too short here; the aligned phones span the word, so the coach clip covers all of it.
    const span = Math.max(...response.targets.map((t) => t.endMs)) - Math.min(...response.targets.map((t) => t.startMs));
    const { qualityReason: _dropped, ...rest } = result;
    return { ...rest, quality: 'usable', durationMs: Math.max(result.durationMs, Math.round(span)), zones: out };
  }
  return { ...result, zones: out };
}


let informed = false;
function inform(why: string) {
  if (informed) return;
  informed = true;
  console.warn(`[phones] live phone model unavailable (scoring: ${why}); the board is using the basic formant view.`);
}

/** Score the clip against the targets. Null on any failure, timeout, abort or non-200. Never throws. */
export async function scorePhones(
  clip: AttemptAudio,
  targets: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch; baseUrl?: string; word?: string; attemptId?: string } = {},
): Promise<PhoneScoreResponse | null> {
  const started = performance.now();
  // Dashboard telemetry (kind-routed, ui -> db) after each POST. `word` falls back to the target phones;
  // `attemptId` ties the event to the attempt being judged.
  const report = (ok: boolean) => {
    const word = (opts.word ?? targets.join('')).slice(0, 40);
    const attempt = opts.attemptId ? { attemptId: opts.attemptId } : {};
    telemetryEmit('ui', 'db', 'phones.score', `phones ${word} ${ok ? 'scored' : 'failed'}`, { word, ms: Math.round(performance.now() - started), ok, ...attempt });
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const outer = opts.signal;
  const onAbort = () => ctl.abort();
  if (outer) {
    if (outer.aborted) ctl.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const f = opts.fetchImpl ?? fetch;
    const res = await f(`${opts.baseUrl ?? phonesHttpBase()}/v1/phones/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: clip.data, targets }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      inform(`HTTP ${res.status}`);
      report(false);
      return null;
    }
    const parsed = parsePhoneResponse(await res.json());
    if (!parsed || parsed.targets.length !== targets.length) {
      inform('unexpected response');
      report(false);
      return null;
    }
    report(true);
    return parsed;
  } catch (e) {
    inform(e instanceof Error ? e.name : 'error');
    report(false);
    return null;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}
