import type { Assistance, Attempt, Plan, Preferences, SoundId } from '../state/types';
import { SOUNDS } from '../state/types';

/**
 * Coaching contract. The real implementation is the Claude-backed assessment,
 * visual-coach and curriculum agents behind the measurement service. Until that
 * endpoint exists, `analyzeAttempt` produces a grounded local response from the
 * attempt's own measured fields only, so it never claims more than was measured.
 *
 * The practice app posts to /v1/coach, which the dev server proxies to the backend.
 * Set VITE_COACH_URL to override that path. A failed request keeps the local wording.
 */
export interface CoachResponse {
  attemptId: string;
  source: 'agent' | 'local';
  observation: string;
  nextCue: string;
  nextAction: 'repeat' | 'simplify' | 'change-cue' | 'reduce-assistance' | 'next-context' | 'repair-capture';
  evidence: string[];
  /** Next lesson for this learner. Absent when the response is the offline wording. */
  plan?: Plan;
}

const COACH_URL = (import.meta.env.VITE_COACH_URL as string | undefined) || '/v1/coach';

export async function analyzeAttempt(
  attempt: Attempt,
  history: Attempt[],
  context?: { learnerId?: string | null; plan?: Plan; preferences?: Preferences },
): Promise<CoachResponse> {
  try {
    const res = await fetch(COACH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attempt,
        history,
        learnerId: context?.learnerId || undefined,
        plan: context?.plan,
        preferences: context?.preferences,
      }),
    });
    if (res.ok) {
      const body = (await res.json()) as CoachResponse;
      const plan = readPlan(body.plan);
      return { ...body, plan, source: body.source === 'local' ? 'local' : 'agent' };
    }
  } catch {
    /* fall through to local response */
  }
  return localResponse(attempt, history);
}

export async function proposeLessonPlan(preferences: Preferences, sound: SoundId): Promise<Plan> {
  try {
    const res = await fetch('/v1/lesson-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences, sound }),
    });
    if (res.ok) {
      const body = (await res.json()) as { plan?: Plan };
      const plan = readPlan(body.plan);
      if (plan) return plan;
    }
  } catch {
    /* the quiz still produces a plan without the model */
  }
  return localLessonPlan(preferences, sound);
}

function localLessonPlan(preferences: Preferences, sound: SoundId): Plan {
  const pace = preferences.pace ?? 'unhurried';
  let score = 1;
  if (preferences.guidance === 'explore') score += 1;
  else score -= 1;
  if (preferences.support === 'self') score += 1;
  else if (preferences.support === 'mouth') score -= 1;
  if (preferences.routine === 'exploring') score -= 1;
  else if (preferences.routine === 'regular') score += 1;
  if (pace === 'unhurried') score -= 1;
  else if (pace === 'flexible') score += 1;
  if (preferences.goals.includes('visual')) score -= 1;
  if (preferences.goals.includes('longer')) score -= 1;
  if (preferences.goals.includes('conversations')) score += 1;
  if (score <= 0) return { sound, pace: 'unhurried', assistance: 'cue-target' };
  if (score === 1) return { sound, pace: pace === 'flexible' ? 'steady' : pace, assistance: 'cue-target' };
  return { sound, pace, assistance: 'target-only' };
}

function readPlan(value: Plan | undefined): Plan | undefined {
  if (!value) return undefined;
  const sounds: SoundId[] = ['i', 'u', 'a'];
  const paces: Plan['pace'][] = ['unhurried', 'steady', 'flexible'];
  const assistance: Plan['assistance'][] = ['cue-target', 'target-only', 'none'];
  if (!sounds.includes(value.sound) || !paces.includes(value.pace) || !assistance.includes(value.assistance)) return undefined;
  return { sound: value.sound, pace: value.pace, assistance: value.assistance };
}

function localResponse(a: Attempt, history: Attempt[]): CoachResponse {
  const s = SOUNDS[a.sound];
  if (a.quality === 'unclear') {
    const reason =
      a.qualityReason === 'clipping'
        ? 'The input was too loud and clipped. Try moving a little further from the microphone.'
        : a.qualityReason === 'too-short'
          ? 'There was not quite enough voiced sound to describe. Try holding the sound a little longer.'
          : 'I couldn’t measure that clearly. Try moving closer to the microphone.';
    return {
      attemptId: a.attemptId,
      source: 'local',
      observation: `${reason} Nothing was scored.`,
      nextCue: 'Retry when you are ready, or change your device.',
      nextAction: 'repair-capture',
      evidence: [`quality=${a.qualityReason ?? 'unclear'}`],
    };
  }

  const prev = [...history].reverse().find((h) => h.sound === a.sound && h.quality === 'usable' && h.attemptId !== a.attemptId);
  const evidence = [`usable_voiced=${a.usableVoicedSec}s`];
  let observation = `${a.usableVoicedSec.toFixed(1)} seconds of usable voice were captured for “${s.spelled}”.`;
  if (a.timeInTargetSec != null) {
    observation += ` The trace spent ${a.timeInTargetSec.toFixed(1)} s in the target region`;
    observation += a.longestHoldSec != null ? `, with a longest stable hold of ${a.longestHoldSec.toFixed(1)} s.` : '.';
    evidence.push(`time_in_target=${a.timeInTargetSec}s`);
  }
  if (prev) {
    const delta = a.usableVoicedSec - prev.usableVoicedSec;
    if (Math.abs(delta) >= 0.3) {
      observation += ` That is ${Math.abs(delta).toFixed(1)} s ${delta > 0 ? 'more' : 'less'} usable sound than your last try.`;
      evidence.push(`delta_vs_previous=${delta.toFixed(1)}s`);
    }
  }
  observation += ' This describes the sound you made, not your tongue position or overall pronunciation.';

  let nextAction: CoachResponse['nextAction'] = 'repeat';
  let nextCue = `For the next try, look at the reference: ${s.cue.toLowerCase()} Choose one cue to explore comfortably.`;
  if (a.kind === 'independent') {
    nextAction = 'next-context';
    nextCue = `When it feels comfortable, try the same “${s.spelled}” inside the word “${s.example}”, or bring the visual guide back.`;
  } else if (a.feeling === 'too-hard') {
    nextAction = 'simplify';
    nextCue = 'Let’s keep it gentle: hold the sound for just a second or two, with the reference visible.';
  } else if (a.kind === 'guided' && a.usableVoicedSec >= 2) {
    nextAction = 'reduce-assistance';
    nextCue += ' If you’d like, try once with fewer cues.';
  }

  return { attemptId: a.attemptId, source: 'local', observation, nextCue, nextAction, evidence };
}

export function assistanceLabel(a: Assistance) {
  return a === 'cue-target' ? 'Visual cue + target' : a === 'target-only' ? 'Target only' : 'Cues hidden';
}
