import { foldPhone, phonePlace, type PhonePlace } from '../game/ghost/phoneMap';
import { MIN_PHONE_CONF, isNoisePhone } from './phoneCursor';
import type { Phone, PhoneFrame } from './phoneStream';

/**
 * Pure maths of the phone-map cursor: the probability-weighted average of the map places of the phones the model hears.
 */

/** A frame counts only while the model is sure it is not silence (mass = 1 - blank probability). */
export const CENTROID_MIN_MASS = 0.5;
/** Frames whose top symbols (those on the map) carry less probability than this are ignored. */
export const CENTROID_MIN_WEIGHT = 0.3;
/** The cursor's exponential easing time constant toward the newest centroid. */
export const CURSOR_TAU_MS = 70;

/** Centroid of one frame: sum(p * place) / sum(p) over top symbols on the map (folded); null when gated out. */
export function frameCentroid(frame: PhoneFrame): PhonePlace | null {
  if (!(frame.mass >= CENTROID_MIN_MASS)) return null;
  let w = 0;
  let x = 0;
  let y = 0;
  for (const [sym, p] of frame.top) {
    const place = phonePlace(sym);
    if (!place || !(p > 0)) continue;
    w += p;
    x += p * place.x;
    y += p * place.y;
  }
  if (w < CENTROID_MIN_WEIGHT) return null;
  return { x: x / w, y: y / w };
}

/**
 * Cursor position constrained to the word's path. When the target sounds outweigh everything else heard, the cursor
 * sits on the dominant target, or slides along the segment toward its stronger path neighbour. Otherwise it is the
 * free centroid, so a real veer to a non-target sound still shows. Null when gated out.
 */
export function pathCentroid(frame: PhoneFrame, targets: readonly string[]): PhonePlace | null {
  if (!(frame.mass >= CENTROID_MIN_MASS)) return null;
  const free = frameCentroid(frame);
  if (!free) return null;
  const folded = targets.map(foldPhone);
  const places = targets.map((t) => phonePlace(t));
  const w = targets.map(() => 0);
  let off = 0;
  for (const [sym, p] of frame.top) {
    if (!phonePlace(sym) || !(p > 0)) continue;
    const f = foldPhone(sym);
    const i = folded.findIndex((t, k) => t === f && places[k] !== null);
    if (i >= 0) w[i] += p;
    else off += p;
  }
  const W = w.reduce((a, b) => a + b, 0);
  if (W === 0 || W < off) return free;
  let i = 0;
  for (let k = 1; k < w.length; k++) if (w[k] > w[i]) i = k;
  const hasL = i > 0;
  const hasR = i < w.length - 1;
  let j = -1;
  if (hasL && hasR) j = w[i + 1] >= w[i - 1] ? i + 1 : i - 1;
  else if (hasR) j = i + 1;
  else if (hasL) j = i - 1;
  const a = places[i]!;
  if (j < 0 || !(w[j] > 0)) return { x: a.x, y: a.y };
  const b = places[j]!;
  const f = w[j] / (w[i] + w[j]);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** The newest usable centroid among `frames` (oldest first), or null. */
export function newestCentroid(frames: readonly PhoneFrame[]): PhonePlace | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    const c = frameCentroid(frames[i]);
    if (c) return c;
  }
  return null;
}

/** Fallback for servers without frames: the map place of the latest significant heard phone on the map, or null. */
export function latestPhonePlace(phones: readonly Phone[]): PhonePlace | null {
  for (let i = phones.length - 1; i >= 0; i--) {
    const ph = phones[i];
    if (ph.conf < MIN_PHONE_CONF || isNoisePhone(ph.p)) continue;
    const place = phonePlace(ph.p);
    if (place) return place;
  }
  return null;
}

/** One step of exponential easing of `cur` toward `target` over `dtMs` with time constant `tauMs`. */
export function easePlace(cur: PhonePlace, target: PhonePlace, dtMs: number, tauMs = CURSOR_TAU_MS): PhonePlace {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  return { x: cur.x + (target.x - cur.x) * k, y: cur.y + (target.y - cur.y) * k };
}
