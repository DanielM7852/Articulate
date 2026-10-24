import type { GhostUnit } from './types';
import type { GhostWordSpec } from './words';

/** One unit per part: practise onset, nucleus or coda on its own. */
export function partUnits(spec: GhostWordSpec): GhostUnit[] {
  return spec.parts.map((part) => ({ id: part.id, label: part.label, zoneIds: [...part.zoneIds], partIds: [part.id] }));
}

/**
 * Chain backwards zone by zone: [last], [last two], ... [all]. Labels are the zone labels joined in
 * word order, so "track" gives ck, ack, rack, track. partIds are the parts those zones touch.
 */
export function chainUnits(spec: GhostWordSpec): GhostUnit[] {
  const units: GhostUnit[] = [];
  for (let from = spec.zones.length - 1; from >= 0; from--) {
    const zones = spec.zones.slice(from);
    const ids = new Set(zones.map((zone) => zone.id));
    units.push({
      id: `chain-${zones.map((zone) => zone.id).join('-')}`,
      label: zones.map((zone) => zone.label).join(''),
      zoneIds: zones.map((zone) => zone.id),
      partIds: spec.parts.filter((part) => part.zoneIds.some((id) => ids.has(id))).map((part) => part.id),
    });
  }
  return units;
}

/** True when the unit has a zone the voice can be checked against (vowel, liquid or stop). Cue-only units are watch-only. */
export function unitIsPractisable(spec: GhostWordSpec, unit: GhostUnit): boolean {
  return spec.zones.some((zone) => unit.zoneIds.includes(zone.id) && (zone.kind === 'vowel' || zone.kind === 'liquid' || zone.kind === 'stop'));
}
