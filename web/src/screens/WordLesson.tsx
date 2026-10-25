import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Captions, Eye, MessageCircle, Mic, MicOff, RotateCcw, SkipForward, TriangleAlert, Video, VideoOff, X } from 'lucide-react';
import { CaptionBar, readingTime, useNarration } from '../components/Narration';
import { AccessToggles, OnboardingFrame, Segmented, StepHeading } from '../components/Onboarding';
import { CameraTile } from '../components/practice';
import { GhostBoard } from '../components/GhostBoard';
import { MouthReference, type MouthReferenceHandle } from '../components/MouthReference';
import { TeacherCaptions } from '../components/TeacherCaptions';
import { readStoredVoice, type StoredVoice } from '../components/VoiceCheck';
import { onTeacherFallback, prepareTeacher, unlockTeacherAudio } from '../audio/teacher';
import { ACTION_UNAVAILABLE, useAvaRealtime, type ActionResult, type AvaCoaching, type DemoKind, type DemoSpeed, type LessonAction } from '../realtime/useAvaRealtime';
import { screenStateMessage, type ScreenState } from '../realtime/screenState';
import { pickFiller } from '../realtime/fillers';
import { pickPraise } from '../audio/praise';
import { useMicrophone, type MicStatus } from '../audio/useMicrophone';
import { MAX_CLIP_MS, useAttemptAudio, type AttemptAudio } from '../audio/attemptAudio';
import { useVoiceFrames, type VoiceFrames } from '../audio/useVoiceFrames';
import { useLipTracking, type LipTrackingStatus } from '../vision/useLipTracking';
import { useCoachSequence, type SequenceLine } from '../live/useCoachSequence';
import type { MouthCueId } from '@mouth-demo/src/mouth-demo.js';
import { stepPronounce, unitDemoCue, zoneDemoCue, type PartPronounce } from '../game/ghost/demoCues';
import type { PartSound } from '../game/ghost/partSounds';
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
 * Word lesson (ghost paths): the learner picks one of four words, and Ava coaches
 * the word one part at a time. The ghost board is the live visual; Ava, the 3D model and cues are the advice.
 *
 *   plan  = lessonPlan(word): each part on its own, then the whole word twice
 *   step  = intro line -> board watches the ghost -> (if practisable) live attempt -> coach -> progression
 *
 * Phases:
 *   setup    -> waiting for the microphone (and a tap, if the browser has not had one yet)
 *   intro    -> Ava introduces the step (side view / cue for a part)
 *   watch    -> the board plays the ghost for the step's unit
 *   cue      -> "Your turn" / "Again when you're ready."
 *   live     -> the board is scoring the learner
 *   thinking -> attempt sent to the coach; a short filler line plays
 *   coaching -> Ava says the coach's line
 *   ready    -> after a try that did not pass: the board stays idle until the learner asks for the next try (button or voice)
 *
 * "Give feedback" toggle (realtime): the only way the learner talks to Ava. While it is on the mic is open to her and the board
 * is OFF (nothing is measured or scored); questions, replays and show_demo work as usual. Off by default, forced off before
 * any try. The next try starts only on the Try again / My turn button, try_now, or Ava's learner_attempt in 'ready'.
 *   done     -> "That's the word. Nice work." and the next word / Finish
 *
 * Cue-only steps (a lone sh or n) are watch-only: they never go live. Progression is nextStep() in plan.ts.
 */
type Phase = 'setup' | 'intro' | 'watch' | 'cue' | 'live' | 'thinking' | 'coaching' | 'ready' | 'done';

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

/** Extra time past a watch's own length before the lesson stops waiting for the board's onWatchEnd. */
const WATCH_SLACK_MS = 2500;
const PAUSE_AFTER_WATCH_MS = 500;
/** Draw time for a part sound's ghost path when the clip's length is unknown. */
const DEFAULT_SOUND_MS = 650;

const LINES = {
  yourTurn: 'Your turn.',
  ready: `Try again when you're ready.`,
  moveOn: `Let's move on. We'll come back to it.`,
  doneWord: (word: string) => `That's ${word}. Nice work.`,
};

/** Ava's scripted introduction of one step, spoken in front view (the part's sound is pronounced right after it). */
function introLine(spec: GhostWordSpec, step: LessonStep): string {
  const { label, zoneIds } = step.unit;
  if (step.kind === 'part') {
    if (!step.practisable) {
      const hint = spec.zones.find((z) => zoneIds.includes(z.id))?.hint ?? 'Watch the side view.';
      return `The ${label} is one to feel more than see. ${hint}`;
    }
    return `Let's work on the ${label} in ${spec.word}. Watch the path.`;
  }
  return step.speedWatch < 1 ? `Now the whole word, slowly: ${spec.word}.` : `And at normal speed: ${spec.word}.`;
}

/** Realtime Ava: how long to wait for her first sentence, for her to finish, and for start_practice to wait for her. */
const AVA_START_MS = 5000;
const AVA_IDLE_MS = 25_000;
const START_PRACTICE_IDLE_MS = 10_000;
/** Ready state: how often the wait loop checks for a lost session or a start_practice. */
const TALK_POLL_MS = 120;
/** Attempt audio for the coach: the board reports 600 ms after the last voiced frame and durationMs stops at that
 *  frame, so the clip reaches back over that tail plus a short pre-roll before the first voiced frame. */
const CLIP_TAIL_MS = 600;
const CLIP_PREROLL_MS = 250;

/** Sent when a try did not pass and the board goes idle: the learner decides when to try again. */
const READY_MESSAGE =
  '[app] The try did not pass. The board is not listening now and the learner can take their time. ' +
  'You hear the learner only while their "Give feedback" switch is on; the board records only when they press Try again or you call lesson_control try_now. ' +
  'If they ask a question or want it explained, answer; to show the part again use show_demo or lesson_control repeat_part. ' +
  'When they say they want to try, call lesson_control try_now. ' +
  'Never say where their tongue, lips or jaw were.';
/** Sent when the learner turns "Give feedback" on: she may talk with them now. */
const FEEDBACK_ON_MESSAGE =
  '[app] The learner turned on "Give feedback" and can talk to you now. Stay silent until they speak. ' +
  'The board records only when they press Try again or you call lesson_control try_now: when they say they want to try, call try_now. ' +
  'Never say where their tongue, lips or jaw were.';
const FEEDBACK_OFF_MESSAGE = '[app] The learner turned "Give feedback" off. You cannot hear them now. Stay silent.';
const lessonContext =(word: string) =>
  `[app] Lesson context: the practice word is "${word}". The lesson goes one part of the word at a time, then joins the parts back into the whole word. ` +
  'The app runs the lesson and the ghost board measures every try. ' +
  'You hear the learner only while their "Give feedback" switch is on. ' +
  'Stay silent until the app sends you your notes on a try or the learner speaks to you.';
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
const READY_INSTRUCTIONS =
  'These are your own notes on the try. Say them in your own words, as yourself, in one or two short sentences. Keep their meaning and direction. ' +
  'Do not add numbers, anatomy or new instructions. ' +
  'End by inviting them to tell you when they are ready, or to ask you to show it again. Do not ask them to say it now.';
const GENTLE_INSTRUCTIONS =
  'These are your own notes on the try. Say them in your own words, as yourself, in one short sentence. Keep their meaning. ' +
  `Then say gently that you will move on and come back to it. Do not call it a pass. ` +
  'Do not add numbers or anatomy beyond the notes.';
const finalInstructions = (word: string) =>
  'These are your own notes on the try. Say them in your own words, as yourself, in one or two short sentences. Keep their meaning. ' +
  `The word is complete: end with "That's ${word}. Nice work." Give brief, restrained praise and do not invite another try. ` +
  'Do not add numbers or anatomy beyond the notes.';

/** The ready-state window (realtime): Ava listens with the board off. `run` is the run it belongs to. */
interface TalkWindow {
  active: boolean;
  run: number;
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
  /** A clean pass: the app praises and moves on; no coaching line is waited for (the request is only persisted). */
  fast: boolean;
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
  // The learner's voice size, if one is already stored (read silently; no voice check is run here).
  const [learner] = useState<StoredVoice | null>(() => readStoredVoice());
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

  const [phase, setPhaseState] = useState<Phase>('setup');
  const phaseRef = useRef<Phase>('setup');
  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);
  // The ghost board's sound-synced draw (demoRun changes each time Ava says a part sound) and its pass state.
  const [demoRun, setDemoRun] = useState(0);
  const [demoMs, setDemoMs] = useState(DEFAULT_SOUND_MS);
  const [boardSuccess, setBoardSuccess] = useState(false);
  const mouthSlowRef = useRef(false);
  const onSound = useCallback((_sound: PartSound, durationMs: number | null) => {
    setDemoMs((durationMs ?? DEFAULT_SOUND_MS) * (mouthSlowRef.current ? 2 : 1)); // a slowed side view draws the line as slowly
    setDemoRun((n) => n + 1);
  }, []);
  const [attemptId, setAttemptIdState] = useState(() => crypto.randomUUID());
  const attemptIdRef = useRef(attemptId);
  const newAttempt = useCallback(() => {
    const id = crypto.randomUUID();
    attemptIdRef.current = id;
    setAttemptIdState(id);
    setBoardSuccess(false);
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
  const win = useRef<TalkWindow>({ active: false, run: 0 });
  // Late-bound handlers for the talk window (assigned each render below), so the hook options stay stable.
  const talkEvents = useRef<{ attempt: () => Promise<unknown> }>({
    attempt: async () => ({ measured: false }),
  });
  const startPracticeSignal = useRef(false);
  // "Give feedback" toggle: ON = the mic is open to realtime Ava. Never records an attempt. Every path into 'live' forces it off.
  const feedbackRef = useRef(false);
  const [feedback, setFeedbackState] = useState(false);
  const setFeedback = useCallback((v: boolean) => {
    feedbackRef.current = v;
    setFeedbackState(v);
  }, []);
  const talkSeq = useRef(0); // the newest talk window wins
  // The "ready when you are" state after a try that did not pass (assigned below, after the talk window it opens).
  const enterReady = useRef<(my: number) => Promise<void>>(async () => undefined);
  const avaLipStop = useRef<(() => void) | null>(null);
  const avaCue = useRef(false); // a cue owns the mouth, so no lip sync
  const avaView = useRef(false); // the realtime path moved the avatar to the side view
  const lastSide = useRef<SequenceLine | null>(null); // the latest line that played a side-view demo, for "Replay side view"
  const replayingRef = useRef(false);
  const [replaying, setReplaying] = useState(false);
  const [mouthSlow, setMouthSlowState] = useState(false); // slow-motion demo: the 3D mouth plays at half speed
  const setMouthSlow = useCallback((v: boolean) => {
    mouthSlowRef.current = v;
    setMouthSlowState(v);
  }, []);
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
    keepGated: () => !feedbackRef.current, // Ava never hears the learner unless "Give feedback" is on
    onLearnerAttempt: () => talkEvents.current.attempt(),
    onShowDemo: (what, speed) => actionEvents.current.demo(what, speed),
    onLessonControl: (action) => actionEvents.current.control(action),
    askCoach: async (question) => {
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
    Object.assign(win.current, { active: false });
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

  /** Open the mic to Ava (VAD on). Only the feedback toggle, or its restore after a replay, may call this. */
  const openAva = useCallback(async () => {
    avaRef.current.session()?.setPlaybackMute(false);
    await avaRef.current.setPracticeMode(false).catch(() => undefined);
  }, []);

  /** Close the outgoing mic track at once without cutting off a reply Ava is already giving (the full gate cancels it). */
  const muteAva = useCallback(() => {
    avaRef.current.session()?.setPlaybackMute(true);
  }, []);

  // The realtime session is gone: the toggle has nothing to talk to.
  useEffect(() => {
    if (!realtimeOn && feedbackRef.current) setFeedback(false);
  }, [realtimeOn, setFeedback]);

  /** Remember the latest line that showed the side view, so the learner can replay it. */
  const rememberSide = useCallback((l: SequenceLine) => {
    lastSide.current = l;
    setHasSide(true);
  }, []);

  /** Whether a demo of the side view / mouth cue may play in this phase (the phases where the Replay button shows, plus 'thinking' for the guard). */
  const demoPhaseOk = useCallback((ph: Phase): boolean => {
    if (ph === 'live' || ph === 'done' || ph === 'coaching' || ph === 'ready' || ph === 'thinking') return true;
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
    const st = cur.current.plan[shownStep.current];
    const cueId = stepCue();
    if (cueId && st) {
      const pr = stepPronounce(cur.current.spec, st.unit, null);
      return { line: { text: `Watch my mouth for the ${st.unit.label}.`, cueId, showSideView: true, sound: pr?.sound ?? null } };
    }
    return last?.cueId ? { line: undefined } : null;
  }, [stepCue]);

  /** What the learner sees and what Ava may do now. Capabilities are structural (phase, step, word); a try in flight is answered by the tool guards. */
  const screenState = useCallback((): ScreenState => {
    const { spec: word, plan: steps } = cur.current;
    const ph = phaseRef.current;
    const idx = Math.min(shownStep.current, steps.length - 1);
    const st = steps[idx];
    const started = ph !== 'setup';
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
    async (text: string, side = false, cueId: MouthCueId | null = null, pr: PartPronounce | null = null): Promise<boolean> => {
      const my = runId.current;
      const started = Date.now();
      takeFloor();
      // The line itself is always spoken in front view; a part sound (pr) is pronounced in side view right after it.
      const sl: SequenceLine = { text, cueId: pr ? pr.cueId : cueId, showSideView: side, sound: pr?.sound ?? null };
      if (side && sl.cueId) rememberSide(sl);
      await seq.speakLine(sl, { narration: voiceOnRef.current });
      if (runId.current !== my) return false;
      if (!voiceOnRef.current) {
        const left = readingTime(text) - (Date.now() - started);
        if (left > 0) await sleep(left);
      }
      return runId.current === my;
    },
    [rememberSide, seq.speakLine, takeFloor],
  );

  /**
   * Pronounce one part sound (side view only while it plays). Realtime Ava's mic is gated while it plays so the sound never
   * reaches her, and restored after if this call gated it. False if superseded.
   */
  const pronounceStep = useCallback(
    async (pr: PartPronounce, reps: number, my: number, slow = false): Promise<boolean> => {
      if (pr.cueId) rememberSide({ text: pr.sound.caption, cueId: pr.cueId, showSideView: true, sound: pr.sound });
      const session = avaRef.current.session();
      const gated = realtimeActive() && !!session && !session.practiceMode;
      if (gated) await avaRef.current.setPracticeMode(true).catch(() => undefined);
      if (runId.current !== my) return false;
      avaView.current = pr.cueId !== null;
      if (slow) setMouthSlow(true); // the side view and the line draw both play at half speed
      try {
        await seq.pronounce({ cueId: pr.cueId, sound: pr.sound, reps, onSound }, { narration: voiceOnRef.current });
      } finally {
        avaView.current = false;
        if (slow) setMouthSlow(false);
      }
      if (gated && feedbackRef.current && runId.current === my) await openAva(); // only back to Ava if the toggle is on
      return runId.current === my;
    },
    [onSound, openAva, realtimeActive, rememberSide, seq.pronounce, setMouthSlow],
  );

  /** The pronunciation for a coaching line that used the side view: the current part's sound, or for a whole-word step the focus part's. */
  const coachPronounce = useCallback((focus: string | null, side: boolean): PartPronounce | null => {
    if (!side) return null;
    const st = cur.current.plan[shownStep.current];
    return st ? stepPronounce(cur.current.spec, st.unit, focus) : null;
  }, []);

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
    if (step && phaseRef.current !== 'setup' && phaseRef.current !== 'done') a.sendAppMessage(stepMessage(word, step), false);
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
      const my = runId.current;
      setFeedback(false); // the board and the Ava channel are never open together
      setPhase('cue');
      if (!(await gateAva(my))) return;
      if (!(await line(text))) return;
      newAttempt();
      setPhase('live');
      sendScreen();
    },
    [gateAva, line, newAttempt, sendScreen, setFeedback, setPhase],
  );

  /** A scripted-style turn: the script has the floor, Ava is silenced and gated, the board goes live with a fresh attempt. */
  const beginTurn = useCallback(
    async (my: number, resetView: boolean) => {
      if (!cur.current.plan[shownStep.current]?.practisable) return; // cue-only steps never go live
      setFeedback(false);
      takeFloor(resetView);
      if (realtimeActive()) {
        await avaRef.current.setPracticeMode(true); // gate the mic before the board goes live
        if (runId.current !== my) return;
      }
      newAttempt();
      setPhase('live');
    },
    [newAttempt, realtimeActive, setFeedback, setPhase, takeFloor],
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
  /** After a gentle advance's feedback: a short pause, then move on. False if superseded. (Clean passes never get here: they take the fast path.) */
  const holdAfterAdvance = useCallback(async (my: number, pauseMs: number = PAUSE_AFTER_WATCH_MS): Promise<boolean> => {
    await sleep(pauseMs);
    return runId.current === my;
  }, []);

  /** The word is finished: Ava says so (unless her relay already did) and offers the next word. */
  const wordDone = useCallback(
    async (viaAva: boolean) => {
      const word = cur.current.spec.word;
      setFocusZoneId(null);
      if (!viaAva) {
        if (!(await line(LINES.doneWord(word)))) return;
      }
      setPhase('done'); // when Ava relayed the last coaching she keeps the floor; the learner chats only with "Give feedback" on
      setFeedback(false);
      await gateAva(runId.current); // her relay left the mic open: close it until the toggle is pressed
      if (realtimeActive()) {
        const at = WORD_KEYS.indexOf(word);
        avaRef.current.sendAppMessage(wordDoneMessage(word, WORD_KEYS[at + 1] ?? null), false);
        sendScreen();
      }
    },
    [gateAva, line, realtimeActive, sendScreen, setFeedback, setPhase],
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
      setBoardSuccess(false);
      setTries(progress.current.tries);
      setFocusZoneId(null);
      lastResult.current = null;
      lastCoachId.current = null;
      endWindow();
      setWatchSpeed(null);
      setFeedback(false); // each step starts with Ava not listening
      takeFloor(true);
      setPhase('intro');
      if (!(await gateAva(my))) return;
      if (realtimeActive()) {
        avaRef.current.sendAppMessage(stepMessage(word, step), false);
        sendScreen();
      }
      if (!(await line(introLine(word, step)))) return;
      const pr = step.kind === 'part' ? stepPronounce(word, step.unit, null) : null;
      if (pr && !(await pronounceStep(pr, 2, my))) return;
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
    [endWindow, gateAva, goLive, line, newAttempt, pronounceStep, realtimeActive, sendScreen, setFeedback, setPhase, setWatchSpeed, takeFloor, waitWatch, wordDone],
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
      setFeedback(false);
      if (realtimeActive()) {
        quietAva(true);
        avaRef.current.sendAppMessage(lessonContext(cur.current.spec.word), false);
      }
      await runStep(my);
    },
    [endWindow, quietAva, realtimeActive, releaseWatch, runStep, seq.cancel, setFeedback],
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
    if (runId.current !== my) return;
    await startWord(cur.current.key);
  }, [connectAva, endWindow, narration.show, startWord]);

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

  /**
   * "Watch again": the part's tongue side view with Ava saying the sound and the line drawing, twice, then the ghost watch.
   * `slow` halves the side view, the line draw and the ghost watch. Then back to where the learner was: the ready state if
   * they were in it, else (practisable steps) their turn.
   */
  const watchAgain = useCallback(async (slow = false) => {
    const wasReady = phaseRef.current === 'ready';
    const my = ++runId.current;
    coachAbort.current?.abort();
    releaseWatch();
    seq.cancel();
    endWindow();
    const step = cur.current.plan[shownStep.current];
    if (!step) return;
    setFocusZoneId(null);
    setWatchSpeed(slow ? step.speedWatch * 0.5 : null); // Ava's slow-motion demo; the button passes nothing
    takeFloor(true);
    if (!(await gateAva(my))) return;
    newAttempt();
    const pr = step.kind === 'part' ? stepPronounce(cur.current.spec, step.unit, null) : null;
    if (pr) {
      setPhase('intro'); // board idle while Ava says the sound (the sound must not reach the board)
      if (!(await pronounceStep(pr, 2, my, slow))) return;
    }
    setPhase('watch');
    await waitWatch(step);
    if (runId.current !== my) return;
    setWatchSpeed(null);
    if (wasReady && step.practisable) await enterReady.current(my);
    else if (step.practisable) await beginTurn(my, false);
    else {
      setPhase('cue'); // watch-only: the learner moves on with "Next part"
      sendScreen();
      if (feedbackRef.current && realtimeActive()) {
        floor.current = 'ava';
        await openAva(); // the toggle was on before the replay: back to Ava
      }
    }
  }, [beginTurn, endWindow, gateAva, newAttempt, openAva, pronounceStep, realtimeActive, releaseWatch, sendScreen, seq.cancel, setPhase, setWatchSpeed, takeFloor, waitWatch]);

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
      if (phaseRef.current === 'setup') {
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

  /** Note the coaching line's demo for the screen state / replay. The head stays in front view; the part sound is pronounced after the relay. */
  const startView = useCallback(async (side: boolean, cueId: MouthCueId | null, my: number, text = ''): Promise<number> => {
    avaCue.current = false;
    avaCueId.current = null;
    if (side && cueId && text && runId.current === my) rememberSide({ text, cueId, showSideView: true });
    sendScreen();
    return 0;
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
      // relayResult keeps the mic closed while the toggle is off (keepGated); she can still speak her reply.
      try {
        await a.relayResult({ caption: p.caption, focusZoneId: p.focus, verdict: p.verdict }, p.attemptId, p.instructions);
      } catch {
        relayed = false;
      }
      await viewP;
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
      quietAva(); // stops lip sync and clears the cue flag
      const pr = coachPronounce(p.focus, p.side);
      if (pr && !(await pronounceStep(pr, 1, my))) return 'aborted';
      return 'spoken';
    },
    [avaOpen, coachPronounce, pronounceStep, quietAva, startView],
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
      const fast = prog.advance && !prog.gentle;
      if (fast) setBoardSuccess(true); // the check shows during the praise (runStep clears it)
      // Best effort and synchronous: audio must never delay or break coaching.
      let audio: AttemptAudio | null = null;
      try {
        audio = attemptTap.current?.clip(endedAt, Math.min(MAX_CLIP_MS, result.durationMs + CLIP_TAIL_MS + CLIP_PREROLL_MS)) ?? null;
      } catch {
        audio = null;
      }
      judgedIds.current.add(result.attemptId); // sent to the backend coach below (both paths), so it counts for the recap
      if (fast) {
        // A pass needs no coaching line: persist the turn (history, memory) in the background and ignore the response.
        coachAbort.current?.abort();
        coachAbort.current = null;
        requestWordCoach({ result, profileId, practiceZoneIds: practice, audio }, new AbortController().signal).catch(() => undefined);
        return { prog, finalStep, caption: '', focus: null, cueId: null, side: false, verdict: 'pass', fast: true };
      }
      onStart?.();

      coachAbort.current?.abort();
      const ctl = new AbortController();
      coachAbort.current = ctl;
      let caption: string;
      let focus: string | null;
      let cueId: MouthCueId | null = null;
      let side: boolean;
      let score = scoreWord(result, practice);
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
      return { prog, finalStep, caption, focus, cueId: cueId ?? (side ? zoneDemoCue(focus) : null), side, verdict, fast: false };
    },
    [profileId],
  );

  /**
   * The 'ready' wait (realtime, only while "Give feedback" is on): Ava has the floor with the mic open and the board stays OFF, so nothing is measured
   * or scored. The learner can ask questions or for a replay; the next try starts through try_now / the button / Ava's
   * learner_attempt (all of which bump the run), or here on start_practice (once she has finished her sentence). If the
   * session is lost the lesson simply stays ready (the button still works).
   */
  const talkWindow = useCallback(
    async (my: number) => {
      const a = avaRef.current;
      const seqNo = ++talkSeq.current;
      startPracticeSignal.current = false;
      Object.assign(win.current, { active: true, run: my });
      // Ends on a lost session, a new run, the toggle going off (endWindow) or a newer window.
      while (runId.current === my && talkSeq.current === seqNo && win.current.active && avaOpen() && !startPracticeSignal.current) await sleep(TALK_POLL_MS);
      if (runId.current !== my || talkSeq.current !== seqNo) return;
      endWindow();
      if (!startPracticeSignal.current) return;
      await a.waitForIdle(START_PRACTICE_IDLE_MS); // let her finish the sentence she is on
      if (runId.current !== my) return;
      await beginTurn(my, false);
    },
    [avaOpen, beginTurn, endWindow],
  );

  // Ready state after a try that did not pass: board idle, the learner decides when to try again. Realtime Ava listens.
  enterReady.current = async (my) => {
    setPhase('ready');
    if (!realtimeActive()) return;
    avaRef.current.sendAppMessage(READY_MESSAGE, false);
    sendScreen();
    if (!feedbackRef.current) {
      // Ava does not hear the learner until "Give feedback" is pressed: close the mic her feedback relay left open.
      floor.current = 'script';
      await gateAva(my);
      return;
    }
    // The toggle was on before a replay: back to Ava with the talk window open.
    floor.current = 'ava';
    await openAva();
    if (runId.current !== my) return;
    await talkWindow(my);
  };

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
      const { prog, finalStep, caption, focus, cueId, side, verdict, fast } = coached;
      if (fast) {
        // Fast pass: one short praise line (none on the last part: wordDone's line is the praise) and straight on. No filler,
        // no wait for the coaching request, no relay, no hold.
        takeFloor();
        if (realtimeActive()) {
          const session = avaRef.current.session();
          if (session && !session.practiceMode) await avaRef.current.setPracticeMode(true); // she must not talk over the praise
          if (runId.current !== my) return;
        }
        const praise = finalStep ? null : pickPraise();
        if (realtimeActive()) {
          avaRef.current.sendAppMessage(
            finalStep
              ? "The learner's try passed; the app moved on to the end of the word. Say nothing."
              : `The learner's try passed; the app said "${praise}" and moved to the next part. Say nothing.`,
            false,
          );
        }
        setFocusZoneId(null);
        if (praise && !(await line(praise))) return;
        if (runId.current !== my) return;
        if (finalStep) return wordDone(false);
        return runStep(my);
      }
      setPhase('coaching');

      /** After the line: move on to the next step / the end of the word, or try the same step again. */
      const afterScript = async () => {
        if (prog.advance) {
          if (prog.gentle && !finalStep) {
            if (!(await line(LINES.moveOn))) return;
          }
          if (!(await holdAfterAdvance(my))) return;
          if (finalStep) return wordDone(false);
          return runStep(my);
        }
        // Not passed: no automatic re-arm. The board waits idle until the learner asks for the next try.
        setPhase('ready');
        if (!(await line(LINES.ready))) return;
        await enterReady.current(my);
      };

      if (realtimeActive()) {
        await gate;
        if (runId.current !== my) return;
        if (!(await giveFloorToAva(my))) return; // the filler finishes first, then Ava takes over (never two voices)
        const instructions = finalStep ? finalInstructions(word.word) : prog.advance ? (prog.gentle ? GENTLE_INSTRUCTIONS : ADVANCE_INSTRUCTIONS) : READY_INSTRUCTIONS;
        const outcome = await coachWithAva({ caption, focus, cueId, side, attemptId: result.attemptId, verdict, instructions }, my);
        if (outcome === 'aborted') return;
        if (outcome === 'spoken') {
          if (finalStep) {
            if (!(await holdAfterAdvance(my, 0))) return;
            await wordDone(true);
          } else if (prog.advance) {
            setFocusZoneId(null);
            await runStep(my);
          } else {
            await enterReady.current(my);
          }
          return;
        }
        // 'fallback': Ava is silenced and gated, the script has the floor; speak the line the scripted way below.
      }
      if (!(await line(caption, side, cueId, coachPronounce(focus, side)))) return;
      await afterScript();
    },
    [coachPronounce, coachResult, coachWithAva, endWindow, giveFloorToAva, holdAfterAdvance, line, realtimeActive, runStep, seq.say, setPhase, takeFloor, wordDone],
  );

  // ---- ready state: the board is off, so Ava's learner_attempt means the learner wants to try

  talkEvents.current = {
    attempt: async () => {
      const w = win.current;
      const my = w.run;
      const out = { measured: false, instructions: 'The board is not listening and the app starts their turn now. Say nothing more.' };
      if (!w.active || runId.current !== my || phaseRef.current !== 'ready') return { measured: false, instructions: 'Say nothing more about it.' };
      // The toggle goes off now, and the track is muted before the tool wrapper reopens the mic for her reply.
      setFeedback(false);
      muteAva();
      // After the tool result has been submitted: one short "Your turn." from the script, then the board goes live.
      setTimeout(() => {
        if (!mounted.current || runId.current !== my || phaseRef.current !== 'ready') {
          if (mounted.current && !feedbackRef.current) void gateAva(runId.current).catch(() => undefined);
          return;
        }
        const run = ++runId.current;
        coachAbort.current?.abort();
        releaseWatch();
        seq.cancel();
        endWindow();
        void gateAva(run)
          .then((ok) => (ok ? goLive(LINES.yourTurn) : undefined))
          .catch(() => undefined)
          .finally(refresh);
      }, 300);
      return out;
    },
  };

  /** Board result: only a live attempt counts (the ready state has the board off). */
  const onAttemptEnd = (result: WordAttemptResult) => {
    if (result.attemptId !== attemptIdRef.current) return;
    // A judged result arrives after scoring; the coach clip must still end where the attempt ended.
    const endedAt = judgedAt.current?.attemptId === result.attemptId ? judgedAt.current.at : Date.now();
    if (phaseRef.current === 'live') void runAttempt(result, endedAt).catch(() => undefined);
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
        `We'll work on the word ${spec.word}, one part at a time. Press Begin when you're ready.`,
      );
  }, [phase, mic.status, narration.show, spec.word, learner]);

  /**
   * "Replay side view": play the latest side-view line again with Ava's audio (narration forced on, since it is an
   * explicit request). From the ready state the talk window is closed first and the ready state is restored after;
   * the realtime mic is gated while it plays. The button only shows in phases where nothing else is running.
   */
  const replaySide = useCallback(async (opts?: { slow?: boolean; line?: SequenceLine }) => {
    const l = opts?.line ?? lastSide.current;
    const ph = phaseRef.current;
    if (!l || replayingRef.current || ph === 'thinking' || (ph === 'live' && spokeRef.current)) return; // never during a real attempt
    const wasReady = ph === 'ready'; // the board is already off; replay, then back to waiting for the learner
    const wasLive = ph === 'live'; // waiting for the learner to start: close the unstarted attempt, replay, then reopen it
    const prevFloor = floor.current;
    const my = wasReady || wasLive ? ++runId.current : runId.current;
    if (opts?.line) rememberSide(opts.line);
    replayingRef.current = true;
    setReplaying(true);
    try {
      if (wasReady) endWindow();
      if (wasLive) setPhase('cue'); // board idle: nothing is scored and progress/tries are untouched; stale results are ignored (phase is not 'live')
      takeFloor(true); // silences realtime Ava and returns her view to the front
      await gateAva(my); // mic gated so the replay audio never reaches her
      if (opts?.slow) setMouthSlow(true); // the mouth plays at half speed (and the line draw); her voice at 0.8
      // A line without a sound still shows the tongue view when the current part has one.
      const st = cur.current.plan[shownStep.current];
      const stepPr = st?.kind === 'part' ? stepPronounce(cur.current.spec, st.unit, null) : null;
      const pron = l.sound && l.cueId ? { cueId: l.cueId, sound: l.sound } : stepPr;
      if (pron) {
        // The replay is the part's pronunciation (side view only while it plays); baked clips only play at normal speed.
        avaView.current = true;
        try {
          await seq.pronounce({ cueId: pron.cueId, sound: pron.sound, reps: 2, onSound }, { narration: true });
        } finally {
          avaView.current = false;
        }
      } else {
        await seq.speakLine(l, opts?.slow ? { narration: true, speed: 0.8 } : { narration: true });
      }
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
        } else if (wasReady) {
          await enterReady.current(my);
        } else {
          floor.current = prevFloor;
          if (realtimeActive() && feedbackRef.current) await openAva(); // the toggle was on: back to Ava; otherwise she stays gated
        }
      }
    }
  }, [endWindow, gateAva, goLive, onSound, openAva, quietAva, realtimeActive, rememberSide, seq.pronounce, seq.speakLine, setMouthSlow, setPhase, takeFloor]);

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
    return ph === 'thinking' || (ph === 'live' && spokeRef.current);
  };
  const BUSY: ActionResult = { ok: false, reason: 'busy_with_a_try', instructions: 'Say you will do it right after this try.' };
  const NOT_STARTED: ActionResult = { ok: false, reason: 'not_started', instructions: 'Say the lesson has not started yet.' };
  const refresh = () => {
    if (mounted.current) sendScreen();
  };
  actionEvents.current = {
    demo: async (what, speed) => {
      const ph = phaseRef.current;
      if (ph === 'setup') return NOT_STARTED;
      if (tryInProgress()) return BUSY;
      if (replayingRef.current) return { ok: false, reason: 'already_playing', instructions: 'Say you will show it again in a moment.' };
      const slow = speed === 'slow';
      if (what === 'ghost_path') {
        if (ph === 'done') return { ok: false, reason: 'word_done', instructions: 'Say this word is done; offer the next word or finishing.' };
        const st = cur.current.plan[shownStep.current];
        if (!st) return ACTION_UNAVAILABLE;
        void watchAgain(slow).catch(() => undefined).finally(refresh);
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
      if (ph === 'setup') return NOT_STARTED;
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

  /** Phases where the toggle is offered: not before the lesson, not while the board records or an attempt is being coached. */
  const feedbackPhaseOk = (ph: Phase) => ph !== 'setup' && ph !== 'live' && ph !== 'thinking' && ph !== 'coaching';

  /**
   * "Give feedback" toggle. ON: the learner talks to realtime Ava (floor to her, mic open); it never records or scores an
   * attempt. A scripted line that is playing is allowed to finish; in the middle of a step's intro/watch/cue the step is
   * stopped (like "Watch again" does) and the lesson waits in the idle 'ready' state, so the script cannot talk over her.
   * OFF: the mic track is muted at once, a reply she is already giving finishes, then the mic is gated from her.
   */
  const toggleFeedback = async () => {
    if (!realtimeActive() || !feedbackPhaseOk(phaseRef.current) || replayingRef.current) return;
    if (feedbackRef.current) {
      setFeedback(false);
      muteAva();
      endWindow();
      avaRef.current.sendAppMessage(FEEDBACK_OFF_MESSAGE, false);
      await avaRef.current.waitForIdle(AVA_IDLE_MS);
      if (!mounted.current || feedbackRef.current) return; // turned on again meanwhile
      floor.current = 'script';
      await gateAva(runId.current);
      return;
    }
    const ph = phaseRef.current;
    setFeedback(true);
    let my = runId.current;
    const st = cur.current.plan[shownStep.current];
    const midStep = ph === 'intro' || ph === 'watch' || ph === 'cue';
    if (midStep) {
      my = ++runId.current; // stops the step's flow; its pending awaits see the new run and end
      coachAbort.current?.abort();
      releaseWatch();
      endWindow();
      setWatchSpeed(null);
    }
    if (!(await giveFloorToAva(my)) || !feedbackRef.current) return;
    avaRef.current.sendAppMessage(FEEDBACK_ON_MESSAGE, false);
    if (midStep && st?.practisable) {
      await enterReady.current(my); // idle 'ready' with the mic open (the toggle is on), talk window started
    } else {
      if (midStep) setPhase('cue'); // watch-only step: "Next part" moves on
      await openAva();
      if (runId.current !== my) return;
      if (phaseRef.current === 'ready') void talkWindow(my).catch(() => undefined);
      sendScreen();
    }
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
  const boardMode = phase === 'watch' ? 'watch' : phase === 'live' ? 'live' : 'idle';
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
  const canReplay = hasSide && ((phase === 'live' && !spoke) || phase === 'done' || phase === 'ready' || (phase === 'cue' && !step.practisable));

  const where = stepLabel(plan, stepIdx);
  const ask = step.kind === 'part' ? partPrompt(spec, step.unit) : { label: spec.word, lead: '', tail: null, spoken: `Say ${spec.word}.` };
  const statusText =
    phase === 'ready'
      ? `${where} · ready when you are`
      : phase === 'live'
        ? `Your turn · ${where}`
        : phase === 'done'
          ? `${cap(spec.word)} complete`
          : phase === 'setup'
            ? null
            : tries > 0
              ? `${where} · try ${tries + 1} of ${MAX_TRIES}`
              : where;

  // "Give feedback": talk to Ava with the board off (hidden when her live voice is not connected).
  const feedbackBtn = realtimeOn && (
    <button
      type="button"
      className="ob-text-btn wl-feedback"
      aria-pressed={feedback}
      onClick={() => void toggleFeedback().catch(() => undefined)}
      disabled={!feedbackPhaseOk(phase) || replaying}
      title={feedback ? 'Ava can hear you. Tap to stop talking to her.' : 'Talk to Ava: ask a question or ask her to show it again. Nothing is recorded.'}
    >
      {feedback ? <span className="wl-feedback-dot" aria-hidden="true" /> : <MessageCircle size={16} aria-hidden="true" />}
      {feedback ? 'Listening… tap to stop' : 'Give feedback'}
    </button>
  );

  let cta;
  if (phase === 'setup') {
    cta = (
      <button type="button" className="ob-cta" onClick={() => void startLesson().catch(() => undefined)} disabled={!micReady}>
        <Mic size={18} aria-hidden="true" />
        {mic.status === 'requesting' ? 'Starting…' : 'Begin'}
      </button>
    );
  } else if (phase === 'done') {
    cta = nextWord ? (
      <div className="wl-ctas">
        {feedbackBtn}
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
        {feedbackBtn}
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
            demoRun={demoRun}
            demoMs={demoMs}
            success={boardSuccess}
          />
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
