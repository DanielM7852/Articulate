import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Attempt, Preferences, Plan, SoundId } from './types';

/**
 * Session-wide learner state. Access settings (captions, audio, narration, camera)
 * live here so they stay consistent on every screen, as the design requires.
 * Preferences and attempts persist to localStorage when available; the app works
 * without it. Sign-in and onboarding progress are session-only, so every visit
 * starts at sign-in and runs through the welcome, quiz, setup and plan screens.
 */
interface AppState {
  learnerName: string | null;
  learnerEmail: string | null;
  isReturning: boolean;
  /** True once the learner has finished onboarding (quiz, setup, plan) this session. */
  onboarded: boolean;
  captions: boolean;
  audio: boolean;
  narration: boolean;
  camera: boolean;
  preferences: Preferences;
  plan: Plan;
  attempts: Attempt[];
}

interface AppActions {
  signIn: (name: string, returning: boolean, email: string) => void;
  signOut: () => void;
  completeOnboarding: () => void;
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

const STORAGE_KEY = 'articulate.state.v1';
const LEARNERS_KEY = 'articulate.learners.v1';

const defaultState: AppState = {
  learnerName: null,
  learnerEmail: null,
  isReturning: false,
  onboarded: false,
  captions: true,
  audio: false,
  narration: false,
  camera: false,
  preferences: {
    goals: ['conversations', 'visual'],
    routine: 'occasional',
    pace: 'unhurried',
    support: 'mouth',
    guidance: 'guided',
  },
  plan: {
    pace: 'unhurried',
    assistance: 'cue-target',
    sound: 'i',
  },
  attempts: [],
};

/** Session-only fields: never restored from storage. */
const SESSION_DEFAULTS = { learnerName: null, learnerEmail: null, isReturning: false, onboarded: false } satisfies Partial<AppState>;

interface LearnerRecord {
  plan: Plan;
  attempts: Attempt[];
  preferences: Preferences;
}

function readLearners(): Record<string, LearnerRecord> {
  try {
    const raw = window.localStorage.getItem(LEARNERS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<LearnerRecord>>;
    return Object.fromEntries(
      Object.entries(parsed).map(([email, record]) => [
        email,
        {
          plan: { ...defaultState.plan, ...record.plan },
          attempts: record.attempts ?? [],
          preferences: { ...defaultState.preferences, ...record.preferences },
        },
      ]),
    );
  } catch {
    return {};
  }
}

function writeLearner(email: string, record: LearnerRecord) {
  const all = readLearners();
  all[email] = record;
  window.localStorage.setItem(LEARNERS_KEY, JSON.stringify(all));
}

function readStoredAttempts(): LearnerRecord | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AppState>;
    if (!parsed.attempts?.length) return null;
    return {
      plan: { ...defaultState.plan, ...parsed.plan },
      attempts: parsed.attempts,
      preferences: { ...defaultState.preferences, ...parsed.preferences },
    };
  } catch {
    return null;
  }
}

const legacySnapshot = readStoredAttempts();

function loadLegacy(email: string): LearnerRecord | null {
  if (!email || !legacySnapshot) return null;
  if (Object.keys(readLearners()).length > 0) return null;
  return legacySnapshot;
}

function load(): AppState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState;
    const parsed = JSON.parse(raw) as Partial<AppState>;
    return {
      ...defaultState,
      ...parsed,
      ...SESSION_DEFAULTS,
      preferences: { ...defaultState.preferences, ...parsed.preferences },
      plan: { ...defaultState.plan, ...parsed.plan },
      attempts: [],
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
      // Recordings are never persisted; only summaries of attempts, and only for the signed-in learner.
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, ...SESSION_DEFAULTS, attempts: [] }));
      if (state.learnerEmail) {
        writeLearner(state.learnerEmail, { plan: state.plan, attempts: state.attempts, preferences: state.preferences });
      }
    } catch {
      /* storage unavailable: keep working in memory */
    }
  }, [state]);

  const patch = useCallback((p: Partial<AppState>) => setState((s) => ({ ...s, ...p })), []);

  const actions: AppActions = useMemo(
    () => ({
      signIn: (name, returning, email) =>
        setState((s) => {
          const key = email.trim().toLowerCase();
          const saved = readLearners()[key];
          const legacy = saved ? null : loadLegacy(key);
          return {
            ...s,
            learnerName: name,
            learnerEmail: key,
            isReturning: returning || Boolean(saved?.attempts.length || legacy?.attempts.length),
            onboarded: false,
            plan: saved?.plan ?? legacy?.plan ?? s.plan,
            attempts: saved?.attempts ?? legacy?.attempts ?? [],
            preferences: saved?.preferences ?? legacy?.preferences ?? s.preferences,
          };
        }),
      signOut: () =>
        setState((s) => {
          if (s.learnerEmail) {
            try {
              writeLearner(s.learnerEmail, { plan: s.plan, attempts: s.attempts, preferences: s.preferences });
            } catch {
              /* storage unavailable */
            }
          }
          return defaultState;
        }),
      completeOnboarding: () => patch({ onboarded: true }),
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
