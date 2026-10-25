import type { GhostPathModel } from './types';
import type { GhostWordSpec } from './words';

const EPS = 1e-6;

/** Contract check for a model, whether built here or loaded from offline JSON. Returns problems; empty = valid. */
export function validateGhostModel(model: GhostPathModel, spec: GhostWordSpec): string[] {
  const problems: string[] = [];
  const bad = (message: string) => problems.push(message);

  if (model.version !== 1) bad(`version must be 1, got ${String(model.version)}`);
  if (model.word !== spec.word) bad(`word "${model.word}" does not match spec "${spec.word}"`);
  if (!['synthetic', 'cartesia-avg', 'recorded'].includes(model.source)) bad(`unknown source "${String(model.source)}"`);
  if (!Number.isFinite(model.factor)) bad('factor must be finite');
  if (!(model.durationMs > 0)) bad('durationMs must be positive');
  if (!model.provenance) bad('provenance is empty');

  let last = -Infinity;
  if (!model.segments.length) bad('no voiced segments');
  model.segments.forEach((segment, s) => {
    if (segment.spread.length !== segment.points.length) bad(`segment ${s}: spread length ${segment.spread.length} != points length ${segment.points.length}`);
    if (segment.points.length < 2) bad(`segment ${s}: needs at least 2 points`);
    segment.points.forEach((p, i) => {
      if (!(p.t >= 0 && p.t <= 1)) bad(`segment ${s} point ${i}: t ${p.t} outside [0,1]`);
      if (p.t < last - EPS) bad(`segment ${s} point ${i}: t ${p.t} is not monotonic`);
      last = Math.max(last, p.t);
      if (!(p.f1 > 0 && p.f2 > 0 && Number.isFinite(p.f1) && Number.isFinite(p.f2))) bad(`segment ${s} point ${i}: f1/f2 must be positive`);
    });
    segment.spread.forEach((v, i) => {
      if (!(v > 0 && Number.isFinite(v))) bad(`segment ${s} spread ${i}: must be positive`);
    });
  });

  const zoneIds = new Set(spec.zones.map((z) => z.id));
  const consonants = spec.zones.filter((z) => z.kind !== 'vowel');
  for (const marker of model.markers) {
    const zone = spec.zones.find((z) => z.id === marker.zoneId);
    if (!zone) {
      bad(`marker zoneId "${marker.zoneId}" is not a zone of ${spec.word}`);
      continue;
    }
    if (zone.kind !== marker.kind) bad(`marker "${marker.zoneId}": kind ${marker.kind} != zone kind ${zone.kind}`);
    if (zone.phoneme !== marker.phoneme) bad(`marker "${marker.zoneId}": phoneme ${marker.phoneme} != ${zone.phoneme}`);
    if (marker.scored !== (marker.kind === 'stop')) bad(`marker "${marker.zoneId}": only stops are scored`);
    if (!(marker.t >= 0 && marker.t <= 1)) bad(`marker "${marker.zoneId}": t ${marker.t} outside [0,1]`);
  }
  for (const zone of consonants) {
    if (!model.markers.some((m) => m.zoneId === zone.id)) bad(`no marker for consonant zone "${zone.id}"`);
  }

  if (model.parts.length !== spec.parts.length) bad(`expected ${spec.parts.length} parts, got ${model.parts.length}`);
  let edge = 0;
  model.parts.forEach((part, i) => {
    const want = spec.parts[i];
    if (!want || part.id !== want.id) bad(`part ${i}: id "${part.id}" is out of order (expected "${want?.id}")`);
    if (want && part.zoneIds.join() !== want.zoneIds.join()) bad(`part "${part.id}": zoneIds differ from the word spec`);
    part.zoneIds.forEach((id) => {
      if (!zoneIds.has(id)) bad(`part "${part.id}": unknown zone "${id}"`);
    });
    if (Math.abs(part.t0 - edge) > EPS) bad(`part "${part.id}": starts at ${part.t0}, expected ${edge}`);
    if (!(part.t1 > part.t0)) bad(`part "${part.id}": t1 must be after t0`);
    edge = part.t1;
  });
  if (model.parts.length && Math.abs(edge - 1) > EPS) bad(`parts end at ${edge}, expected 1`);

  return problems;
}
