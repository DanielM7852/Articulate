import { EH_RADIUS_V1, REFERENCE_V1 } from '@vowel-mapper/reference/data';
import type { GhostMarker, GhostPart, GhostPathModel, GhostPoint, GhostSegment } from './types';
import { GHOST_WORDS, type GhostWordSpec } from './words';
import { validateGhostModel } from './validate';
import { pullToward } from '../../vowel/pull';
import recordedTiming from './models/recorded-timing.json';

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

function sampleStretch(
  keys: Key[],
  ms: number,
  targets: Record<string, Formants>,
): { f1: number; f2: number; spread: number } {
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
  const a = targets[from.target];
  const b = targets[to.target];
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
  /** Where the timing comes from; the F1/F2 path is the synthetic vowel trajectory either way. Default 'synthetic'. */
  source?: GhostPathModel['source'];
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

function buildSynthetic(
  spec: GhostWordSpec,
  line: WordTimeline,
  targets: Record<string, Formants> = TARGET_LN,
): GhostPathModel {
  const { durationMs } = line;
  const segments: GhostSegment[] = line.stretches.map((keys) => {
    const start = keys[0].from;
    const end = keys[keys.length - 1].to;
    const points: GhostPoint[] = [];
    const spread: number[] = [];
    for (let ms = start; ms <= end + 1e-6; ms += STEP_MS) {
      const s = sampleStretch(keys, ms, targets);
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
    source: line.source ?? 'synthetic',
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

/**
 * Words timed from human recordings (median of 10 speakers, CTC forced alignment): phone spans and peaks are
 * fractions of the word. Peaks are CTC spikes (stop peaks are about the burst); spans are spike midpoints, so
 * the part edges are approximate. The F1/F2 path stays the synthetic vowel trajectory, only retimed.
 * Used by track, sheep, rent and brain.
 */
function recordedPhones(word: string) {
  const rec = recordedTiming.words[word as keyof typeof recordedTiming.words];
  const D = rec.durationMs;
  const ph = (p: string) => {
    const hit = rec.phones.find((x) => x.p === p);
    if (!hit) throw new Error(`recorded-timing.json: ${word} has no phone ${p}`);
    return hit;
  };
  const ms = (f: number) => round(f * D, 1);
  return { D, ph, ms };
}

const recordedProvenance = () =>
  `Recorded timing (${recordedTiming.provenance}; model ${recordedTiming.model}) on the synthetic vowel path: ${PROVENANCE}`;

/**
 * The voiced r starts a little before its span (spike midpoints, ~60-100 ms): the "tr" unit needs a voiced stretch of
 * at least FOLLOW.minVoicedSpanMs (80 ms) to be followable at all, so start r early enough for 90 ms before the vowel.
 */
const rStart = (rStartMs: number, vowelStartMs: number) => Math.max(0, Math.min(rStartMs, vowelStartMs - 90));

function recordedTrack(): WordTimeline {
  const { D, ph, ms } = recordedPhones('track');
  const [t, r, a, k] = [ph('t'), ph('ɹ'), ph('æ'), ph('k')];
  // glideMs 40: r peaks only ~17 ms before the vowel starts, so the r -> ae blend is shorter than the 70 ms default.
  const rFrom = rStart(ms(r.t0), ms(a.t0));
  return {
    durationMs: D,
    stretches: [[{ target: 'r', from: rFrom, to: ms(r.t1), glideMs: 40 }, { target: 'ae', from: ms(a.t0), to: ms(a.t1) }]],
    markers: [{ zoneId: 't', ms: ms(t.peak) }, { zoneId: 'r', ms: ms(r.peak) }, { zoneId: 'k', ms: ms(k.peak) }],
    boundaries: [ms(a.t0), ms(k.t0)],
    provenance: recordedProvenance(),
    source: 'recorded',
  };
}

function recordedSheep(): WordTimeline {
  const { D, ph, ms } = recordedPhones('sheep');
  const [sh, ee, p] = [ph('ʃ'), ph('i'), ph('p')];
  return {
    durationMs: D,
    stretches: [[{ target: 'iy', from: ms(ee.t0), to: ms(ee.t1) }]],
    markers: [{ zoneId: 'sh', ms: ms(sh.peak) }, { zoneId: 'p', ms: ms(p.peak) }],
    boundaries: [ms(ee.t0), ms(p.t0)],
    provenance: recordedProvenance(),
    source: 'recorded',
  };
}

function recordedRent(): WordTimeline {
  const { D, ph, ms } = recordedPhones('rent');
  const [r, e, n, t] = [ph('ɹ'), ph('ɛ'), ph('n'), ph('t')];
  const rFrom = rStart(ms(r.t0), ms(e.t0));
  return {
    durationMs: D,
    stretches: [[{ target: 'r', from: rFrom, to: ms(r.t1), glideMs: 40 }, { target: 'eh', from: ms(e.t0), to: ms(e.t1) }]],
    markers: [{ zoneId: 'r', ms: ms(r.peak) }, { zoneId: 'n', ms: ms(n.peak) }, { zoneId: 't', ms: ms(t.peak) }],
    boundaries: [ms(e.t0), ms(n.t0)],
    provenance: recordedProvenance(),
    source: 'recorded',
  };
}

function recordedBrain(): WordTimeline {
  const { D, ph, ms } = recordedPhones('brain');
  const [b, r, ey, n] = [ph('b'), ph('ɹ'), ph('eɪ'), ph('n')];
  const rFrom = rStart(ms(r.t0), ms(ey.t0));
  // ey is a glide: eh -> iy, the eɪ span split at its midpoint. Each half is ~78 ms (>= 70). The eh -> iy blend must sit
  // inside the two keys and clear of the r -> eh blend (40 ms, so 20 ms into eh): at most 2 * (eh length - 20).
  const eyFrom = ms(ey.t0);
  const eyTo = ms(ey.t1);
  const mid = round((eyFrom + eyTo) / 2, 1);
  const glideMs = Math.min(140, Math.round(eyTo - eyFrom), Math.floor(2 * (mid - eyFrom - 20)));
  return {
    durationMs: D,
    stretches: [
      [
        { target: 'r', from: rFrom, to: ms(r.t1), glideMs: 40 },
        { target: 'eh', from: eyFrom, to: mid, glideMs },
        { target: 'iy', from: mid, to: eyTo },
      ],
    ],
    markers: [{ zoneId: 'b', ms: ms(b.peak) }, { zoneId: 'r', ms: ms(r.peak) }, { zoneId: 'n', ms: ms(n.peak) }],
    boundaries: [eyFrom, ms(n.t0)],
    provenance: recordedProvenance(),
    source: 'recorded',
  };
}

// All four words are timed from recordings (see recordedPhones); the F1/F2 path is still the synthetic vowel trajectory.
const TIMELINES: Record<string, WordTimeline> = {
  // t burst, aspiration, r -> ae, k closure and burst.
  track: recordedTrack(),
  // sh hiss (unvoiced, no path), long ee, p burst.
  sheep: recordedSheep(),
  // r -> eh, then the nasal breaks the voiced path, t burst.
  rent: recordedRent(),
  // b burst, r -> eh -> iy glide (ey), nasal tail.
  brain: recordedBrain(),
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

/** Which model targets take which stored learner vowel (the warm-up's eee, head and had). */
const PULL_ANCHOR = { iy: 'i', eh: 'eh', ae: 'ae' } as const;

/** Factor-0 reference (Hz) and pull radius (ln units) for one anchored target, for readouts. */
export function ghostPullReference(id: 'i' | 'eh' | 'ae'): { ref: Formants; r: number } {
  const k = id === 'i' ? 'iy' : id;
  return { ref: { f1: Math.exp(TARGET_LN[k].f1), f2: Math.exp(TARGET_LN[k].f2) }, r: SPREAD[k] };
}

export interface GhostPersonal {
  factor: number;
  anchors?: Partial<Record<'i' | 'eh' | 'ae', Formants>>;
}

/**
 * The model for a word. With `personal.anchors`, the synthetic iy/eh/ae targets move toward the learner's
 * held vowels by at most one radius (pullToward) from the factor-sized reference, so the board's
 * sizeModel(model, factor) lands them on the pulled point. Recorded replacements ignore `personal`.
 */
export function ghostModel(word: string, personal?: GhostPersonal): GhostPathModel {
  const model = registry.get(word);
  if (!model) throw new Error(`No ghost model for "${word}"`);
  const anchors = personal?.anchors;
  if (!personal || !anchors || model !== SYNTHETIC[word]) return model;
  const targets: Record<string, Formants> = { ...TARGET_LN };
  let pulledAny = false;
  for (const [k, id] of Object.entries(PULL_ANCHOR)) {
    const anchor = anchors[id];
    if (!anchor) continue;
    const scale = Math.exp(personal.factor);
    const sized = { f1: Math.exp(TARGET_LN[k].f1) * scale, f2: Math.exp(TARGET_LN[k].f2) * scale };
    const pulled = pullToward(sized, anchor, SPREAD[k]);
    targets[k] = {
      f1: TARGET_LN[k].f1 + Math.log(pulled.f1 / sized.f1),
      f2: TARGET_LN[k].f2 + Math.log(pulled.f2 / sized.f2),
    };
    pulledAny = true;
  }
  if (!pulledAny) return model;
  const built = buildSynthetic(GHOST_WORDS[word], TIMELINES[word], targets);
  return { ...built, provenance: `${built.provenance}; personal pull ≤1 radius toward the learner's held iy/eh/ae` };
}

export const GHOST_WORD_LIST = Object.keys(GHOST_WORDS);
