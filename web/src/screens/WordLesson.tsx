import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Captions, Eye, MessageCircle, Mic, MicOff, RotateCcw, SkipForward, TriangleAlert, Video, VideoOff, X } from 'lucide-react';
import { CaptionBar, readingTime, useNarration } from '../components/Narration';
import { AccessToggles, OnboardingFrame, Segmented, StepHeading } from '../components/Onboarding';
import { CameraTile } from '../components/practice';
import { GhostBoard } from '../components/GhostBoard';
import { MouthReference, type MouthReferenceHandle } from '../components/MouthReference';
import { TeacherCaptions } from '../components/TeacherCaptions';
import { VoiceCheck, readStoredVoice, storeVoice, type StoredVoice } from '../components/VoiceCheck';
import { onTeacherFallback, prepareTeacher, unlockTeacherAudio } from '../audio/teacher';
import { ACTION_UNAVAILABLE, LEARNER_ATTEMPT_UNMEASURED, RESULT_INSTRUCTIONS, useAvaRealtime, type ActionResult, type AvaCoaching, type DemoKind, type DemoSpeed, type LessonAction } from '../realtime/useAvaRealtime';
import { screenStateMessage, type ScreenState } from '../realtime/screenState';
import { pickFiller } from '../realtime/fillers';
import { useMicrophone, type MicStatus } from '../audio/useMicrophone';
import { MAX_CLIP_MS, useAttemptAudio, type AttemptAudio } from '../audio/attemptAudio';
import { useVoiceFrames, type VoiceFrames } from '../audio/useVoiceFrames';
import { useLipTracking, type LipTrackingStatus } from '../vision/useLipTracking';
import { CUE_MIN_MS, useCoachSequence, type SequenceLine } from '../live/useCoachSequence';
import type { MouthCueId } from '@mouth-demo/src/mouth-demo.js';
import { unitDemoCue, zoneDemoCue } from '../game/ghost/demoCues';
import { usePhoneCursor } from '../live/usePhoneCursor';
import { ASSUMED_END_LAG_MS, RESCUE_MIN_CLIP_MS, applyPhoneJudgement, canPhoneRescue, clipOffsetMs, isPhoneJudged, scorePhones, unitPhoneZones } from '../live/phoneJudge';
import { isScored, requestWordAsk, requestWordCoach, scoreWord, wordFallbackLine } from '../live/wordCoach';
import { isClose, unitDurationMs } from '../game/ghost/follow';
import { ghostModel } from '../game/ghost/models';
import { MAX_TRIES, lessonPlan, nextStep, skipStep, startProgress, stepLabel, type LessonStep, type ProgressResult, type ProgressState } from '../game/ghost/plan';
import { DEFAULT_FACTOR } from '../game/ghost/voice';
import { GHOST_WORDS, partPrompt, type GhostWordSpec } from '../game/ghost/words';
import type { WordAttemptResult } from '../game/types';
import { useAppState } from '../state/AppState';
import { learnerProfileId } from '../state/learnerId';
import { rememberedRecapEmail, startRecap, type RecapStatus } from '../live/recap';
import { targetsFor } from '../vowel/targets';
import { FormantDebug } from '../components/FormantDebug';
import '../conversation/director/director.css';
import '../styles/word-lesson.css';

/**
 * Word lesson (ghost paths): the learner picks one of four words, does a short voice check once, and Ava coaches
 * the word one part at a time. The ghost board is the live visual; Ava, the 3D model and cues are the advice.
 *
 *   plan  = lessonPlan(word): each part on its own, then the whole word twice
 *   step  = intro line -> board watches the ghost -> (if practisable) live attempt -> coach -> progression
 *
 * Phases:
 *   setup    -> waiting for the microphone (and a tap, if the browser has not had one yet)
 *   voice    -> voice check (hold "uh", pick a voice group); skipped when a voice is stored
 *   intro    -> Ava introduces the step (side view / cue for a part)
 *   watch    -> the board plays the ghost for the step's unit
 *   cue      -> "Your turn" / "Again when you're ready."
 *   live     -> the board is scoring the learner
 *   thinking -> attempt sent to the coach; a short filler line plays
 *   coaching -> Ava says the coach's line (realtime: then the talk window)
 *
 * Talk window (realtime, between tries): the board keeps measuring but never decides. Its results are held; only Ava's
 * learner_attempt tool call scores the latest one (the Claude word coach, returned as the tool output, Ava relays it),
 * after which the lesson finishes the word, advances, or stays in the window. think_it_through, small talk and stay_quiet drop
 * the held results. The board is off while Ava speaks (plus a short echo settle), while deciding and while a relay is pending.
 *   done     -> "That's the word. Nice work." and the next word / Finish
 *
 * Cue-only steps (a lone sh or n) are watch-only: they never go live. Progression is nextStep() in plan.ts.
 */
type Phase = 'setup' | 'voice' | 'intro' | 'watch' | 'cue' | 'live' | 'thinking' | 'coaching' | 'done';

const WORD_KEYS = Object.keys(GHOST_WORDS);
const DEFAULT_WORD = 'track';

interface WordData {
  key: string;
  spec: GhostWordSpec;
  plan: LessonStep[];
}
const wordCache = new Map<string, WordData>();
function wordData(key: string): WordData {
  let data = wordCache.get(key);
  if (!data) {
    const spec = GHOST_WORDS[key] ?? GHOST_WORDS[DEFAULT_WORD];
    data = { key: spec.word, spec, plan: lessonPlan(spec) };
    wordCache.set(key, data);
  }
  return data;
}

const PAUSE_BEFORE_AGAIN_MS = 1000;
/** Extra time past a watch's own length before the lesson stops waiting for the board's onWatchEnd. */
const WATCH_SLACK_MS = 2500;
const PAUSE_AFTER_WATCH_MS = 500;

const LINES = {
  yourTurn: 'Your turn.',
  again: `Again when you're ready.`,
  voice: 'First, a quick voice check so the ghost fits your voice.',
  moveOn: `Let's move on. We'll come back to it.`,
  doneWord: (word: string) => `That's ${word}. Nice work.`,
};

/** Ava's scripted introduction of one step (the same lines the realtime path never needs: the script speaks these). */
function introLine(spec: GhostWordSpec, step: LessonStep): { text: string; side: boolean; cueId: MouthCueId | null; hold?: boolean } {
  const { label, zoneIds } = step.unit;
  if (step.kind === 'part') {
    if (!step.practisable) {
      const hint = spec.zones.find((z) => zoneIds.includes(z.id))?.hint ?? 'Watch the side view.';
      return { text: `The ${label} is one to feel more than see. ${hint}`, side: true, cueId: unitDemoCue(zoneIds), hold: true };
    }
    return { text: `Let's work on the ${label} in ${spec.word}. Watch the path.`, side: true, cueId: unitDemoCue(zoneIds), hold: true };
  }
  return {
    text: step.speedWatch < 1 ? `Now the whole word, slowly: ${spec.word}.` : `And at normal speed: ${spec.word}.`,
    side: false,
    cueId: null,
  };
}

/** Realtime Ava: how long to wait for her first sentence, for her to finish, and for start_practice to wait for her. */
const AVA_START_MS = 5000;
const AVA_IDLE_MS = 25_000;
const START_PRACTICE_IDLE_MS = 10_000;
/** Talk window: how far back a board result still counts for learner_attempt, how long that call waits for one
 *  (the board ends an attempt 600 ms after the voice stops), how many results are kept, and the quiet after Ava speaks. */
const ATTEMPT_LOOKBACK_MS = 6000;
const ATTEMPT_WAIT_MS = 3000; // also covers the phone judge (<= 1.5 s) after the board's own end
const MAX_HELD = 4;
const ECHO_SETTLE_MS = 700;
const TALK_POLL_MS = 120;
/** Attempt audio for the coach: the board reports 600 ms after the last voiced frame and durationMs stops at that
 *  frame, so the clip reaches back over that tail plus a short pre-roll before the first voiced frame. */
const CLIP_TAIL_MS = 600;
const CLIP_PREROLL_MS = 250;

const lessonContext = (word: string) =>
  `[app] Lesson context: the practice word is "${word}". The lesson goes one part of the word at a time, then joins the parts back into the whole word. ` +
  'The app runs the lesson and the ghost board measures every try. ' +
  'Stay silent until the app sends you your notes on a try or the learner speaks to you between tries.';
const stepMessage = (spec: GhostWordSpec, step: LessonStep) => {
  if (step.kind === 'word') return `[app] Now practising the whole word "${spec.word}".`;
  const ask = partPrompt(spec, step.unit);
  return `[app] Now practising the "${ask.label}" part of "${spec.word}".` + (ask.tail ? ` Ask for it like this: "${ask.spoken}" Never say just the letter name.` : '');
};
const wordDoneMessage = (word: string, next: string | null) =>
  `[app] The word "${word}" is complete and the board is off. ` +
  (next ? `The learner can press the button for "${next}" or Finish. ` : 'The learner can press Finish. ') +
  'If they try the word again, tell them to use those buttons.';

/** Per-turn instructions for giving feedback (appended to Ava's persona, never replacing it). */
const ADVANCE_INSTRUCTIONS =
  'These are your own notes on the try. Say them in your own words, as yourself, in one or two short sentences. Keep their meaning. ' +
  'The app is moving on to the next step now: do not invite another try of this part. ' +
  'Do not add numbers or anatomy beyond the notes.';
const GENTLE_INSTRUCTIONS =
  'These are your own notes on the try. Say them in your own words, as yourself, in one short sentence. Keep their meaning. ' +
  `Then say gently that you will move on and come back to it. Do not call it a pass. ` +
  'Do not add numbers or anatomy beyond the notes.';
const finalInstructions = (word: string) =>
  'These are your own notes on the try. Say them in your own words, as yourself, in one or two short sentences. Keep their meaning. ' +
  `The word is complete: end with "That's ${word}. Nice work." Give brief, restrained praise and do not invite another try. ` +
  'Do not add numbers or anatomy beyond the notes.';

/** A coached learner_attempt whose relay Ava is about to speak; the talk window loop waits for it, then moves on. */
interface PendingRelay {
  next: 'final' | 'advance' | 'again';
  /** Advancing after a part that did not pass ("move on, come back to it"). */
  gentle: boolean;
  caption: string;
  side: boolean;
  cueId: MouthCueId | null;
  focus: string | null;
  /** ava.speechCount() when the tool call returned: a higher count means her relay started. */
  before: number;
  /** The side-view / cue presentation; resolves to when the cue appeared (0 if none). */
  view: Promise<number>;
}

/**
 * The talk window between attempts: the board listens (and only measures) while Ava hears the learner. Board results
 * are held in `results` and age out; only Ava's learner_attempt tool call turns one into an attempt.
 */
interface TalkWindow {
  active: boolean;
  run: number;
  /** Board results received while the window was live, newest last. */
  results: { result: WordAttemptResult; at: number }[];
  /** learner_attempt is scoring a held result: the board is not live. */
  deciding: boolean;
  pending: PendingRelay | null;
}

/** Everything one coached attempt produced (see coachResult). */
interface Coached {
  prog: ProgressResult;
  finalStep: boolean;
  caption: string;
  focus: string | null;
  cueId: MouthCueId | null;
  side: boolean;
  verdict: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function micLabel(mic: MicStatus, voice: VoiceFrames['status']): string {
  if (mic === 'denied') return 'Microphone blocked';
  if (mic === 'unsupported') return 'Microphone unsupported';
  if (mic === 'requesting') return 'Asking for the microphone…';
  if (mic === 'idle') return 'Microphone off';
  if (voice === 'tracking') return 'Microphone on';
  if (voice === 'error') return 'Voice tracking unavailable';
  return 'Microphone ready';
}

const LIP_LABEL: Record<LipTrackingStatus, string> = {
  off: 'Camera off',
  loading: 'Loading lip tracking',
  tracking: 'Lip tracking on',
  'no-face': 'Face not found',
  error: 'Lip tracking unavailable',
};

const cap = (text: string) => `${text[0].toUpperCase()}${text.slice(1)}`;

export default function WordLesson() {
  const navigate = useNavigate();
  const mic = useMicrophone();
  const attemptTap = useAttemptAudio(mic.stream);
  /** When the board produced the result being judged (Date.now() clock), so the coach clip ends there, not after scoring. */
  const judgedAt = useRef<{ attemptId: string; at: number } | null>(null);
  /** Attempt ids judged this lesson, and the recap started for them on Finish (re-run only if more were judged since). */
  const judgedIds = useRef<Set<string>>(new Set());
  const recapStart = useRef<{ count: number; promise: Promise<RecapStatus | null> } | null>(null);
  const voice = useVoiceFrames(mic.stream);
  const { camera, setCamera, narration: voiceOn, captions, completeOnboarding } = useAppState();
  const profileId = useMemo(() => learnerProfileId(), []);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const lip = useLipTracking(videoEl, camera);
  const mouthRef = useRef<MouthReferenceHandle | null>(null);
  const seq = useCoachSequence(
    () => mouthRef.current,
    () => undefined, // Ava is always on screen here
  );
  const narration = useNarration();

  // The word being practised. The ref is what async code reads (it changes synchronously when the word does).
  const [wordKey, setWordKey] = useState(DEFAULT_WORD);
  const cur = useRef<WordData>(wordData(DEFAULT_WORD));
  const { spec, plan } = wordData(wordKey);
  // The learner's voice size: stored once, redone on request.
  const [learner, setLearner] = useState<StoredVoice | null>(() => readStoredVoice());
  const learnerRef = useRef(learner);
  learnerRef.current = learner;
  const learnerFactor = learner?.factor ?? DEFAULT_FACTOR;
  // One model feeds both the board's drawing and its GhostAttempt scoring (GhostBoard sizes it once).
  const learnerVowels = learner?.vowels;
  const model = useMemo(
    () => ghostModel(spec.word, learner ? { factor: learner.factor, anchors: learnerVowels } : undefined),
    [spec.word, learner?.factor, learnerVowels],
  );
  const modelRef = useRef(model);
  modelRef.current = model;
  const targets = useMemo(() => targetsFor(learner), [learner]);
  const [voiceListening, setVoiceListening] = useState(false);

  const [phase, setPhaseState] = useState<Phase>('setup');
  const phaseRef = useRef<Phase>('setup');
  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);
  const [attemptId, setAttemptIdState] = useState(() => crypto.randomUUID());
  const attemptIdRef = useRef(attemptId);
  const newAttempt = useCallback(() => {
    const id = crypto.randomUUID();
    attemptIdRef.current = id;
    setAttemptIdState(id);
  }, []);
  const [focusZoneId, setFocusZoneId] = useState<string | null>(null);

  // Progress through the plan: `progress.step` is the step to run next, `shownStep` the one on screen (and in the board).
  const progress = useRef<ProgressState>(startProgress());
  const shownStep = useRef(0);
  const [stepIdx, setStepIdx] = useState(0);
  const [tries, setTries] = useState(0);

  // Every async step checks this token; leaving, skipping or a new run bumps it.
  const runId = useRef(0);
  const coachAbort = useRef<AbortController | null>(null);
  const lastFiller = useRef<string | null>(null);
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;
  const watchDone = useRef<(() => void) | null>(null);

  // Realtime Ava (OpenAI writes the coaching line, Cartesia speaks it). Every use is gated on realtimeActive(),
  // so with no key / a failed connect / narration off the lesson is exactly the scripted one.
  const coachCache = useRef(new Map<string, AvaCoaching>());
  const lastCoachId = useRef<string | null>(null);
  const lastResult = useRef<{ result: WordAttemptResult; practice: string[] } | null>(null);
  // Who may speak through Cartesia: the scripted sequence or realtime Ava, never both (Ava's canSpeak reads this).
  const floor = useRef<'script' | 'ava'>('script');
  const win = useRef<TalkWindow>({ active: false, run: 0, results: [], deciding: false, pending: null });
  const windowLiveRef = useRef(false);
  const [windowLive, setWindowLive] = useState(false);
  // Late-bound handlers for the talk window (assigned each render below), so the hook options stay stable.
  const talkEvents = useRef<{ attempt: () => Promise<unknown>; talk: () => void; quiet: () => void }>({
    attempt: async () => ({ measured: false }),
    talk: () => undefined,
    quiet: () => undefined,
  });
  const startPracticeSignal = useRef(false);
  const avaLipStop = useRef<(() => void) | null>(null);
  const avaCue = useRef(false); // a cue owns the mouth, so no lip sync
  const avaView = useRef(false); // the realtime path moved the avatar to the side view
  const lastSide = useRef<SequenceLine | null>(null); // the latest line that played a side-view demo, for "Replay side view"
  const replayingRef = useRef(false);
  const [replaying, setReplaying] = useState(false);
  const [mouthSlow, setMouthSlow] = useState(false); // slow-motion demo: the 3D mouth plays at half speed
  const watchSpeedRef = useRef<number | null>(null); // ghost-path demo speed override (null = the step's own speedWatch)
  const [watchSpeed, setWatchSpeedState] = useState<number | null>(null);
  const setWatchSpeed = useCallback((v: number | null) => {
    watchSpeedRef.current = v;
    setWatchSpeedState(v);
  }, []);
  const avaCueId = useRef<MouthCueId | null>(null); // the cue on screen from a realtime view, for the screen state
  const lastScreenMsg = useRef('');
  // Late-bound handlers for Ava's show_demo / lesson_control tools (assigned each render below).
  const actionEvents = useRef<{
    demo: (what: DemoKind, speed: DemoSpeed) => Promise<ActionResult>;
    control: (action: LessonAction) => Promise<ActionResult>;
  }>({
    demo: async () => ({ ok: false, reason: 'unavailable' }),
    control: async () => ({ ok: false, reason: 'unavailable' }),
  });
  const [hasSide, setHasSide] = useState(false);
  const spokeRef = useRef(false); // the learner has voiced something in the current live attempt
  const [spoke, setSpoke] = useState(false);
  const mounted = useRef(true);
  const [talking, setTalking] = useState(false);
  const [voiceFallback, setVoiceFallback] = useState(false); // a line fell back to the browser voice (sticky)
  const ava = useAvaRealtime({
    profileId,
    getCoaching: async (id) => {
      const hit = coachCache.current.get(id === 'latest' ? (lastCoachId.current ?? '') : id);
      if (!hit) throw new Error('No coaching for that attempt.');
      return hit;
    },
    onStartPractice: () => {
      startPracticeSignal.current = true;
    },
    canSpeak: () => floor.current === 'ava',
    onLearnerAttempt: () => talkEvents.current.attempt(),
    onStayQuiet: () => talkEvents.current.quiet(),
    onShowDemo: (what, speed) => actionEvents.current.demo(what, speed),
    onLessonControl: (action) => actionEvents.current.control(action),
    askCoach: async (question) => {
      talkEvents.current.talk(); // Ava is about to answer: this utterance was talk
      const { spec: word, plan: steps } = cur.current;
      const practice = steps[shownStep.current]?.unit.zoneIds;
      const cached = lastCoachId.current ? coachCache.current.get(lastCoachId.current) : undefined;
      // The last attempt only describes the part being practised now; an unscored result is never passed on as a score.
      const last = lastResult.current && practice && lastResult.current.practice.join() === practice.join() ? lastResult.current : null;
      const score = last ? scoreWord(last.result, last.practice) : null;
      const scored = score !== null && score.verdict !== 'insufficient' && isScored(score);
      const resp = await requestWordAsk(
        {
          profileId,
          word: word.word,
          question,
          lastCoaching: cached ? { caption: cached.caption, focusZoneId: cached.focusZoneId } : null,
          lastAttempt: score
            ? {
                verdict: scored || score.verdict === 'insufficient' ? score.verdict : null,
                hitCount: scored ? score.hitCount : null,
                zoneCount: scored ? score.zoneCount : null,
                weakestZoneId: score.weakestZoneId,
              }
            : null,
          tries: progress.current.tries,
          ...(practice ? { practiceZoneIds: practice } : {}),
        },
        AbortSignal.timeout(10_000),
      );
      return { say: resp.say };
    },
    onSpeech: (sp) => {
      // A sentence starting says nothing about the held results: it may be the "Let me look." before learner_attempt.
      // Same binding as useCoachSequence.lipSync; the previous sentence's binding is released first.
      avaLipStop.current?.();
      avaLipStop.current = null;
      const avatar = mouthRef.current;
      if (!avatar?.ready || avaCue.current) return;
      const handle = avatar.speak({ clock: () => sp.clock(), timeline: { words: [...sp.words], phonemes: [...sp.phonemes] } });
      if (!handle) return;
      const offTimeline = sp.on('timeline', (added) => handle.append(added));
      const offEnd = sp.on('end', () => handle.end());
      avaLipStop.current = () => {
        offTimeline();
        offEnd();
        handle.stop();
      };
    },
  });
  const avaRef = useRef(ava);
  avaRef.current = ava;
  const avaOpen = useCallback(() => avaRef.current.session()?.state === 'open', []);
  /** True when this lesson is currently coached by the realtime persona. */
  const realtimeActive = useCallback(() => voiceOnRef.current && avaOpen(), [avaOpen]);
  const realtimeOn = voiceOn && ava.state === 'open';

  /** Silence Ava-realtime and its lip sync; optionally bring the avatar back from a realtime cutaway. */
  const quietAva = useCallback((resetView = true) => {
    avaRef.current.stopSpeaking();
    avaLipStop.current?.();
    avaLipStop.current = null;
    avaCue.current = false;
    avaCueId.current = null;
    if (resetView && avaView.current) {
      avaView.current = false;
      const av = mouthRef.current;
      if (av?.ready) {
        av.stop();
        void av.setView('front').catch(() => undefined);
      }
    }
  }, []);

  /** Let go of a pending watch wait (the board's onWatchEnd may never come once the run is superseded). */
  const releaseWatch = useCallback(() => watchDone.current?.(), []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      runId.current++;
      coachAbort.current?.abort();
      releaseWatch();
      win.current.active = false;
    };
  }, [releaseWatch]);

  // Cartesia fell back to the browser voice: say so for the rest of the lesson.
  useEffect(() => onTeacherFallback(() => setVoiceFallback(true)), []);

  /** Close the talk window: held results, a pending relay and any decision are dropped. Safe to call at any time. */
  const endWindow = useCallback(() => {
    const w = win.current;
    Object.assign(w, { active: false, results: [], deciding: false, pending: null });
    windowLiveRef.current = false;
    setWindowLive(false);
    setTalking(false);
  }, []);

  // Narration switched off mid-lesson: drop the realtime session so Ava never speaks over a silent lesson.
  useEffect(() => {
    if (!voiceOn && avaOpen()) avaRef.current.disconnect();
  }, [voiceOn, avaOpen]);

  // Ask for the microphone as soon as the screen opens.
  const micStart = mic.start;
  useEffect(() => {
    void micStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The scripted sequence takes the floor: realtime Ava may not speak and is silenced first (never two voices). */
  const takeFloor = useCallback(
    (resetView = false) => {
      floor.current = 'script';
      if (realtimeActive()) quietAva(resetView);
    },
    [realtimeActive, quietAva],
  );

  /** Realtime Ava takes the floor: let any scripted line finish, stop the sequence, then she may speak. */
  const giveFloorToAva = useCallback(
    async (my: number): Promise<boolean> => {
      await seq.whenIdle();
      if (runId.current !== my) return false;
      seq.cancel();
      floor.current = 'ava';
      return true;
    },
    [seq.whenIdle, seq.cancel],
  );

  /** Remember the latest line that showed the side view, so the learner can replay it. */
  const rememberSide = useCallback((l: SequenceLine) => {
    lastSide.current = l;
    setHasSide(true);
  }, []);

  /** Whether a demo of the side view / mouth cue may play in this phase (the phases where the Replay button shows, plus 'thinking' for the guard). */
  const demoPhaseOk = useCallback((ph: Phase): boolean => {
    if (ph === 'live' || ph === 'done' || ph === 'coaching' || ph === 'thinking') return true;
    return ph === 'cue' && !cur.current.plan[shownStep.current]?.practisable;
  }, []);

  /** The demo cue the current part shows on its own (unitDemoCue), or null for a whole-word step. */
  const stepCue = useCallback((): MouthCueId | null => {
    const st = cur.current.plan[shownStep.current];
    if (!st || st.kind !== 'part') return null;
    return unitDemoCue(st.unit.zoneIds);
  }, []);

  /**
   * Which mouth cue show_demo(mouth_cue) plays. The CURRENT step's cue wins: replay the last side line when it already
   * carries that cue, else play the step's cue as a fresh line. Only a step without a cue falls back to the last line's
   * cue (for example a feedback cue on a whole-word step). The screen state's canMouthCue uses the same choice.
   */
  const mouthCueChoice = useCallback((): { line: SequenceLine | undefined } | null => {
    const last = lastSide.current;
    const cueId = stepCue();
    if (cueId) {
      if (last?.cueId === cueId) return { line: undefined };
      return { line: { text: `Watch my mouth for the ${cur.current.plan[shownStep.current].unit.label}.`, cueId, showSideView: true } };
    }
    return last?.cueId ? { line: undefined } : null;
  }, [stepCue]);

  /** What the learner sees and what Ava may do now. Capabilities are structural (phase, step, word); a try in flight is answered by the tool guards. */
  const screenState = useCallback((): ScreenState => {
    const { spec: word, plan: steps } = cur.current;
    const ph = phaseRef.current;
    const idx = Math.min(shownStep.current, steps.length - 1);
    const st = steps[idx];
    const started = ph !== 'setup' && ph !== 'voice';
    const done = ph === 'done';
    const running = started && !done;
    const demoOk = started && demoPhaseOk(ph);
    const cached = lastCoachId.current ? coachCache.current.get(lastCoachId.current) : undefined;
    const next = WORD_KEYS[WORD_KEYS.indexOf(word.word) + 1] ?? null;
    return {
      word: word.word,
      step: done ? 'word complete' : stepLabel(steps, idx),
      view: avaView.current ? 'side' : 'front',
      cue: avaCue.current ? avaCueId.current : null,
      feedback: cached?.caption ?? null,
      canMouthCue: demoOk && mouthCueChoice() !== null,
      canSideView: demoOk && !!lastSide.current,
      canGhostPath: running,
      canNextPart: running,
      canRepeatPart: running,
      canTryNow: running && !!st?.practisable && ph !== 'live',
      canNextWord: done && !!next,
      canFinish: done,
    };
  }, [demoPhaseOk, mouthCueChoice]);

  /** Tell Ava what is on screen (never a duplicate of the last message, never when she is not live). */
  const sendScreen = useCallback(() => {
    if (!realtimeActive()) return;
    const msg = screenStateMessage(screenState());
    if (msg === lastScreenMsg.current) return;
    lastScreenMsg.current = msg;
    avaRef.current.sendAppMessage(msg, false);
  }, [realtimeActive, screenState]);

  /** One Ava line. With narration off the caption stays up for its reading time. False if superseded. */
  const line = useCallback(
    async (text: string, side = false, cueId: MouthCueId | null = null, hold = false): Promise<boolean> => {
      const my = runId.current;
      const started = Date.now();
      takeFloor();
      if (side) rememberSide({ text, cueId, showSideView: true });
      await seq.speakLine({ text, cueId, showSideView: side, hold }, { narration: voiceOnRef.current });
      if (runId.current !== my) return false;
      if (!voiceOnRef.current) {
        const left = readingTime(text) - (Date.now() - started);
        if (left > 0) await sleep(left);
      }
      return runId.current === my;
    },
    [rememberSide, seq.speakLine, takeFloor],
  );

  /** Gate the realtime mic (VAD off, mic disabled) so scripted lines and the board never feed Ava. False if superseded. */
  const gateAva = useCallback(
    async (my: number): Promise<boolean> => {
      const session = avaRef.current.session();
      if (realtimeActive() && session && !session.practiceMode) {
        try {
          await avaRef.current.setPracticeMode(true);
        } catch {
          /* the session was lost; the lesson carries on scripted */
        }
      }
      return runId.current === my;
    },
    [realtimeActive],
  );

  /** Connect the realtime persona. Failure (no key, quota, network) is not an error: the scripted lesson carries on. */
  const connectAva = useCallback(async () => {
    const a = avaRef.current;
    try {
      await a.connect();
    } catch {
      /* connect reports through ava.error and the session state */
    }
    if (a.session()?.state !== 'open') {
      console.info('Realtime Ava unavailable; using the scripted coach voice.');
      return;
    }
    if (!mounted.current || !voiceOnRef.current) {
      a.disconnect();
      return;
    }
    // The session opens gated (mic disabled, VAD off) and the floor is the script's, so Ava stays silent until a relay,
    // the talk window or the done chat hands her the floor.
    const { spec: word, plan: steps } = cur.current;
    a.sendAppMessage(lessonContext(word.word), false);
    const step = steps[shownStep.current];
    if (step && phaseRef.current !== 'setup' && phaseRef.current !== 'voice' && phaseRef.current !== 'done') a.sendAppMessage(stepMessage(word, step), false);
  }, []);

  /** Wait for the board's watch to end (onWatchEnd), or give up a little after its own length. */
  const waitWatch = useCallback(
    (step: LessonStep) =>
      new Promise<void>((resolve) => {
        const ms = unitDurationMs(modelRef.current, step.unit) / (watchSpeedRef.current ?? step.speedWatch) + WATCH_SLACK_MS;
        const finish = () => {
          clearTimeout(timer);
          if (watchDone.current === finish) watchDone.current = null;
          resolve();
        };
        const timer = setTimeout(finish, ms);
        watchDone.current = finish;
      }),
    [],
  );

  /** Ava's cue, then the board goes live with a fresh attempt id. */
  const goLive = useCallback(
    async (text: string) => {
      setPhase('cue');
      if (!(await line(text))) return;
      newAttempt();
      setPhase('live');
      sendScreen();
    },
    [line, newAttempt, sendScreen, setPhase],
  );

  /** A scripted-style turn: the script has the floor, Ava is silenced and gated, the board goes live with a fresh attempt. */
  const beginTurn = useCallback(
    async (my: number, resetView: boolean) => {
      if (!cur.current.plan[shownStep.current]?.practisable) return; // cue-only steps never go live
      takeFloor(resetView);
      if (realtimeActive()) {
        await avaRef.current.setPracticeMode(true); // gate the mic before the board goes live
        if (runId.current !== my) return;
      }
      newAttempt();
      setPhase('live');
    },
    [newAttempt, realtimeActive, setPhase, takeFloor],
  );

  /** Start the session recap for the attempts judged so far (null when there are none or it can't start). Never throws. */
  const startRecapOnce = useCallback((): Promise<RecapStatus | null> => {
    const ids = [...judgedIds.current].slice(-200);
    if (ids.length === 0) return Promise.resolve(null);
    if (recapStart.current && recapStart.current.count === judgedIds.current.size) return recapStart.current.promise;
    const promise = startRecap({ profileId, attemptIds: ids, word: cur.current.spec.word, email: rememberedRecapEmail() || null })
      .catch(() => null);
    recapStart.current = { count: judgedIds.current.size, promise };
    return promise;
  }, [profileId]);

  /** The word is finished: Ava says so (unless her relay already did) and offers the next word. */
  const wordDone = useCallback(
    async (viaAva: boolean) => {
      const word = cur.current.spec.word;
      setFocusZoneId(null);
      if (!viaAva) {
        if (!(await line(LINES.doneWord(word)))) return;
      }
      setPhase('done'); // when Ava relayed the last coaching she keeps the floor so the learner can chat until Finish
      if (realtimeActive()) {
        const at = WORD_KEYS.indexOf(word);
        avaRef.current.sendAppMessage(wordDoneMessage(word, WORD_KEYS[at + 1] ?? null), false);
        sendScreen();
      }
    },
    [line, realtimeActive, sendScreen, setPhase],
  );

  /**
   * Run the step at progress.step: Ava's intro, the board watching the ghost, then (practisable steps) a live attempt.
   * Watch-only steps move on by themselves after the watch.
   */
  const runStep = useCallback(
    async (my: number): Promise<void> => {
      const { spec: word, plan: steps } = cur.current;
      const index = progress.current.step;
      if (index >= steps.length) return wordDone(false);
      const step = steps[index];
      shownStep.current = index;
      setStepIdx(index);
      setTries(progress.current.tries);
      setFocusZoneId(null);
      lastResult.current = null;
      lastCoachId.current = null;
      endWindow();
      setWatchSpeed(null);
      takeFloor(true);
      setPhase('intro');
      if (!(await gateAva(my))) return;
      if (realtimeActive()) {
        avaRef.current.sendAppMessage(stepMessage(word, step), false);
        sendScreen();
      }
      const intro = introLine(word, step);
      if (!(await line(intro.text, intro.side, intro.cueId, intro.hold))) return;
      newAttempt();
      setPhase('watch');
      await waitWatch(step);
      if (runId.current !== my) return;
      if (!step.practisable) {
        await sleep(PAUSE_AFTER_WATCH_MS);
        if (runId.current !== my) return;
        progress.current = skipStep(progress.current);
        return runStep(my);
      }
      await goLive(LINES.yourTurn);
    },
    [endWindow, gateAva, goLive, line, newAttempt, realtimeActive, sendScreen, setPhase, setWatchSpeed, takeFloor, waitWatch, wordDone],
  );

  /** Start a word from its first step. Cancels whatever is running. */
  const startWord = useCallback(
    async (key: string) => {
      const my = ++runId.current;
      coachAbort.current?.abort();
      releaseWatch();
      seq.cancel();
      endWindow();
      cur.current = wordData(key);
      setWordKey(cur.current.key);
      progress.current = startProgress();
      shownStep.current = 0;
      lastSide.current = null; // a new word: nothing to replay yet
      setHasSide(false);
      floor.current = 'script';
      if (realtimeActive()) {
        quietAva(true);
        avaRef.current.sendAppMessage(lessonContext(cur.current.spec.word), false);
      }
      await runStep(my);
    },
    [endWindow, quietAva, realtimeActive, releaseWatch, runStep, seq.cancel],
  );

  /** Tear down whatever is running (used before switching to another screen state). */
  const stopRun = useCallback(() => {
    runId.current++;
    coachAbort.current?.abort();
    releaseWatch();
    seq.cancel();
    floor.current = 'script';
    endWindow();
  }, [endWindow, releaseWatch, seq.cancel]);

  const startLesson = useCallback(async () => {
    const my = ++runId.current;
    coachAbort.current?.abort();
    prepareTeacher();
    void unlockTeacherAudio();
    narration.show(null);
    floor.current = 'script';
    endWindow();
    if (voiceOnRef.current) void connectAva(); // user gesture; the intro does not wait for it
    if (!learnerRef.current) {
      // First visit: size the ghost to the learner's voice before the first word.
      setPhase('voice');
      setVoiceListening(false);
      if (!(await line(LINES.voice))) return;
      setVoiceListening(true);
      return;
    }
    if (runId.current !== my) return;
    await startWord(cur.current.key);
  }, [connectAva, endWindow, line, narration.show, setPhase, startWord]);

  /** The voice check finished (or was skipped): keep the voice and start the word. */
  const voiceDone = (v: StoredVoice, stored: boolean) => {
    if (stored) storeVoice(v);
    setLearner(v);
    learnerRef.current = v;
    setVoiceListening(false);
    void startWord(cur.current.key).catch(() => undefined);
  };

  /** Header control: run the voice check again (the stored voice is kept until the new one is measured). */
  const redoVoice = () => {
    stopRun();
    quietAva(true);
    setPhase('voice');
    setFocusZoneId(null);
    setVoiceListening(true);
    if (realtimeActive()) void gateAva(runId.current);
  };

  /** Mouse path: skip whatever Ava is saying and start a new attempt now. */
  const skipToTurn = useCallback(async () => {
    const my = ++runId.current;
    coachAbort.current?.abort();
    releaseWatch();
    seq.cancel();
    endWindow();
    setWatchSpeed(null);
    await beginTurn(my, true);
  }, [beginTurn, endWindow, releaseWatch, seq.cancel, setWatchSpeed]);

  /** "Watch again": replay the ghost for the current step, then (practisable steps) the learner's turn. */
  const watchAgain = useCallback(async (speedOverride?: number) => {
    const my = ++runId.current;
    coachAbort.current?.abort();
    releaseWatch();
    seq.cancel();
    endWindow();
    const step = cur.current.plan[shownStep.current];
    if (!step) return;
    setFocusZoneId(null);
    setWatchSpeed(speedOverride ?? null); // Ava's slow-motion demo; the button passes nothing
    takeFloor(true);
    if (!(await gateAva(my))) return;
    newAttempt();
    const demoCue = step.kind === 'part' ? unitDemoCue(step.unit.zoneIds) : null;
    if (demoCue) void seq.showHeldCue(demoCue).catch(() => undefined); // side-view demo alongside the ghost board
    setPhase('watch');
    await waitWatch(step);
    if (runId.current !== my) return;
    setWatchSpeed(null);
    if (demoCue) seq.cancel(false); // avatar back to front for the learner's turn
    if (step.practisable) await beginTurn(my, false);
    else {
      setPhase('cue'); // watch-only: the learner moves on with "Next part"
      sendScreen();
    }
  }, [beginTurn, endWindow, gateAva, newAttempt, releaseWatch, sendScreen, seq.cancel, seq.showHeldCue, setPhase, setWatchSpeed, takeFloor, waitWatch]);

  /** "Next part": leave the current step without (or in the middle of) an attempt. */
  const nextPart = useCallback(async () => {
    const my = ++runId.current;
    coachAbort.current?.abort();
    releaseWatch();
    seq.cancel();
    endWindow();
    // progress.step may already point past the shown step (an advancing attempt was being coached): skip from the shown one.
    progress.current = skipStep({ ...progress.current, step: shownStep.current });
    if (progress.current.step >= cur.current.plan.length) await wordDone(false);
    else await runStep(my);
  }, [endWindow, releaseWatch, runStep, seq.cancel, wordDone]);

  /** Word picker / "Next word": switching restarts the plan. Before the lesson has begun it only changes the word. */
  const switchWord = useCallback(
    (key: string) => {
      if (key === cur.current.key) return;
      if (phaseRef.current === 'setup' || phaseRef.current === 'voice') {
        cur.current = wordData(key);
        setWordKey(cur.current.key);
        progress.current = startProgress();
        shownStep.current = 0;
        setStepIdx(0);
        return;
      }
      void startWord(key).catch(() => undefined);
    },
    [startWord],
  );

  /** Show the side view / cue for a coaching line. Resolves to when the cue appeared (0 if none or superseded). */
  const startView = useCallback(async (side: boolean, cueId: MouthCueId | null, my: number, text = ''): Promise<number> => {
    avaCue.current = side && cueId !== null;
    avaCueId.current = side ? cueId : null;
    if (side && text) rememberSide({ text, cueId, showSideView: true });
    const av = mouthRef.current;
    if (!side || !av?.ready) {
      sendScreen();
      return 0;
    }
    avaView.current = true;
    try {
      av.stop();
      await av.setView('side');
      if (runId.current !== my) return 0;
      if (cueId) av.showCue(cueId);
      sendScreen();
      return Date.now();
    } catch {
      return 0; // presentation only
    }
  }, [rememberSide, sendScreen]);

  /**
   * Realtime coaching for one attempt: cutaway/cue on the avatar, Ava relays the coach caption. 'spoken' when she
   * did, 'fallback' when she did not start in time or the relay failed (Ava is silenced and gated, the caller
   * speaks the line itself), 'aborted' when the run was superseded.
   */
  const coachWithAva = useCallback(
    async (
      p: { caption: string; focus: string | null; cueId: MouthCueId | null; side: boolean; attemptId: string; verdict: string; instructions?: string },
      my: number,
    ): Promise<'spoken' | 'fallback' | 'aborted'> => {
      const a = avaRef.current;
      const viewP = startView(p.side, p.cueId, my, p.caption);
      const before = a.speechCount();
      let relayed = true;
      try {
        await a.relayResult({ caption: p.caption, focusZoneId: p.focus, verdict: p.verdict }, p.attemptId, p.instructions);
      } catch {
        relayed = false;
      }
      const viewStart = await viewP;
      if (runId.current !== my) return 'aborted';
      if (relayed) {
        const until = Date.now() + AVA_START_MS;
        while (a.speechCount() === before && avaOpen() && Date.now() < until) {
          await sleep(100);
          if (runId.current !== my) return 'aborted';
        }
        relayed = a.speechCount() !== before;
      }
      if (!relayed) {
        // Ava could not take it: take the floor back, silence and gate her, and let the scripted path (which restores
        // the view) speak.
        floor.current = 'script';
        quietAva(false);
        avaView.current = false;
        await a.setPracticeMode(true);
        return runId.current === my ? 'fallback' : 'aborted';
      }
      await a.waitForIdle(AVA_IDLE_MS);
      if (runId.current !== my) return 'aborted';
      if (viewStart && p.cueId) {
        const left = CUE_MIN_MS - (Date.now() - viewStart);
        if (left > 0) await sleep(left);
        if (runId.current !== my) return 'aborted';
      }
      quietAva(); // stops lip sync, clears the cue flag and returns the avatar to the front view
      return 'spoken';
    },
    [avaOpen, quietAva, startView],
  );

  /**
   * Score one finished attempt: progression (nextStep / isClose), the Claude word coach (deterministic fallback line when
   * the backend is unreachable), the coach cache and the focus zone. `onStart` runs once progression is decided and
   * before the coach request (runAttempt starts its filler there). Null when run `my` was superseded.
   */
  const coachResult = useCallback(
    async (result: WordAttemptResult, step: LessonStep, my: number, onStart?: () => void, endedAt: number = Date.now()): Promise<Coached | null> => {
      const { spec: word, plan: steps } = cur.current;
      const practice = step.unit.zoneIds;
      lastResult.current = { result, practice };
      // Progression is decided now (the board's own judgement of the unit); the coaching line follows.
      const prog: ProgressResult = nextStep({ ...progress.current, step: shownStep.current }, isClose(result, step.unit));
      progress.current = prog.state;
      setTries(prog.state.tries);
      const finalStep = prog.advance && prog.state.step >= steps.length;
      onStart?.();

      coachAbort.current?.abort();
      const ctl = new AbortController();
      coachAbort.current = ctl;
      let caption: string;
      let focus: string | null;
      let cueId: MouthCueId | null = null;
      let side: boolean;
      let score = scoreWord(result, practice);
      // Best effort and synchronous: audio must never delay or break coaching.
      let audio: AttemptAudio | null = null;
      try {
        audio = attemptTap.current?.clip(endedAt, Math.min(MAX_CLIP_MS, result.durationMs + CLIP_TAIL_MS + CLIP_PREROLL_MS)) ?? null;
      } catch {
        audio = null;
      }
      judgedIds.current.add(result.attemptId); // sent to the backend coach, so it counts for the recap
      try {
        const resp = await requestWordCoach({ result, profileId, practiceZoneIds: practice, audio }, ctl.signal);
        caption = resp.caption;
        focus = resp.focusZoneId ?? null;
        cueId = resp.cueId;
        side = resp.showSideView;
        if (resp.word) score = { ...score, verdict: resp.word.verdict, zoneCount: resp.word.zoneCount };
      } catch {
        // Backend unreachable: the same line its deterministic fallback would give.
        const fb = wordFallbackLine(word, result, practice);
        caption = fb.caption;
        focus = fb.focusZoneId;
        side = focus !== null;
      }
      if (runId.current !== my) return null;
      // "close" with zoneCount 0 means nothing countable was practised (a liquid-only or cue-only part): not a score.
      const verdict = score.verdict === 'insufficient' ? 'insufficient' : isScored(score) ? score.verdict : 'unscored';
      coachCache.current.set(result.attemptId, { caption, focusZoneId: focus, verdict });
      lastCoachId.current = result.attemptId;
      setFocusZoneId(focus);
      return { prog, finalStep, caption, focus, cueId: cueId ?? (side ? zoneDemoCue(focus) : null), side, verdict };
    },
    [profileId],
  );

  /**
   * Between attempts: Ava has the floor with the mic open (VAD on) and the board listens at the same time, but only
   * measures: its results are held and Ava's learner_attempt tool call (talkEvents.attempt) decides whether one counts.
   * The board is live while Ava is silent (plus ECHO_SETTLE_MS), no decision is running and no relay is pending, and
   * re-arms with a fresh attempt id. A pending relay (a coached learner_attempt) is finished here once Ava has spoken:
   * the lesson then finishes the word, advances, or stays in the window. Also ends on start_practice, the CTA, or when the
   * session is lost. The board's unit is the current step's, so an attempt in the window is scored against that part.
   */
  const talkWindow = useCallback(
    async (my: number) => {
      const a = avaRef.current;
      const w = win.current;
      startPracticeSignal.current = false;
      Object.assign(w, { active: true, run: my, results: [], deciding: false, pending: null });
      setTalking(true);
      let live = false;
      let viaPractice = false;
      let lastSpokeAt = Date.now();
      while (runId.current === my) {
        if (!avaOpen()) break;
        if (startPracticeSignal.current) {
          viaPractice = true;
          break;
        }
        const p = w.pending;
        if (p) {
          // Ava relays the coaching the tool call returned; the board stays off until she is done.
          const viewStart = await p.view;
          if (runId.current !== my) return;
          const until = Date.now() + AVA_START_MS;
          while (a.speechCount() === p.before && avaOpen() && Date.now() < until) {
            await sleep(100);
            if (runId.current !== my) return;
          }
          const spoken = a.speechCount() !== p.before;
          if (spoken) {
            await a.waitForIdle(AVA_IDLE_MS);
            if (runId.current !== my) return;
            if (viewStart && p.cueId) {
              const left = CUE_MIN_MS - (Date.now() - viewStart);
              if (left > 0) await sleep(left);
              if (runId.current !== my) return;
            }
            quietAva(); // stops lip sync, clears the cue flag and returns the avatar to the front view
          } else {
            // She never started: the script speaks the caption itself.
            floor.current = 'script';
            quietAva(false);
            avaView.current = false;
            await a.setPracticeMode(true).catch(() => undefined);
            if (runId.current !== my) return;
            if (!(await line(p.caption, p.side, p.cueId))) return;
          }
          if (p.next === 'final') {
            endWindow();
            return wordDone(spoken);
          }
          if (p.next === 'advance') {
            endWindow();
            setFocusZoneId(null);
            if (!spoken && p.gentle && !(await line(LINES.moveOn))) return;
            return runStep(my);
          }
          // Try again: back to listening (the scripted fallback gave the floor away; hand it back to Ava).
          if (!spoken) {
            floor.current = 'ava';
            await a.setPracticeMode(false).catch(() => undefined);
            if (runId.current !== my) return;
          }
          w.pending = null;
          w.deciding = false;
          w.results = [];
          lastSpokeAt = Date.now();
          live = false;
          windowLiveRef.current = false;
          setWindowLive(false);
          continue;
        }
        if (a.speakingNow()) lastSpokeAt = Date.now();
        let want: boolean = live;
        if (w.deciding || a.speakingNow() || Date.now() - lastSpokeAt < ECHO_SETTLE_MS) want = false; // deciding, or Ava is talking / just did
        else if (!live) {
          want = await a.waitForIdle(0); // re-arm only once Ava is fully idle
          if (runId.current !== my) return;
          if (w.deciding || w.pending) want = false;
        }
        if (want !== live) {
          live = want;
          if (live) newAttempt(); // always a fresh attempt id when the board goes live again
          windowLiveRef.current = live;
          setWindowLive(live);
        }
        await sleep(TALK_POLL_MS);
      }
      if (runId.current !== my) return;
      if (viaPractice) {
        await a.waitForIdle(START_PRACTICE_IDLE_MS); // let her finish the sentence she is on
        if (runId.current !== my) return;
      }
      endWindow();
      await beginTurn(my, false);
    },
    [avaOpen, beginTurn, endWindow, line, newAttempt, quietAva, runStep, wordDone],
  );

  /**
   * The board's second opinion: for a phone-judged word, cut the attempt's clip, score the unit's phones and replace
   * the unit's zone verdicts. Any problem (no tap, offline service, timeout) returns the formant result unchanged.
   */
  const judgeAttempt = useCallback(async (result: WordAttemptResult): Promise<WordAttemptResult> => {
    judgedAt.current = { attemptId: result.attemptId, at: Date.now() };
    judgedIds.current.add(result.attemptId);
    try {
      const { spec: word, plan } = cur.current;
      const step = plan[shownStep.current];
      if (!step || result.word !== word.word || (result.quality !== 'usable' && !canPhoneRescue(result))) return result;
      const zones = unitPhoneZones(word.word, step.unit);
      if (zones.length === 0) return result;
      const want = result.durationMs + CLIP_TAIL_MS + CLIP_PREROLL_MS;
      const clip = attemptTap.current?.clip(judgedAt.current.at, Math.min(MAX_CLIP_MS, canPhoneRescue(result) ? Math.max(want, RESCUE_MIN_CLIP_MS) : want)) ?? null;
      if (!clip) return result;
      const resp = await scorePhones(clip, zones.map((z) => z.phone));
      if (!resp) return result;
      return applyPhoneJudgement(result, step.unit, resp, clipOffsetMs(clip.durationMs, result, ASSUMED_END_LAG_MS));
    } catch {
      return result;
    }
  }, []);

  /** One finished attempt: coach it (filler, backend coach, then Ava relays or the script speaks) and progress. */
  const runAttempt = useCallback(
    async (result: WordAttemptResult, endedAt: number = Date.now()) => {
      const { spec: word, plan: steps } = cur.current;
      const step = steps[shownStep.current];
      if (!step || !step.practisable) return;
      const my = ++runId.current;
      endWindow();
      setPhase('thinking');
      let gate: Promise<void> = Promise.resolve();
      const coached = await coachResult(result, step, my, () => {
        // The script owns the floor from here: Ava is silenced and gated (VAD off, mic disabled) before the filler speaks.
        takeFloor();
        const session = avaRef.current.session();
        if (realtimeActive() && session && !session.practiceMode) gate = avaRef.current.setPracticeMode(true);
        const filler = pickFiller(lastFiller.current);
        lastFiller.current = filler;
        void seq.say(filler, { narration: voiceOnRef.current });
        // Ava's history gets what was said on her behalf (no response), so she does not repeat it.
        if (realtimeActive()) avaRef.current.sendAppMessage(`You said "${filler}" while you looked at the try.`, false);
      }, endedAt);
      if (!coached) return;
      const { prog, finalStep, caption, focus, cueId, side, verdict } = coached;
      setPhase('coaching');

      /** After the line: move on to the next step / the end of the word, or try the same step again. */
      const afterScript = async () => {
        if (prog.advance) {
          if (prog.gentle && !finalStep) {
            if (!(await line(LINES.moveOn))) return;
          }
          await sleep(PAUSE_AFTER_WATCH_MS);
          if (runId.current !== my) return;
          if (finalStep) return wordDone(false);
          return runStep(my);
        }
        await sleep(PAUSE_BEFORE_AGAIN_MS);
        if (runId.current !== my) return;
        await goLive(LINES.again);
      };

      if (realtimeActive()) {
        await gate;
        if (runId.current !== my) return;
        if (!(await giveFloorToAva(my))) return; // the filler finishes first, then Ava takes over (never two voices)
        const instructions = finalStep ? finalInstructions(word.word) : prog.advance ? (prog.gentle ? GENTLE_INSTRUCTIONS : ADVANCE_INSTRUCTIONS) : undefined;
        const outcome = await coachWithAva({ caption, focus, cueId, side, attemptId: result.attemptId, verdict, instructions }, my);
        if (outcome === 'aborted') return;
        if (outcome === 'spoken') {
          if (finalStep) {
            await wordDone(true);
          } else if (prog.advance) {
            setFocusZoneId(null);
            await runStep(my);
          } else {
            await talkWindow(my);
          }
          return;
        }
        // 'fallback': Ava is silenced and gated, the script has the floor; speak the line the scripted way below.
      }
      if (!(await line(caption, side, cueId))) return;
      await afterScript();
    },
    [coachResult, coachWithAva, endWindow, giveFloorToAva, goLive, line, realtimeActive, runStep, seq.say, setPhase, takeFloor, talkWindow, wordDone],
  );

  // ---- talk window: the board measures, Ava decides (learner_attempt scores a held result; anything else drops them)

  talkEvents.current = {
    attempt: async () => {
      const w = win.current;
      const my = w.run;
      const alive = () => w.active && runId.current === my;
      const gone = { measured: false, instructions: 'Say nothing more about it.' };
      if (!alive() || w.deciding || w.pending) return gone;
      const recent = () => w.results.filter((r) => r.at >= Date.now() - ATTEMPT_LOOKBACK_MS);
      // The board ends an attempt shortly after the voice stops, so it may still be on its way (it stays live meanwhile).
      const until = Date.now() + ATTEMPT_WAIT_MS;
      while (recent().length === 0 && Date.now() < until) {
        await sleep(TALK_POLL_MS);
        if (!alive()) return gone;
      }
      w.deciding = true; // the board goes non-live while this is scored
      const fresh = recent();
      w.results = [];
      const step = cur.current.plan[shownStep.current];
      if (fresh.length === 0 || !step || !step.practisable) {
        w.deciding = false;
        return LEARNER_ATTEMPT_UNMEASURED;
      }
      const pick = [...fresh].reverse().find((r) => r.result.quality === 'usable') ?? fresh[fresh.length - 1];
      const coached = await coachResult(pick.result, step, my, undefined, pick.at);
      if (!coached || !alive()) return gone;
      const { prog, finalStep, caption, focus, cueId, side, verdict } = coached;
      const instructions = finalStep
        ? finalInstructions(cur.current.spec.word)
        : prog.advance
          ? prog.gentle
            ? GENTLE_INSTRUCTIONS
            : ADVANCE_INSTRUCTIONS
          : RESULT_INSTRUCTIONS;
      w.pending = {
        next: finalStep ? 'final' : prog.advance ? 'advance' : 'again',
        gentle: prog.advance && prog.gentle,
        caption,
        side,
        cueId,
        focus,
        before: avaRef.current.speechCount(),
        view: startView(side, cueId, my, caption),
      };
      return { measured: true, caption, focusZoneId: focus, verdict, instructions };
    },
    // Ava called think_it_through: what the learner said was talk. Small talk needs no clearing (held results age out after
    // ATTEMPT_LOOKBACK_MS and the newest one is used). Not while she is relaying a learner_attempt.
    talk: () => {
      const w = win.current;
      if (!w.active || w.deciding || w.pending) return;
      w.results = [];
    },
    quiet: () => {
      const w = win.current;
      if (w.active) w.results = [];
    },
  };

  /** Board result: a normal attempt end while live, or a measurement the talk window holds until Ava decides. */
  const onAttemptEnd = (result: WordAttemptResult) => {
    if (result.attemptId !== attemptIdRef.current) return;
    // A judged result arrives after scoring; the coach clip must still end where the attempt ended.
    const endedAt = judgedAt.current?.attemptId === result.attemptId ? judgedAt.current.at : Date.now();
    if (phaseRef.current === 'live') {
      void runAttempt(result, endedAt).catch(() => undefined);
      return;
    }
    const w = win.current;
    // Not gated on windowLiveRef: a result can land just after the board went idle (Ava's acknowledgement started);
    // the attempt id check above already drops stale ones.
    if (!w.active || w.deciding || w.pending || runId.current !== w.run) return;
    w.results = [...w.results, { result, at: endedAt }].slice(-MAX_HELD);
    newAttempt(); // the board keeps listening for the next utterance
  };

  // Hands-free start: once the microphone is open, begin by itself if the browser already had a tap
  // (the intro and quiz provide one); otherwise wait for Begin so Ava's voice can play.
  const micReady = mic.status === 'ready' || mic.status === 'recording';
  const blocked = mic.status === 'denied' || mic.status === 'unsupported';
  useEffect(() => {
    if (phase !== 'setup' || !micReady) return;
    const activated = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive;
    if (activated) void startLesson().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micReady, phase]);

  // Before the lesson starts the caption explains what will happen (or why it cannot).
  useEffect(() => {
    if (phase !== 'setup') return;
    if (mic.status === 'denied') narration.show('I need the microphone to see your voice. Allow it in the site settings, then reload.');
    else if (mic.status === 'unsupported') narration.show('This browser cannot share a microphone. Try a recent Chrome, Edge or Safari.');
    else
      narration.show(
        `${learner ? '' : 'First a quick voice check. '}Then we'll work on the word ${spec.word}, one part at a time. Press Begin when you're ready.`,
      );
  }, [phase, mic.status, narration.show, spec.word, learner]);

  /**
   * "Replay side view": play the latest side-view line again with Ava's audio (narration forced on, since it is an
   * explicit request). An open talk window is closed first so the replay is never scored as an attempt, and reopened after;
   * the realtime mic is gated while it plays. The button only shows in phases where nothing else is running.
   */
  const replaySide = useCallback(async (opts?: { slow?: boolean; line?: SequenceLine }) => {
    const l = opts?.line ?? lastSide.current;
    const ph = phaseRef.current;
    if (!l || replayingRef.current || ph === 'thinking' || (ph === 'live' && spokeRef.current)) return; // never during a real attempt
    const w = win.current;
    if (w.active && (w.pending || w.deciding)) return; // a relay is in flight
    const wasTalking = ph === 'coaching' && w.active;
    const wasLive = ph === 'live'; // waiting for the learner to start: close the unstarted attempt, replay, then reopen it
    const prevPractice = !!avaRef.current.session()?.practiceMode;
    const prevFloor = floor.current;
    const my = wasTalking || wasLive ? ++runId.current : runId.current;
    if (opts?.line) rememberSide(opts.line);
    replayingRef.current = true;
    setReplaying(true);
    try {
      if (wasTalking) endWindow();
      if (wasLive) setPhase('cue'); // board idle: nothing is scored and progress/tries are untouched; stale results are ignored (phase is not 'live')
      takeFloor(true); // silences realtime Ava and returns her view to the front
      await gateAva(my); // mic gated so the replay audio never reaches her
      if (opts?.slow) setMouthSlow(true); // the mouth plays at half speed; her voice at 0.8
      await seq.speakLine(l, opts?.slow ? { narration: true, speed: 0.8 } : { narration: true });
    } catch {
      /* presentation only */
    } finally {
      replayingRef.current = false;
      setReplaying(false);
      setMouthSlow(false);
      if (mounted.current && runId.current === my) {
        quietAva(true);
        if (wasLive) {
          await goLive(LINES.yourTurn); // short cue, then a fresh attempt on the same step
        } else if (wasTalking) {
          floor.current = 'ava';
          await avaRef.current.setPracticeMode(false).catch(() => undefined);
          if (mounted.current && runId.current === my) void talkWindow(my).catch(() => undefined);
        } else {
          floor.current = prevFloor;
          if (realtimeActive() && !prevPractice) await avaRef.current.setPracticeMode(false).catch(() => undefined);
        }
      }
    }
  }, [endWindow, gateAva, goLive, quietAva, realtimeActive, rememberSide, seq.speakLine, setPhase, takeFloor, talkWindow]);

  async function finish() {
    stopRun();
    quietAva();
    ava.disconnect();
    completeOnboarding();
    // Start (or reuse) the recap; wait briefly for its id, otherwise go home as before.
    const recap = await Promise.race([startRecapOnce(), new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
    navigate(recap ? `/recap/${encodeURIComponent(recap.recapId)}` : '/');
  }

  /**
   * Ava's tools. Both refuse during a try (same conditions as replaySide) and before the lesson has started, and otherwise
   * start the same function the matching button calls, returning right after the start. Her preamble has already played.
   */
  const tryInProgress = () => {
    const ph = phaseRef.current;
    const w = win.current;
    return ph === 'thinking' || (ph === 'live' && spokeRef.current) || (w.active && (w.pending !== null || w.deciding));
  };
  const BUSY: ActionResult = { ok: false, reason: 'busy_with_a_try', instructions: 'Say you will do it right after this try.' };
  const NOT_STARTED: ActionResult = { ok: false, reason: 'not_started', instructions: 'Say the lesson has not started yet.' };
  const refresh = () => {
    if (mounted.current) sendScreen();
  };
  actionEvents.current = {
    demo: async (what, speed) => {
      const ph = phaseRef.current;
      if (ph === 'setup' || ph === 'voice') return NOT_STARTED;
      if (tryInProgress()) return BUSY;
      if (replayingRef.current) return { ok: false, reason: 'already_playing', instructions: 'Say you will show it again in a moment.' };
      const slow = speed === 'slow';
      if (what === 'ghost_path') {
        if (ph === 'done') return { ok: false, reason: 'word_done', instructions: 'Say this word is done; offer the next word or finishing.' };
        const st = cur.current.plan[shownStep.current];
        if (!st) return ACTION_UNAVAILABLE;
        void watchAgain(slow ? st.speedWatch * 0.5 : st.speedWatch).catch(() => undefined).finally(refresh);
        return { ok: true };
      }
      if (!demoPhaseOk(ph)) {
        return { ok: false, reason: 'not_now', instructions: 'Say you can show that in a moment, after this part has been shown.' };
      }
      const last = lastSide.current;
      let line: SequenceLine | undefined;
      if (what === 'mouth_cue') {
        const choice = mouthCueChoice();
        if (!choice) {
          return { ok: false, reason: 'no_mouth_cue', instructions: 'Say this sound is felt more than seen, and offer the side view instead.' };
        }
        line = choice.line;
      } else if (!last) {
        return { ok: false, reason: 'nothing_to_replay', instructions: 'Say there is no side view to replay yet.' };
      }
      void replaySide({ slow, line }).catch(() => undefined).finally(refresh);
      return { ok: true };
    },
    control: async (action) => {
      const ph = phaseRef.current;
      if (ph === 'setup' || ph === 'voice') return NOT_STARTED;
      if (tryInProgress()) return BUSY;
      const st = cur.current.plan[shownStep.current];
      const done = ph === 'done';
      const wordDoneResult: ActionResult = { ok: false, reason: 'word_done', instructions: 'Say this word is done; offer the next word or finishing.' };
      switch (action) {
        case 'next_part':
          if (done) return wordDoneResult;
          void nextPart().catch(() => undefined).finally(refresh);
          return { ok: true };
        case 'repeat_part':
          if (done) return wordDoneResult;
          void watchAgain().catch(() => undefined).finally(refresh);
          return { ok: true };
        case 'try_now':
          if (done) return wordDoneResult;
          if (!st?.practisable) return { ok: false, reason: 'watch_only_step', instructions: 'Say this part is for watching and feeling, then offer the next part.' };
          if (ph === 'live') return { ok: false, reason: 'already_your_turn', instructions: 'Say it is already their turn.' };
          void skipToTurn().catch(() => undefined).finally(refresh);
          return { ok: true };
        case 'next_word': {
          const next = WORD_KEYS[WORD_KEYS.indexOf(cur.current.spec.word) + 1];
          if (!done || !next) {
            return { ok: false, reason: 'word_not_done', instructions: 'Say you can move to the next word once this one is done.' };
          }
          switchWord(next);
          return { ok: true };
        }
        case 'finish':
          if (!done) return { ok: false, reason: 'word_not_done', instructions: 'Say you can finish once this word is done.' };
          setTimeout(() => { if (mounted.current) finish(); }, 400); // after the tool result has been submitted
          return { ok: true };
      }
    },
  };

  function leave() {
    stopRun();
    quietAva();
    ava.disconnect();
    navigate('/');
  }

  // Track whether the learner has started the current attempt (first voiced or burst frame), so Replay can hide then.
  useEffect(() => {
    spokeRef.current = false;
    setSpoke(false);
    if (phase !== 'live') return;
    return voice.subscribe((f) => {
      if (spokeRef.current || !(f.voiced || f.burst)) return;
      spokeRef.current = true;
      setSpoke(true);
    });
  }, [phase, attemptId, voice.subscribe]);

  const step = plan[Math.min(stepIdx, plan.length - 1)];
  const nextWord = WORD_KEYS[WORD_KEYS.indexOf(spec.word) + 1] ?? null;
  const boardMode = phase === 'watch' ? 'watch' : phase === 'live' || (phase === 'coaching' && talking && windowLive) ? 'live' : 'idle';
  // Phone-judged words: the live cursor follows the phone recognizer (reset per live attempt); falls back to F1/F2 when offline.
  const phoneCursor = usePhoneCursor(mic.stream, isPhoneJudged(spec.word) && micReady && phase !== 'setup', boardMode === 'live' ? attemptId : null);
  const lipFrame = camera && lip.status === 'tracking' ? lip.latest : null;
  const micWarning =
    mic.status === 'denied' ? 'Microphone blocked · allow it in site settings' : mic.status === 'unsupported' ? 'Microphone unsupported in this browser' : null;
  // While realtime Ava speaks, her sentence is the caption; otherwise the scripted line's.
  const avaTalking = realtimeOn && ava.speaking && !!ava.caption;
  const captionText = avaTalking ? ava.caption : seq.caption;
  const showTeacherCaption = captions && !!captionText && phase !== 'setup';

  // Replay is offered only while nothing is recording or being scored: after coaching (talk window open), at the end of
  // the word, or on an idle watch-only part. Never during 'live' or 'thinking'.
  const canReplay = hasSide && ((phase === 'live' && !spoke) || phase === 'done' || (phase === 'coaching' && talking) || (phase === 'cue' && !step.practisable));

  const where = stepLabel(plan, stepIdx);
  const ask = step.kind === 'part' ? partPrompt(spec, step.unit) : { label: spec.word, lead: '', tail: null, spoken: `Say ${spec.word}.` };
  const statusText =
    phase === 'voice'
      ? 'Voice check'
      : phase === 'coaching' && talking
        ? `Say ${ask.lead}“${step.unit.label}”${ask.tail ?? ''}, or ask Ava a question`
        : phase === 'live'
          ? `Your turn · ${where}`
          : phase === 'done'
            ? `${cap(spec.word)} complete`
            : phase === 'setup'
              ? null
              : tries > 0
                ? `${where} · try ${tries + 1} of ${MAX_TRIES}`
                : where;

  let cta;
  if (phase === 'setup') {
    cta = (
      <button type="button" className="ob-cta" onClick={() => void startLesson().catch(() => undefined)} disabled={!micReady}>
        <Mic size={18} aria-hidden="true" />
        {mic.status === 'requesting' ? 'Starting…' : 'Begin'}
      </button>
    );
  } else if (phase === 'voice') {
    cta = null;
  } else if (phase === 'done') {
    cta = nextWord ? (
      <div className="wl-ctas">
        <button type="button" className="ob-text-btn" onClick={finish}>
          Finish
        </button>
        <button type="button" className="ob-cta" onClick={() => switchWord(nextWord)}>
          Next word: {nextWord}
          <ArrowRight size={18} aria-hidden="true" />
        </button>
      </div>
    ) : (
      <button type="button" className="ob-cta" onClick={finish}>
        Finish
        <ArrowRight size={18} aria-hidden="true" />
      </button>
    );
  } else {
    cta = (
      <div className="wl-ctas">
        <button type="button" className="ob-text-btn" onClick={() => void watchAgain().catch(() => undefined)}>
          <Eye size={16} aria-hidden="true" />
          Watch again
        </button>
        {step.practisable && (
          <button type="button" className="ob-text-btn" onClick={() => void nextPart().catch(() => undefined)}>
            <SkipForward size={16} aria-hidden="true" />
            Next part
          </button>
        )}
        {step.practisable ? (
          <button type="button" className="ob-cta" onClick={() => void skipToTurn().catch(() => undefined)} disabled={phase === 'live'}>
            <RotateCcw size={18} aria-hidden="true" />
            {tries > 0 ? 'Try again' : 'My turn'}
          </button>
        ) : (
          <button type="button" className="ob-cta" onClick={() => void nextPart().catch(() => undefined)}>
            Next part
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  }

  return (
    <OnboardingFrame
      step={1}
      total={1}
      progressLabel="Lesson progress"
      bar="none"
      stageKey="lesson"
      className="lp wl ob-content--full"
      // Ava's words get their own row under the stage, so they never cover the side cutaway or the board.
      caption={
        <div className="wl-caption">
          {showTeacherCaption ? (
            <div className="cap" role="status" aria-live="polite">
              <span className="cap-icon" aria-hidden="true">
                <Captions size={16} />
              </span>
              <TeacherCaptions className="cap-text" speech={avaTalking ? ava.speech : seq.speech} text={captionText!} />
            </div>
          ) : (
            <CaptionBar text={phase === 'setup' ? narration.caption : null} />
          )}
        </div>
      }
      footer={
        <>
          <div className="lp-meter wl-status" aria-live="polite">
            {micWarning ? (
              <span className="ob-status ob-status--warn" role="alert">
                <TriangleAlert size={16} aria-hidden="true" /> {micWarning}
              </span>
            ) : (
              statusText && <span className="wl-status-text">{statusText}</span>
            )}
          </div>
          {cta}
        </>
      }
    >
      <div className="lp-head">
        <button type="button" className="ob-icon-btn" aria-label="Leave lesson" title="Leave lesson" onClick={leave}>
          <X size={22} aria-hidden="true" />
        </button>
        <StepHeading
          title={
            <>
              Say {ask.lead}
              <span className="navy">“{step.kind === 'part' ? step.unit.label : spec.word}”</span>
              {ask.tail}
            </>
          }
        />
        <Segmented<string>
          className="wl-words"
          label="Practice word"
          value={wordKey}
          onChange={switchWord}
          options={WORD_KEYS.map((key) => ({ id: key, label: key }))}
        />
        {phase !== 'setup' && phase !== 'voice' && (
          <button type="button" className="ob-text-btn wl-redo" onClick={redoVoice}>
            Redo voice check
          </button>
        )}
        <AccessToggles />
      </div>

      <div className="lp-stage wl-stage" data-phase={phase}>
        <section className="lp-pane wl-guide" aria-label="Ava">
          <MouthReference ref={mouthRef} cue={null} slow={mouthSlow} />
          <div className="lp-overlay lp-overlay--tl lp-pills">
            <span className={`lp-pill wl-pill ${blocked ? 'is-warn' : ''}`} role="status">
              {blocked ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
              {micLabel(mic.status, voice.status)}
            </span>
            <button
              type="button"
              className="lp-pill wl-pill"
              aria-pressed={camera}
              onClick={() => setCamera(!camera)}
              title={camera ? 'Turn the camera off' : 'Turn the camera on to see your lips on the board'}
            >
              {camera ? <Video size={16} aria-hidden="true" /> : <VideoOff size={16} aria-hidden="true" />}
              {camera ? (lip.status === 'off' ? 'Starting camera…' : LIP_LABEL[lip.status]) : 'Camera off'}
            </button>
            {voiceFallback && (
              <span className="lp-pill wl-pill is-warn" role="status">
                <TriangleAlert size={16} aria-hidden="true" />
                Browser voice · Cartesia unavailable
              </span>
            )}
            {canReplay && (
              <button
                type="button"
                className="lp-pill wl-pill wl-replay"
                onClick={() => void replaySide().catch(() => undefined)}
                disabled={replaying || seq.running || avaTalking}
                title="Watch Ava's side-view mouth demo again"
              >
                <RotateCcw size={16} aria-hidden="true" />
                Replay side view
              </button>
            )}
            {realtimeOn && (
              <span className="lp-pill wl-pill" role="status">
                <MessageCircle size={16} aria-hidden="true" />
                Live conversation
              </span>
            )}
          </div>
        </section>
        <section className="lp-pane wl-board" aria-label={`The word ${spec.word}`}>
          {phase === 'voice' ? (
            <VoiceCheck frames={voice} ready={micReady && voiceListening} onDone={voiceDone} />
          ) : (
            <GhostBoard
              spec={spec}
              model={model}
              learnerFactor={learnerFactor}
              targets={targets}
              unit={step.unit}
              mode={boardMode}
              speed={watchSpeed ?? step.speedWatch}
              frames={voice}
              lip={lipFrame}
              attemptId={attemptId}
              onWatchEnd={() => watchDone.current?.()}
              onAttemptEnd={onAttemptEnd}
              judge={isPhoneJudged(spec.word) ? judgeAttempt : undefined}
              phoneCursor={isPhoneJudged(spec.word) ? phoneCursor : undefined}
              focusZoneId={focusZoneId}
            />
          )}
        </section>
        <FormantDebug frames={voice} voice={learner} />
        {/* Lip tracking needs a playing video element; the board shows the lips as the cursor ring. */}
        {camera && (
          <div className="sd-offscreen" aria-hidden="true">
            <CameraTile enabled onVideoElement={setVideoEl} lipStatus={lip.status} />
          </div>
        )}
      </div>
    </OnboardingFrame>
  );
}
