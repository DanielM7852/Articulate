import { useSyncExternalStore } from 'react';
import type { MouthDemo, QualityChange, QualityLevel } from '@mouth-demo/src/mouth-demo.js';
import { readStoredQuality, storeQuality, type QualityTier, type TierDecision } from '@mouth-demo/src/quality.js';
import { emitWhenReady } from '../telemetry/client';

/**
 * The guide's display quality for the session (see mouth-demo/src/quality.js).
 *
 * `setting` is the learner's choice: 'auto' (nothing stored, the hardware decides and the frame-rate
 * monitor may step it) or a pinned tier stored in localStorage 'articulate.quality'. `tier` is what the
 * guide is drawing now. Every decision (the first one and each change) is reported as `ui.quality`.
 */
export type QualitySetting = 'auto' | QualityTier;

export interface QualityState {
  setting: QualitySetting;
  /** Drawn now; null until the guide has started. */
  tier: QualityTier | null;
  level: QualityLevel | null;
  reason: string | null;
  /** True while a screen shows the guide (the toggle is only offered then). */
  guideShown: boolean;
}

let state: QualityState = {
  setting: readStoredQuality() ?? 'auto',
  tier: null,
  level: null,
  reason: null,
  guideShown: false,
};
let decision: TierDecision | null = null;
/** The setting the startup decision was made with (a change while the guide loads is applied once it is up). */
let decidedSetting: QualitySetting | null = null;
let demo: MouthDemo | null = null;
const listeners = new Set<() => void>();

const update = (patch: Partial<QualityState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export const getQualityState = () => state;

/** The current quality state, re-rendering on change. */
export function useQuality(): QualityState {
  return useSyncExternalStore(subscribe, getQualityState, getQualityState);
}

/** Called by guide.ts: the startup decision, before the demo is created. */
export function noteDecision(d: TierDecision) {
  decision = d;
  decidedSetting = state.setting;
}

/** Called by guide.ts once the demo exists. */
export function attachDemo(d: MouthDemo) {
  demo = d;
  if (decidedSetting !== null && state.setting !== decidedSetting) setQualitySetting(state.setting);
}

export function setGuideShown(shown: boolean) {
  if (state.guideShown !== shown) update({ guideShown: shown });
}

/** The guide's quality:change (the first decision, then every change): record it and report it. */
export function reportChange(change: QualityChange) {
  update({ tier: change.tier, level: change.level, reason: change.reason });
  const renderer = (decision?.renderer ?? '').slice(0, 60);
  emitWhenReady('ui', 'db', 'ui.quality', `quality ${change.tier}`, {
    tier: change.tier,
    level: change.level,
    reason: change.reason,
    gpuTier: decision?.gpuTier ?? null,
    fps: change.fps,
    renderer,
    isMobile: decision?.isMobile ?? false,
  });
}

/**
 * The learner's choice: a tier to pin, or 'auto' to hand it back to the hardware's own tier with the
 * frame-rate monitor on. Stored and applied live.
 */
export function setQualitySetting(setting: QualitySetting) {
  storeQuality(setting === 'auto' ? null : setting);
  update({ setting });
  if (!demo) return;
  if (setting === 'auto') void demo.setQuality(decision?.detected ?? 'full', { adaptive: true, reason: 'auto' });
  else void demo.setQuality(setting, { adaptive: false, reason: 'user' });
}
