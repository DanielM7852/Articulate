import { phonePlace, type PhonePlace } from '../game/ghost/phoneMap';
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
