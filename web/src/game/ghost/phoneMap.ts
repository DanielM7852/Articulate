import { AXES } from '../../vowel/targets';
import { ZONE_PHONES } from '../../live/phoneJudge';
import { ghostModel } from './models';
import { GHOST_WORDS } from './words';
import { validateGhostModel } from './validate';
import type { GhostPathModel, GhostPoint } from './types';
import phoneMapData from './phone-map.json';

/**
 * The phone map: every phone the recognizer knows has a FIXED place on the tongue board, the same for every learner
 * (learners may pronounce vowels differently, so no personal vowel pull and no voice-size scaling here).
 * Axes keep the board's meaning: x = tongue forward (0) to back (1), y = jaw closed (0, top) to open (1, bottom).
 *
 * phone-map.json is shared with a Python calibration script, so its shape is fixed. Layout (principled, not measured):
 *  - consonants: x by place of articulation (bilabial .05, labiodental .12, dental .2, alveolar .3, postalveolar .42,
 *    palatal .55, velar .8, glottal .97); y by closure (stops/nasals/flap .03-.09, affricates .1, fricatives .14, approximants .26);
 *  - vowels on the IPA chart, x .15-.9, y .42-.98 (close .42-.5, mid .6-.78, open .9-.98);
 *  - diphthongs sit at their START vowel, nudged ~0.035 toward the glide so the labels do not collide.
 */
export interface PhonePlace {
  x: number;
  y: number;
}

const PLACES = phoneMapData.phones as Record<string, PhonePlace>;

/** Combining marks removed before lookup: tilde (nasalised), syllabic below/above, voiceless ring. */
const STRIP = /[̩̥̃̍]/g;

/**
 * Fold a recognizer symbol onto a map key: decompose, drop the nasal/syllabic/voiceless marks, drop aspiration (Xʰ -> X),
 * r -> ɹ and ASCII g -> ɡ. Symbols that are still unknown after folding have no place (phonePlace returns null).
 */
export function foldPhone(sym: string): string {
  let q = sym.normalize('NFD').replace(STRIP, '').replace(/ʰ/g, '').normalize('NFC');
  if (q === 'r') q = 'ɹ';
  if (q === 'g') q = 'ɡ';
  return q;
}

/** The fixed place of a phone (folded first), or null when the map does not know it. */
export function phonePlace(sym: string): PhonePlace | null {
  const q = foldPhone(sym);
  return Object.prototype.hasOwnProperty.call(PLACES, q) ? PLACES[q] : null;
}

/** All map symbols (for the debug overlay and tests). */
export function mapSymbols(): string[] {
  return Object.keys(PLACES);
}

/** The map occupies this inner fraction of the plot so edge labels are not clipped. */
export const MAP_MARGIN = 0.05;

/**
 * Map (x, y) in [0,1] to board F1/F2 (Hz). The board projects LINEARLY in Hz (vowel/targets.ts project): screen x grows
 * as F2 falls, screen y grows with F1. So map x -> F2 from high (front, left) to low (back, right), map y -> F1 from low
 * (top) to high (bottom), both linear, which places phones at even screen fractions.
 */
export function mapToFormants(x: number, y: number): { f1: number; f2: number } {
  const u = MAP_MARGIN + Math.min(1, Math.max(0, x)) * (1 - 2 * MAP_MARGIN);
  const v = MAP_MARGIN + Math.min(1, Math.max(0, y)) * (1 - 2 * MAP_MARGIN);
  return { f2: AXES.f2Max - u * (AXES.f2Max - AXES.f2Min), f1: AXES.f1Min + v * (AXES.f1Max - AXES.f1Min) };
}

/** Inverse of mapToFormants (unclamped). */
export function formantsToMap(f1: number, f2: number): PhonePlace {
  const u = (AXES.f2Max - f2) / (AXES.f2Max - AXES.f2Min);
  const v = (f1 - AXES.f1Min) / (AXES.f1Max - AXES.f1Min);
  return { x: (u - MAP_MARGIN) / (1 - 2 * MAP_MARGIN), y: (v - MAP_MARGIN) / (1 - 2 * MAP_MARGIN) };
}

/** Constant band half-width of the display path, ln units (the band reads as roughly the off-target distance). */
export const PHONE_MAP_SPREAD = 0.12;
/** Beyond this map distance from the unit's path the cursor counts as off target. */
export const OFF_PATH_MAP_DIST = 0.12;

const STEP_MS = 10;
const smoothstep = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

const cache = new Map<string, GhostPathModel>();

/**
 * The DISPLAY model for a phone-judged word: the recorded model's timing (durationMs, markers, parts) with the path
 * rebuilt through the map places of the word's phones. Each phone sits at its marker time, or its part's midpoint when it
 * has no marker (vowels). Between phones the path eases (smoothstep) in map space; before the first and after the last it
 * holds. No sizeModel, voice factor or anchors: it is the same for everyone. Throws for words without a phone map.
 */
export function phoneMapModel(word: string): GhostPathModel {
  const hit = cache.get(word);
  if (hit) return hit;
  const spec = GHOST_WORDS[word];
  const zonePhones = ZONE_PHONES[word];
  if (!spec || !zonePhones) throw new Error(`No phone map model for "${word}"`);
  const base = ghostModel(word);
  const keys: { t: number; x: number; y: number }[] = [];
  for (const zone of spec.zones) {
    const sym = zonePhones[zone.id];
    if (!sym) continue;
    const place = phonePlace(sym);
    if (!place) throw new Error(`Phone "${sym}" of "${word}" is not on the map`);
    const marker = base.markers.find((m) => m.zoneId === zone.id);
    const part = base.parts.find((p) => p.zoneIds.includes(zone.id));
    const t = marker ? marker.t : part ? (part.t0 + part.t1) / 2 : 0;
    keys.push({ t, x: place.x, y: place.y });
  }
  if (keys.length === 0) throw new Error(`"${word}" has no mapped phones`);
  keys.sort((a, b) => a.t - b.t);
  for (let i = 1; i < keys.length; i++) if (keys[i].t <= keys[i - 1].t) keys[i].t = keys[i - 1].t + 1e-4;

  const at = (t: number): PhonePlace => {
    if (t <= keys[0].t) return keys[0];
    const last = keys[keys.length - 1];
    if (t >= last.t) return last;
    let i = 0;
    while (keys[i + 1].t < t) i++;
    const a = keys[i];
    const b = keys[i + 1];
    const w = smoothstep((t - a.t) / (b.t - a.t));
    return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
  };
  const times = new Set<number>([0, 1, ...keys.map((k) => k.t)]);
  for (let ms = STEP_MS; ms < base.durationMs; ms += STEP_MS) times.add(ms / base.durationMs);
  const sorted = [...times].filter((t) => t >= 0 && t <= 1).sort((a, b) => a - b);
  const points: GhostPoint[] = sorted.map((t) => {
    const p = at(t);
    const f = mapToFormants(p.x, p.y);
    return { t: Math.round(t * 1e5) / 1e5, f1: Math.round(f.f1 * 100) / 100, f2: Math.round(f.f2 * 100) / 100 };
  });
  const model: GhostPathModel = {
    version: 1,
    word,
    source: 'recorded',
    factor: 0,
    durationMs: base.durationMs,
    segments: [{ points, spread: points.map(() => PHONE_MAP_SPREAD) }],
    markers: base.markers,
    parts: base.parts,
    provenance: `Phone map display path through the fixed places of ${Object.values(zonePhones).join(' ')} (phone-map.json), at the recorded timing of the ${word} model.`,
  };
  const problems = validateGhostModel(model, spec);
  if (problems.length) throw new Error(`phoneMapModel(${word}) invalid: ${problems.join('; ')}`);
  cache.set(word, model);
  return model;
}

/** Distance from `p` to the nearest point of any of the polylines (map units). Infinity when there are none. */
export function distanceToPolylines(p: PhonePlace, lines: readonly (readonly PhonePlace[])[]): number {
  let best = Infinity;
  for (const line of lines) {
    if (line.length === 1) best = Math.min(best, Math.hypot(p.x - line[0].x, p.y - line[0].y));
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = line[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const w = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(p.x - (a.x + w * dx), p.y - (a.y + w * dy)));
    }
  }
  return best;
}
