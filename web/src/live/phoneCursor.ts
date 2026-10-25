import { normPhone, type Phone } from './phoneStream';

/**
 * Pure mapping from the live phone stream to the ghost-board cursor. The board matches the phones heard since the
 * attempt was armed, in order, against the unit's target phones: each matched target moves the cursor to that zone's
 * circle; a wrong sound where a target was expected sends it off the path until the right one arrives.
 */

/** Phones below this confidence are ignored. */
export const MIN_PHONE_CONF = 0.3;
/** Updates arriving within this many ms of a client reset are stale (in flight from before it) and dropped. */
export const RESET_GUARD_MS = 350;

/** Vowel-like glides a stream commonly inserts between targets (e.g. r -> schwa -> ae). One of these per gap is tolerated. */
const COARTICULATION = new Set(['ə', 'ɐ', 'ɨ', 'ɚ', 'ᵻ']);

export interface PhoneCursorState {
  /** How many targets have been matched, in order (0..targets.length). */
  matched: number;
  /** True while the latest significant phone was a wrong sound where a target was expected. */
  veer: boolean;
  /** The latest significant (non-noise) phone, normalised, or null. */
  lastPhone: string | null;
}

/** Symbols that are noise, not sounds: glottal stop, blanks, specials like <unk>, and anything without a letter. */
export function isNoisePhone(p: string): boolean {
  const q = p.trim();
  if (!q || q === 'ʔ' || q === '|' || q === '_') return true;
  if (/^<.*>$/.test(q) || /^(sil|spn|sp|unk|pad)$/i.test(q)) return true;
  return !/\p{L}/u.test(q);
}

/** committed first, then provisional phones that end after the last committed one (the stream may overlap them). */
export function mergeHeard(committed: readonly Phone[], provisional: readonly Phone[]): Phone[] {
  const lastEnd = committed.length ? committed[committed.length - 1].endMs : -Infinity;
  return [...committed, ...provisional.filter((p) => p.endMs > lastEnd)];
}

/**
 * Match `phones` (in time order, committed + provisional) against `targets`. Recomputed from scratch on every update, so a
 * provisional phone that disappears simply stops counting. Rules, per significant phone:
 *  - equals the next target (after norm): matched, veer cleared
 *  - repeats the last matched target (aspiration split, doubled): ignored
 *  - equals a LATER target: the targets in between were skipped and count as matched (the learner clearly moved on)
 *  - a coarticulation glide (schwa etc.), once per gap: tolerated, no veer
 *  - anything else while targets remain: veer
 */
export function phoneCursorState(targets: readonly string[], phones: readonly Phone[]): PhoneCursorState {
  const want = targets.map(normPhone);
  let matched = 0;
  let veer = false;
  let last: string | null = null;
  let toleratedInGap = false;
  for (const ph of phones) {
    if (ph.conf < MIN_PHONE_CONF || isNoisePhone(ph.p)) continue;
    const p = normPhone(ph.p);
    last = p;
    if (matched >= want.length) continue;
    if (p === want[matched]) {
      matched++;
      veer = false;
      toleratedInGap = false;
      continue;
    }
    if (matched > 0 && p === want[matched - 1]) continue;
    const later = want.indexOf(p, matched + 1);
    if (later !== -1) {
      matched = later + 1;
      veer = false;
      toleratedInGap = false;
      continue;
    }
    if (COARTICULATION.has(p) && !toleratedInGap) {
      toleratedInGap = true;
      continue;
    }
    veer = true;
  }
  return { matched, veer, lastPhone: last };
}
