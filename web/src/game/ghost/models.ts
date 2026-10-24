import { EH_RADIUS_V1, REFERENCE_V1 } from '@vowel-mapper/reference/data';
import type { GhostMarker, GhostPart, GhostPathModel, GhostPoint, GhostSegment } from './types';
import { GHOST_WORDS, type GhostWordSpec } from './words';
import { validateGhostModel } from './validate';

/**
 * Model pronunciations ("ghost paths"). Every word ships a 'synthetic' model built from reference
 * vowel targets at Karsten's reference size (factor 0). A model produced offline (source
 * 'cartesia-avg' or 'recorded', same JSON shape) replaces a synthetic one by adding one import
 * line and one entry to REPLACEMENTS below. Invalid replacements are ignored, not trusted.
 */

type Formants = { f1: number; f2: number };

// ---------------------------------------------------------------------------------------------
// Targets (natural-log Hz at factor 0)
// ---------------------------------------------------------------------------------------------

const ref = (vowel: keyof typeof REFERENCE_V1.means): Formants => {
  const [f1, f2] = REFERENCE_V1.means[vowel];
  return { f1, f2 };
};

/**
 * Hillenbrand et al. (1995) /i/, geometric mean of the men's (342, 2322) and women's (437, 2761)
 * averages. Hillenbrand has no English r, so r is placed in his adult-ish scale (F1 about 400,
 * F2 about 1200 Hz, low F2 for r) and moved onto REFERENCE_V1's scale by the shift that maps his /i/
 * onto REFERENCE_V1's iy, so every point shares one scale.
 */
const HILLENBRAND_IY = { f1: Math.sqrt(342 * 437), f2: Math.sqrt(2322 * 2761) };
const HILLENBRAND_R = { f1: 400, f2: 1200 };
const SCALE_SHIFT = {
  f1: REFERENCE_V1.means.iy[0] - Math.log(HILLENBRAND_IY.f1),
  f2: REFERENCE_V1.means.iy[1] - Math.log(HILLENBRAND_IY.f2),
};

const TARGET_LN: Record<string, Formants> = {
  iy: ref('iy'),
  eh: ref('eh'),
  ae: ref('ae'),
  r: { f1: Math.log(HILLENBRAND_R.f1) + SCALE_SHIFT.f1, f2: Math.log(HILLENBRAND_R.f2) + SCALE_SHIFT.f2 },
};

/** Close-zone radius per target, ln units: the mean of the reference radii on the two axes. */
const mean2 = (r: readonly [number, number]) => (r[0] + r[1]) / 2;
const SPREAD: Record<string, number> = {
  iy: mean2(REFERENCE_V1.radius.iy),
  eh: mean2(EH_RADIUS_V1),
  ae: mean2(EH_RADIUS_V1),
  // r has no measured radius; it borrows the eh radius, widened because it is advisory and moves fast.
  r: mean2(EH_RADIUS_V1) * 1.15,
};

// ---------------------------------------------------------------------------------------------
// Timeline builder
// ---------------------------------------------------------------------------------------------

const STEP_MS = 10;
/** Default blend between neighbouring targets (smooth in log Hz). */
const TRANSITION_MS = 70;
/** Extra spread in the middle of a transition: the path is less certain between targets. */
const TRANSITION_SLACK = 0.35;

/** One target held over [from, to] ms. `glideMs` overrides the blend into the next key. */
interface Key {
  target: keyof typeof TARGET_LN;
  from: number;
  to: number;
  glideMs?: number;
}

const smoothstep = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

function sampleStretch(keys: Key[], ms: number): { f1: number; f2: number; spread: number } {
  let i = keys.findIndex((key) => ms <= key.to);
  if (i < 0) i = keys.length - 1;
  const here = keys[i];
  const prev = keys[i - 1];
  const next = keys[i + 1];
  let from = here;
  let to = here;
  let w = 0;
  // Each boundary blends over glideMs centred on it, with the same weight seen from either side.
  if (prev && ms < here.from + (prev.glideMs ?? TRANSITION_MS) / 2) {
    const half = (prev.glideMs ?? TRANSITION_MS) / 2;
    from = prev;
    to = here;
    w = smoothstep((ms - (here.from - half)) / (2 * half));
  } else if (next && ms > here.to - (here.glideMs ?? TRANSITION_MS) / 2) {
    const half = (here.glideMs ?? TRANSITION_MS) / 2;
    from = here;
    to = next;
    w = smoothstep((ms - (here.to - half)) / (2 * half));
  }
  const mix = (a: number, b: number) => a * (1 - w) + b * w;
  const a = TARGET_LN[from.target];
  const b = TARGET_LN[to.target];
  const slack = 4 * w * (1 - w);
  return {
    f1: mix(a.f1, b.f1),
    f2: mix(a.f2, b.f2),
    spread: mix(SPREAD[from.target], SPREAD[to.target]) * (1 + TRANSITION_SLACK * slack),
  };
}

interface WordTimeline {
  durationMs: number;
  /** Voiced stretches; each must be made of keys of at least 70 ms. */
  stretches: Key[][];
  /** Consonant markers: spec zone id, time in ms. */
  markers: { zoneId: string; ms: number }[];
  /** Part boundaries in ms, one fewer than parts. */
  boundaries: number[];
  provenance: string;
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

function buildSynthetic(spec: GhostWordSpec, line: WordTimeline): GhostPathModel {
  const { durationMs } = line;
  const segments: GhostSegment[] = line.stretches.map((keys) => {
    const start = keys[0].from;
    const end = keys[keys.length - 1].to;
    const points: GhostPoint[] = [];
    const spread: number[] = [];
    for (let ms = start; ms <= end + 1e-6; ms += STEP_MS) {
      const s = sampleStretch(keys, ms);
      points.push({ t: round(ms / durationMs, 5), f1: round(Math.exp(s.f1), 1), f2: round(Math.exp(s.f2), 1) });
      spread.push(round(s.spread, 5));
    }
    return { points, spread };
  });
  const markers: GhostMarker[] = line.markers.map(({ zoneId, ms }) => {
    const zone = spec.zones.find((z) => z.id === zoneId)!;
    const kind = zone.kind as GhostMarker['kind'];
    return { kind, zoneId, phoneme: zone.phoneme, t: round(ms / durationMs, 5), scored: kind === 'stop' };
  });
  const edges = [0, ...line.boundaries.map((ms) => ms / durationMs), 1];
  const parts: GhostPart[] = spec.parts.map((part, i) => ({
    id: part.id,
    label: part.label,
    zoneIds: [...part.zoneIds],
    t0: round(edges[i], 5),
    t1: round(edges[i + 1], 5),
  }));
  return {
    version: 1,
    word: spec.word,
    source: 'synthetic',
    factor: 0,
    durationMs,
    segments,
    markers,
    parts,
    provenance: line.provenance,
  };
}

const PROVENANCE =
  'Synthetic: REFERENCE_V1 means (iy, eh, ae) at factor 0; r from Hillenbrand (1995) men+women geometric mean, ' +
  'rescaled so Hillenbrand iy lands on REFERENCE_V1 iy; spread from REFERENCE_V1 / EH_RADIUS_V1; ' +
  '70 ms smooth log-Hz blends; timings are typical natural durations, not measured.';

const TIMELINES: Record<string, WordTimeline> = {
  // t burst, aspiration, r -> ae, k closure and burst.
  track: {
    durationMs: 550,
    stretches: [[{ target: 'r', from: 110, to: 190 }, { target: 'ae', from: 190, to: 450 }]],
    markers: [{ zoneId: 't', ms: 60 }, { zoneId: 'r', ms: 150 }, { zoneId: 'k', ms: 510 }],
    boundaries: [190, 450],
    provenance: PROVENANCE,
  },
  // sh hiss (unvoiced, no path), long ee, p burst.
  sheep: {
    durationMs: 480,
    stretches: [[{ target: 'iy', from: 175, to: 360 }]],
    markers: [{ zoneId: 'sh', ms: 85 }, { zoneId: 'p', ms: 430 }],
    boundaries: [175, 360],
    provenance: PROVENANCE,
  },
  // r -> eh, then the nasal breaks the voiced path, t burst.
  rent: {
    durationMs: 540,
    stretches: [[{ target: 'r', from: 20, to: 110 }, { target: 'eh', from: 110, to: 300 }]],
    markers: [{ zoneId: 'r', ms: 65 }, { zoneId: 'n', ms: 340 }, { zoneId: 't', ms: 450 }],
    boundaries: [110, 300],
    provenance: PROVENANCE,
  },
  // b burst, r -> eh -> iy glide (ey), nasal tail.
  brain: {
    durationMs: 600,
    stretches: [
      [
        { target: 'r', from: 60, to: 150 },
        { target: 'eh', from: 150, to: 290, glideMs: 140 },
        { target: 'iy', from: 290, to: 430 },
      ],
    ],
    markers: [{ zoneId: 'b', ms: 50 }, { zoneId: 'r', ms: 105 }, { zoneId: 'n', ms: 485 }],
    boundaries: [150, 430],
    provenance: PROVENANCE,
  },
};

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

/**
 * Offline models that replace a synthetic one. To ship one: add a `models/<word>.<source>.ts` that
 * default-exports the JSON as a GhostPathModel, import it here and add it to this list.
 */
const REPLACEMENTS: GhostPathModel[] = [];

const SYNTHETIC: Record<string, GhostPathModel> = Object.fromEntries(
  Object.entries(TIMELINES).map(([word, line]) => [word, buildSynthetic(GHOST_WORDS[word], line)]),
);

const registry = new Map<string, GhostPathModel>(Object.entries(SYNTHETIC));

/** Replace (or add) a model. Returns false, leaving the registry alone, when it breaks the contract. */
export function registerGhostModel(model: GhostPathModel): boolean {
  const spec = GHOST_WORDS[model.word];
  if (!spec || validateGhostModel(model, spec).length) return false;
  registry.set(model.word, model);
  return true;
}

for (const model of REPLACEMENTS) registerGhostModel(model);

export function ghostModel(word: string): GhostPathModel {
  const model = registry.get(word);
  if (!model) throw new Error(`No ghost model for "${word}"`);
  return model;
}

export const GHOST_WORD_LIST = Object.keys(GHOST_WORDS);
