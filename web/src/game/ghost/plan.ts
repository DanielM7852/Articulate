import type { GhostUnit } from './types';
import type { GhostWordSpec } from './words';
import { chainUnits, partUnits, unitIsPractisable } from './units';

/**
 * The ghost-path lesson for one word: each part on its own, then the whole word twice (slowly, then at natural speed). Pure: the screen walks it.
 */
export interface LessonStep {
  kind: 'part' | 'chain' | 'word';
  unit: GhostUnit;
  /** Playback speed of the ghost while the learner watches (1 = natural). */
  speedWatch: number;
  /** Speed the learner is expected to speak at (the board's live attempt follows the learner, not this). */
  speedLive: number;
  /** False for cue-only units (no vowel, liquid or stop): the learner watches and feels, never goes live. */
  practisable: boolean;
}

export const WORD_SLOW_SPEED = 0.6;
const PART_SPEED = 0.8;


export function lessonPlan(spec: GhostWordSpec): LessonStep[] {
  const parts = partUnits(spec);
  const steps: LessonStep[] = parts.map((unit) => ({
    kind: 'part',
    unit,
    speedWatch: PART_SPEED,
    speedLive: 1,
    practisable: unitIsPractisable(spec, unit),
  }));
  const chains = chainUnits(spec);
  const whole = chains[chains.length - 1];
  const practisable = unitIsPractisable(spec, whole);
  steps.push({ kind: 'word', unit: whole, speedWatch: WORD_SLOW_SPEED, speedLive: WORD_SLOW_SPEED, practisable });
  steps.push({ kind: 'word', unit: whole, speedWatch: 1, speedLive: 1, practisable });
  return steps;
}

/** Close attempts in a row that move the learner on. */
export const NAIL_STREAK = 2;
/** Attempts per step before moving on anyway. */
export const MAX_TRIES = 4;

export interface ProgressState {
  /** Index into the plan. */
  step: number;
  /** Attempts made on this step. */
  tries: number;
  /** Close attempts in a row on this step. */
  streak: number;
}

export const startProgress = (): ProgressState => ({ step: 0, tries: 0, streak: 0 });

export interface ProgressResult {
  state: ProgressState;
  advance: boolean;
  /** Advancing only because MAX_TRIES ran out: say it gently, never as a pass. */
  gentle: boolean;
}

/** Record one live attempt on the current step and decide whether to move on. */
export function nextStep(state: ProgressState, closeNow: boolean): ProgressResult {
  const tries = state.tries + 1;
  const streak = closeNow ? state.streak + 1 : 0;
  if (streak >= NAIL_STREAK) return { state: { step: state.step + 1, tries: 0, streak: 0 }, advance: true, gentle: false };
  if (tries >= MAX_TRIES) return { state: { step: state.step + 1, tries: 0, streak: 0 }, advance: true, gentle: true };
  return { state: { step: state.step, tries, streak }, advance: false, gentle: false };
}

/** Leave the current step without an attempt (watch-only steps after the hint, or "Next part"). */
export const skipStep = (state: ProgressState): ProgressState => ({ step: state.step + 1, tries: 0, streak: 0 });

/** Status text: parts are counted, chain steps and the whole word have their own labels. */
export function stepLabel(plan: LessonStep[], index: number): string {
  const step = plan[index];
  if (!step) return '';
  if (step.kind === 'part') {
    const total = plan.filter((s) => s.kind === 'part').length;
    return `Part ${index + 1} of ${total} · ${step.unit.label}`;
  }
  if (step.kind === 'chain') return `Putting it together · ${step.unit.label}`;
  return 'Whole word';
}
