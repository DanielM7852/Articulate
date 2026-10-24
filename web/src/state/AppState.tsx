import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Attempt, Preferences, Plan, SoundId } from './types';

/**
 * Session-wide learner state. Access settings (captions, audio, narration, camera)
 * live here so they stay consistent on every screen. Attempt summaries and the
 * practice plan persist to localStorage when available; the app works without it.
 *
 * Quiz answers and progress are session-only: every visit starts with the guide,
 * runs the quiz with no pre-selected answers, then the tutorial, then practice.
 */
interface AppState {
  /** True once the quiz is finished this session. */
  quizDone: boolean;
  /** True once the tutorial is finished this session; unlocks practice. */
  onboarded: boolean;
  captions: boolean;
  audio: boolean;
  /** Coach feedback is read aloud (needs audio). */
  narration: boolean;
  camera: boolean;
  preferences: Preferences;
  plan: Plan;
  attempts: Attempt[];
}

interface AppActions {
  completeQuiz: () => void;
  completeOnboarding: () => void;
  /** Back to a fresh session. */
  reset: () => void;
  setCaptions: (on: boolean) => void;
  setAudio: (on: boolean) => void;
  setNarration: (on: boolean) => void;
  setCamera: (on: boolean) => void;
  updatePreferences: (patch: Partial<Preferences>) => void;
  updatePlan: (patch: Partial<Plan>) => void;
  addAttempt: (attempt: Attempt) => void;
  updateAttempt: (attemptId: string, patch: Partial<Attempt>) => void;
  clearAttempts: () => void;
}

const STORAGE_KEY = 'articulate.state.v2';

/** No answer is ever pre-selected: the quiz starts blank so choices are the learner's own. */
export const EMPTY_PREFERENCES: Preferences = {
  goals: [],
  routine: null,
  pace: null,
  support: null,
  guidance: null,
};

const defaultState: AppState = {
  quizDone: false,
  onboarded: false,
  captions: true,
  audio: true,
  narration: true,
  camera: false,
  preferences: EMPTY_PREFERENCES,
  plan: {
    pace: 'unhurried',
    assistance: 'cue-target',
    sound: 'i',
  },
  attempts: [],
};

/** Session-only fields: never restored from storage. */
const SESSION_DEFAULTS = { quizDone: false, onboarded: false, preferences: EMPTY_PREFERENCES } satisfies Partial<AppState>;

function load(): AppState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState;
    const parsed = JSON.parse(raw) as Partial<AppState>;
    return {
      ...defaultState,
      ...parsed,
      ...SESSION_DEFAULTS,
      plan: { ...defaultState.plan, ...parsed.plan },
    };
  } catch {
    return defaultState;
  }
}

const Ctx = createContext<(AppState & AppActions) | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(load);

  useEffect(() => {
    try {
      // Recordings are never persisted; only summaries of attempts.
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, ...SESSION_DEFAULTS }));
    } catch {
      /* storage unavailable: keep working in memory */
    }
  }, [state]);

  const patch = useCallback((p: Partial<AppState>) => setState((s) => ({ ...s, ...p })), []);

  const actions: AppActions = useMemo(
    () => ({
      completeQuiz: () => patch({ quizDone: true }),
      completeOnboarding: () => patch({ onboarded: true }),
      reset: () => setState(defaultState),
      setCaptions: (on) => patch({ captions: on }),
      setAudio: (on) => setState((s) => ({ ...s, audio: on, narration: on ? s.narration : false })),
      setNarration: (on) => setState((s) => ({ ...s, narration: on, audio: on ? true : s.audio })),
      setCamera: (on) => patch({ camera: on }),
      updatePreferences: (p) => setState((s) => ({ ...s, preferences: { ...s.preferences, ...p } })),
      updatePlan: (p) => setState((s) => ({ ...s, plan: { ...s.plan, ...p } })),
      addAttempt: (a) => setState((s) => ({ ...s, attempts: [...s.attempts, a] })),
      updateAttempt: (id, p) =>
        setState((s) => ({ ...s, attempts: s.attempts.map((a) => (a.attemptId === id ? { ...a, ...p } : a)) })),
      clearAttempts: () => patch({ attempts: [] }),
    }),
    [patch],
  );

  return <Ctx.Provider value={{ ...state, ...actions }}>{children}</Ctx.Provider>;
}

export function useAppState() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAppState must be used inside AppStateProvider');
  return v;
}

export function attemptsFor(attempts: Attempt[], sound: SoundId) {
  return attempts.filter((a) => a.sound === sound);
}
