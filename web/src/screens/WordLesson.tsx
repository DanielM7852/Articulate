import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Captions, MessageCircle, Mic, MicOff, RotateCcw, TriangleAlert, Video, VideoOff, X } from 'lucide-react';
import { CaptionBar, readingTime, useNarration } from '../components/Narration';
import { AccessToggles, OnboardingFrame, StepHeading } from '../components/Onboarding';
import { CameraTile } from '../components/practice';
import { MouthReference, type MouthReferenceHandle } from '../components/MouthReference';
import { TeacherCaptions } from '../components/TeacherCaptions';
import { WordBoard } from '../components/WordBoard';
import { prepareTeacher, unlockTeacherAudio } from '../audio/teacher';
import { useAvaRealtime, type AvaCoaching } from '../realtime/useAvaRealtime';
import { useMicrophone, type MicStatus } from '../audio/useMicrophone';
import { useVoiceFrames, type VoiceFrames } from '../audio/useVoiceFrames';
import { useLipTracking, type LipTrackingStatus } from '../vision/useLipTracking';
import { CUE_MIN_MS, useCoachSequence } from '../live/useCoachSequence';
import type { CueId } from '../live/liveCoach';
import { requestWordAsk, requestWordCoach, scoreWord, wordFallbackLine } from '../live/wordCoach';
import { TRACK } from '../game/words';
import type { WordAttemptResult } from '../game/types';
import { useAppState } from '../state/AppState';
import { learnerProfileId } from '../state/learnerId';
import '../conversation/director/director.css';
import '../styles/word-lesson.css';

/**
 * Word lesson: Ava shows the word "track", then the learner says it while the board scores each part.
 * The loop is hands-free: Ava's line, then the board goes live; the board ends the attempt on its own,
 * the coach picks one part to work on, Ava says one line (turning to the side cutaway for tongue sounds),
 * and the board goes live again. Three tries, or every part landing, ends the lesson.
 *
 *   setup    -> waiting for the microphone (and a tap, if the browser has not had one yet)
 *   intro    -> "Let's say the word track. Watch me first."
 *   demo     -> board plays the zone sequence while Ava says the word in the side view
 *   cue      -> "Your turn" / "Again when you're ready."
 *   live     -> the board is scoring the learner
 *   thinking -> attempt sent to the coach; a short filler line plays
 *   coaching -> Ava says the coach's line
 *   done     -> "That's the word. Nice work." and Finish
 */
type Phase = 'setup' | 'intro' | 'demo' | 'cue' | 'live' | 'thinking' | 'coaching' | 'done';

const SPEC = TRACK;
const MAX_ATTEMPTS = 3;
/** The board's demo plays the zone sequence; keep demo mode at least this long. */
const DEMO_MIN_MS = Math.max(2500, SPEC.paceMs + 1000);
const PAUSE_BEFORE_AGAIN_MS = 1000;

const LINES = {
  intro: `Let's say the word ${SPEC.word}. Watch me first.`,
  demo: `${SPEC.word[0].toUpperCase()}${SPEC.word.slice(1)}.`,
  yourTurn: `Your turn. Say ${SPEC.word}.`,
  again: `Again when you're ready.`,
  filler: 'Let me look…',
  done: `That's the word. Nice work.`,
};

/** Realtime Ava: how long to wait for her first sentence, for her to finish, and for start_practice to wait for her. */
const AVA_START_MS = 5000;
const AVA_IDLE_MS = 25_000;
const START_PRACTICE_IDLE_MS = 10_000;
/** Talk window: how long a finished board result waits for Ava to say whether it was an attempt or talk (and how long
 *  a learner_attempt waits for the board's result). */
const ATTEMPT_DECIDE_MS = 3000;
const TALK_POLL_MS = 120;
/** A transcript with at most this many words and no question mark counts as an attempt when Ava did not decide. */
const ATTEMPT_MAX_WORDS = 3;

const LESSON_CONTEXT =
  `[app] Lesson context: the practice word is "${SPEC.word}". The app runs the lesson and the board measures every try. ` +
  'Stay silent until the app sends you a coaching result or the learner speaks to you between tries.';
const DONE_MESSAGE =
  '[app] The lesson is complete and the board is off. If the learner tries the word again, tell them the lesson is done and they can press Finish.';
const MISSED_MESSAGE =
  '[app] The board did not catch that try; nothing was measured. Briefly ask the learner to say the word again.';

/** The talk window between attempts: the board listens and Ava hears the learner at the same time. */
interface TalkWindow {
  active: boolean;
  run: number;
  /** Ava called learner_attempt for the current utterance. */
  attemptCalled: boolean;
  /** Ava started talking (a sentence started or ask_coach was called) for the current utterance. */
  talked: boolean;
  held: WordAttemptResult | null;
  decideTimer: ReturnType<typeof setTimeout> | null;
  missTimer: ReturnType<typeof setTimeout> | null;
}

/** Per-turn instructions for the last coaching relay (appended to Ava's persona, never replacing it). */
const FINAL_INSTRUCTIONS =
  'Relay this caption to the learner in your own words, in one or two short sentences. Keep its meaning. ' +
  'The lesson is complete: give brief, restrained praise and do not invite another try. ' +
  'Do not add numbers or anatomy beyond the caption.';

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

export default function WordLesson() {
  const navigate = useNavigate();
  const mic = useMicrophone();
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
  const [tries, setTries] = useState(0);
  const triesRef = useRef(0);

  // Every async step checks this token; leaving, skipping or a new run bumps it.
  const runId = useRef(0);
  const coachAbort = useRef<AbortController | null>(null);
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;

  // Realtime Ava (OpenAI writes the coaching line, Cartesia speaks it). Every use is gated on realtimeActive(),
  // so with no key / a failed connect / narration off the lesson is exactly the scripted one.
  const coachCache = useRef(new Map<string, AvaCoaching>());
  const lastCoachId = useRef<string | null>(null);
  const lastResult = useRef<WordAttemptResult | null>(null);
  const lastTranscript = useRef<string | null>(null);
  // Who may speak through Cartesia: the scripted sequence or realtime Ava, never both (Ava's canSpeak reads this).
  const floor = useRef<'script' | 'ava'>('script');
  const win = useRef<TalkWindow>({ active: false, run: 0, attemptCalled: false, talked: false, held: null, decideTimer: null, missTimer: null });
  const windowLiveRef = useRef(false);
  const [windowLive, setWindowLive] = useState(false);
  // Late-bound handlers for the talk window (assigned each render below), so the hook options stay stable.
  const talkEvents = useRef<{ attempt: () => void; talk: () => void }>({ attempt: () => undefined, talk: () => undefined });
  const startPracticeSignal = useRef(false);
  const avaLipStop = useRef<(() => void) | null>(null);
  const avaCue = useRef(false); // a cue owns the mouth, so no lip sync
  const avaView = useRef(false); // the realtime path moved the avatar to the side view
  const mounted = useRef(true);
  const [talking, setTalking] = useState(false);
  const ava = useAvaRealtime({
    getCoaching: async (id) => {
      const hit = coachCache.current.get(id === 'latest' ? (lastCoachId.current ?? '') : id);
      if (!hit) throw new Error('No coaching for that attempt.');
      return hit;
    },
    onStartPractice: () => {
      startPracticeSignal.current = true;
    },
    canSpeak: () => floor.current === 'ava',
    onLearnerSpeech: () => {
      lastTranscript.current = null; // a new utterance: the previous transcript no longer describes it
    },
    onUserTranscript: (text) => {
      lastTranscript.current = text;
    },
    onLearnerAttempt: () => talkEvents.current.attempt(),
    askCoach: async (question) => {
      talkEvents.current.talk(); // Ava is about to answer: this utterance was talk
      const cached = lastCoachId.current ? coachCache.current.get(lastCoachId.current) : undefined;
      const score = lastResult.current ? scoreWord(lastResult.current) : null;
      const resp = await requestWordAsk(
        {
          profileId,
          word: SPEC.word,
          question,
          lastCoaching: cached ? { caption: cached.caption, focusZoneId: cached.focusZoneId } : null,
          lastAttempt: score
            ? { verdict: score.verdict, hitCount: score.hitCount, zoneCount: score.zoneCount, weakestZoneId: score.weakestZoneId }
            : null,
          tries: triesRef.current,
        },
        AbortSignal.timeout(10_000),
      );
      return { say: resp.say };
    },
    onSpeech: (sp) => {
      talkEvents.current.talk(); // a sentence started: whatever the learner just said is being answered
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
    if (resetView && avaView.current) {
      avaView.current = false;
      const av = mouthRef.current;
      if (av?.ready) {
        av.stop();
        void av.setView('front').catch(() => undefined);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      runId.current++;
      coachAbort.current?.abort();
      if (win.current.decideTimer) clearTimeout(win.current.decideTimer);
      if (win.current.missTimer) clearTimeout(win.current.missTimer);
      win.current.active = false;
    };
  }, []);

  /** Close the talk window: the board and Ava stop deciding, timers cleared. Safe to call at any time. */
  const endWindow = useCallback(() => {
    const w = win.current;
    if (w.decideTimer) clearTimeout(w.decideTimer);
    if (w.missTimer) clearTimeout(w.missTimer);
    Object.assign(w, { active: false, attemptCalled: false, talked: false, held: null, decideTimer: null, missTimer: null });
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

  /** One Ava line. With narration off the caption stays up for its reading time. False if superseded. */
  const line = useCallback(
    async (text: string, side = false, cueId: CueId | null = null): Promise<boolean> => {
      const my = runId.current;
      const started = Date.now();
      takeFloor();
      await seq.speakLine({ text, cueId, showSideView: side }, { narration: voiceOnRef.current });
      if (runId.current !== my) return false;
      if (!voiceOnRef.current) {
        const left = readingTime(text) - (Date.now() - started);
        if (left > 0) await sleep(left);
      }
      return runId.current === my;
    },
    [seq.speakLine, takeFloor],
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
    a.sendAppMessage(LESSON_CONTEXT, false);
  }, []);

  /** Ava's cue, then the board goes live with a fresh attempt id. */
  const goLive = useCallback(
    async (text: string) => {
      setPhase('cue');
      if (!(await line(text))) return;
      newAttempt();
      setPhase('live');
    },
    [line, newAttempt, setPhase],
  );

  const startLesson = useCallback(async () => {
    const my = ++runId.current;
    coachAbort.current?.abort();
    prepareTeacher();
    void unlockTeacherAudio();
    narration.show(null);
    floor.current = 'script';
    endWindow();
    triesRef.current = 0;
    setTries(0);
    setFocusZoneId(null);
    setPhase('intro');
    if (voiceOnRef.current) void connectAva(); // user gesture; the intro does not wait for it
    if (!(await line(LINES.intro))) return;
    setPhase('demo');
    const demoStart = Date.now();
    // Side cutaway while Ava says the word; the board plays the zone sequence alongside.
    if (!(await line(LINES.demo, true))) return;
    const left = DEMO_MIN_MS - (Date.now() - demoStart);
    if (left > 0) await sleep(left);
    if (runId.current !== my) return;
    await goLive(LINES.yourTurn);
  }, [connectAva, endWindow, goLive, line, narration.show, setPhase]);

  /** A scripted-style turn: the script has the floor, Ava is silenced and gated, the board goes live with a fresh attempt. */
  const beginTurn = useCallback(
    async (my: number, resetView: boolean) => {
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

  /** Mouse path: skip whatever Ava is saying and start a new attempt now. */
  const skipToTurn = useCallback(async () => {
    const my = ++runId.current;
    coachAbort.current?.abort();
    seq.cancel();
    endWindow();
    await beginTurn(my, true);
  }, [beginTurn, endWindow, seq.cancel]);

  /**
   * Realtime coaching for one attempt: cutaway/cue on the avatar, Ava relays the coach caption. 'spoken' when she
   * did, 'fallback' when she did not start in time or the relay failed (Ava is silenced and gated, the caller
   * speaks the line itself), 'aborted' when the run was superseded.
   */
  const coachWithAva = useCallback(
    async (
      p: { caption: string; focus: string | null; cueId: CueId | null; side: boolean; attemptId: string; verdict: string; final: boolean },
      my: number,
    ): Promise<'spoken' | 'fallback' | 'aborted'> => {
      const a = avaRef.current;
      avaCue.current = p.side && p.cueId !== null;
      let viewStart = 0;
      const viewP = (async () => {
        const av = mouthRef.current;
        if (!p.side || !av?.ready) return;
        avaView.current = true;
        try {
          av.stop();
          await av.setView('side');
          if (runId.current !== my) return;
          if (p.cueId) av.showCue(p.cueId);
          viewStart = Date.now();
        } catch {
          /* presentation only */
        }
      })();
      const before = a.speechCount();
      let relayed = true;
      try {
        await a.relayResult(
          { caption: p.caption, focusZoneId: p.focus, verdict: p.verdict },
          p.attemptId,
          p.final ? FINAL_INSTRUCTIONS : undefined,
        );
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
      if (viewStart && p.cueId) {
        const left = CUE_MIN_MS - (Date.now() - viewStart);
        if (left > 0) await sleep(left);
        if (runId.current !== my) return 'aborted';
      }
      quietAva(); // stops lip sync, clears the cue flag and returns the avatar to the front view
      return 'spoken';
    },
    [avaOpen, quietAva],
  );

  /**
   * Between attempts: Ava has the floor with the mic open (VAD on) and the board listens at the same time. The board is
   * live while Ava is not speaking and no result is being decided, and goes live again with a fresh attempt id after
   * she spoke. Each learner utterance is then either an attempt (settleHeld -> runAttempt) or talk (Ava answers); see
   * evaluateHeld. Ends on an attempt, start_practice, the CTA, or when the session is lost.
   */
  const talkWindow = useCallback(
    async (my: number) => {
      const a = avaRef.current;
      const w = win.current;
      startPracticeSignal.current = false;
      if (w.decideTimer) clearTimeout(w.decideTimer);
      if (w.missTimer) clearTimeout(w.missTimer);
      Object.assign(w, { active: true, run: my, attemptCalled: false, talked: false, held: null, decideTimer: null, missTimer: null });
      setTalking(true);
      let live = false;
      let viaPractice = false;
      while (runId.current === my) {
        if (!avaOpen()) break;
        if (startPracticeSignal.current) {
          viaPractice = true;
          break;
        }
        let want: boolean = live;
        if (w.held || a.speakingNow()) want = false; // deciding a result, or Ava is talking
        else if (!live) {
          want = await a.waitForIdle(0); // re-arm only once Ava is fully idle
          if (runId.current !== my) return;
        }
        if (want !== live) {
          live = want;
          if (live) {
            w.attemptCalled = false;
            w.talked = false;
            lastTranscript.current = null;
            newAttempt(); // always a fresh attempt id when the board goes live again
          }
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
    [avaOpen, beginTurn, endWindow, newAttempt],
  );

  /** One finished attempt: coach it (filler, backend coach, then Ava relays or the script speaks) and go on. */
  const runAttempt = useCallback(
    async (result: WordAttemptResult) => {
      const my = ++runId.current;
      endWindow();
      setPhase('thinking');
      const count = ++triesRef.current;
      setTries(count);
      lastResult.current = result;
      // The script owns the floor from here: Ava is silenced and gated (VAD off, mic disabled) before the filler speaks.
      takeFloor();
      let gate: Promise<void> = Promise.resolve();
      const session = avaRef.current.session();
      if (realtimeActive() && session && !session.practiceMode) gate = avaRef.current.setPracticeMode(true);
      void seq.say(LINES.filler, { narration: voiceOnRef.current });

      coachAbort.current?.abort();
      const ctl = new AbortController();
      coachAbort.current = ctl;
      let caption: string;
      let focus: string | null;
      let cueId: CueId | null = null;
      let side: boolean;
      let verdict = scoreWord(result).verdict;
      try {
        const resp = await requestWordCoach({ result, profileId }, ctl.signal);
        caption = resp.caption;
        focus = resp.focusZoneId ?? null;
        cueId = resp.cueId;
        side = resp.showSideView;
        verdict = resp.word?.verdict ?? verdict;
      } catch {
        // Backend unreachable: the same line its deterministic fallback would give.
        const fb = wordFallbackLine(SPEC, result);
        caption = fb.caption;
        focus = fb.focusZoneId;
        side = focus !== null;
      }
      if (runId.current !== my) return;
      coachCache.current.set(result.attemptId, { caption, focusZoneId: focus, verdict });
      lastCoachId.current = result.attemptId;
      setFocusZoneId(focus);
      setPhase('coaching');
      const final = verdict === 'on_target' || count >= MAX_ATTEMPTS;

      if (realtimeActive()) {
        await gate;
        if (runId.current !== my) return;
        if (!(await giveFloorToAva(my))) return; // the filler finishes first, then Ava takes over (never two voices)
        const outcome = await coachWithAva({ caption, focus, cueId, side, attemptId: result.attemptId, verdict, final }, my);
        if (outcome === 'aborted') return;
        if (outcome === 'spoken') {
          if (final) {
            setFocusZoneId(null);
            setPhase('done'); // the session stays open and Ava keeps the floor so the learner can chat until Finish
            avaRef.current.sendAppMessage(DONE_MESSAGE, false);
          } else {
            await talkWindow(my);
          }
          return;
        }
        // 'fallback': Ava is silenced and gated, the script has the floor; speak the line the scripted way below.
      }
      if (!(await line(caption, side, cueId))) return;

      if (final) {
        await sleep(500);
        if (runId.current !== my) return;
        setFocusZoneId(null);
        if (!(await line(LINES.done))) return;
        setPhase('done');
        return;
      }
      await sleep(PAUSE_BEFORE_AGAIN_MS);
      if (runId.current !== my) return;
      await goLive(LINES.again);
    },
    [coachWithAva, endWindow, giveFloorToAva, goLive, line, profileId, realtimeActive, seq.say, setPhase, takeFloor, talkWindow],
  );

  // ---- talk window decisions: was the learner's utterance an attempt (the board scores it) or talk (Ava answers)?

  /** The held board result is an attempt: close the window and coach it. Or talk: drop it and let the window re-arm. */
  const settleHeld = (kind: 'attempt' | 'talk') => {
    const w = win.current;
    const held = w.held;
    if (!w.active || !held) return;
    if (w.decideTimer) clearTimeout(w.decideTimer);
    w.decideTimer = null;
    w.held = null;
    if (kind === 'talk') {
      w.attemptCalled = false;
      w.talked = false;
      newAttempt(); // the board already reported this attempt id; listen again with a fresh one
      return;
    }
    endWindow();
    void runAttempt(held).catch(() => undefined);
  };

  /** Ava's verdict wins (attempt before talk); at the ATTEMPT_DECIDE_MS deadline the transcript decides. */
  const evaluateHeld = (deadline: boolean) => {
    const w = win.current;
    if (!w.active || !w.held || runId.current !== w.run) return;
    if (w.attemptCalled) return settleHeld('attempt');
    if (w.talked) return settleHeld('talk');
    if (!deadline) return;
    const text = lastTranscript.current?.trim() ?? '';
    const words = text ? text.split(/\s+/).length : 0;
    settleHeld(!text || (words <= ATTEMPT_MAX_WORDS && !text.includes('?')) ? 'attempt' : 'talk');
  };

  talkEvents.current = {
    attempt: () => {
      const w = win.current;
      if (!w.active) return;
      w.attemptCalled = true;
      if (w.held) {
        evaluateHeld(false);
        return;
      }
      if (w.missTimer) return;
      // Ava heard an attempt but the board has no result yet; if none comes, ask for another try.
      w.missTimer = setTimeout(() => {
        w.missTimer = null;
        if (!w.active || w.held || runId.current !== w.run) return;
        w.attemptCalled = false;
        avaRef.current.sendAppMessage(MISSED_MESSAGE, true);
        newAttempt();
      }, ATTEMPT_DECIDE_MS);
    },
    talk: () => {
      const w = win.current;
      if (!w.active) return;
      w.talked = true;
      evaluateHeld(false);
    },
  };

  /** Board result: a normal attempt end while live, or a result to hold and classify during the talk window. */
  const onAttemptEnd = (result: WordAttemptResult) => {
    if (result.attemptId !== attemptIdRef.current) return;
    if (phaseRef.current === 'live') {
      void runAttempt(result).catch(() => undefined);
      return;
    }
    const w = win.current;
    if (!w.active || !windowLiveRef.current || w.held || runId.current !== w.run) return;
    w.held = result;
    if (w.missTimer) clearTimeout(w.missTimer);
    w.missTimer = null;
    w.decideTimer = setTimeout(() => evaluateHeld(true), ATTEMPT_DECIDE_MS);
    evaluateHeld(false);
  };

  // Hands-free start: once the microphone is open, begin by itself if the browser already had a tap
  // (the intro and quiz provide one); otherwise wait for Begin so Ava's voice can play.
  const micReady = mic.status === 'ready' || mic.status === 'recording';
  const blocked = mic.status === 'denied' || mic.status === 'unsupported';
  useEffect(() => {
    if (phase !== 'setup' || !micReady) return;
    const activated = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive;
    if (activated) void startLesson();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micReady, phase]);

  // Before the lesson starts the caption explains what will happen (or why it cannot).
  useEffect(() => {
    if (phase !== 'setup') return;
    if (mic.status === 'denied') narration.show('I need the microphone to see your voice. Allow it in the site settings, then reload.');
    else if (mic.status === 'unsupported') narration.show('This browser cannot share a microphone. Try a recent Chrome, Edge or Safari.');
    else narration.show(`I'll show you the word ${SPEC.word}, then it's your turn. Press Begin when you're ready.`);
  }, [phase, mic.status, narration.show]);

  function finish() {
    runId.current++;
    coachAbort.current?.abort();
    seq.cancel();
    floor.current = 'script';
    endWindow();
    quietAva();
    ava.disconnect();
    completeOnboarding();
    navigate('/');
  }

  function leave() {
    runId.current++;
    coachAbort.current?.abort();
    seq.cancel();
    floor.current = 'script';
    endWindow();
    quietAva();
    ava.disconnect();
    navigate('/');
  }

  const boardMode = phase === 'demo' ? 'demo' : phase === 'live' || (phase === 'coaching' && talking && windowLive) ? 'live' : 'idle';
  const lipFrame = camera && lip.status === 'tracking' ? lip.latest : null;
  const micWarning =
    mic.status === 'denied' ? 'Microphone blocked · allow it in site settings' : mic.status === 'unsupported' ? 'Microphone unsupported in this browser' : null;
  // While realtime Ava speaks, her sentence is the caption; otherwise the scripted line's.
  const avaTalking = realtimeOn && ava.speaking && !!ava.caption;
  const captionText = avaTalking ? ava.caption : seq.caption;
  const showTeacherCaption = captions && !!captionText && phase !== 'setup';

  const statusText =
    phase === 'coaching' && talking
      ? `Say “${SPEC.word}”, or ask Ava a question`
      : phase === 'live'
      ? `Your turn · say “${SPEC.word}”`
      : phase === 'done'
        ? 'Lesson complete'
        : tries > 0
          ? `Try ${tries} of ${MAX_ATTEMPTS}`
          : null;

  let cta;
  if (phase === 'setup') {
    cta = (
      <button type="button" className="ob-cta" onClick={() => void startLesson()} disabled={!micReady}>
        <Mic size={18} aria-hidden="true" />
        {mic.status === 'requesting' ? 'Starting…' : 'Begin'}
      </button>
    );
  } else if (phase === 'done') {
    cta = (
      <button type="button" className="ob-cta" onClick={finish}>
        Finish
        <ArrowRight size={18} aria-hidden="true" />
      </button>
    );
  } else {
    cta = (
      <button type="button" className="ob-cta" onClick={() => void skipToTurn()} disabled={phase === 'live'}>
        <RotateCcw size={18} aria-hidden="true" />
        {tries > 0 ? 'Try again' : 'My turn'}
      </button>
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
              Say <span className="navy">“{SPEC.word}”</span>
            </>
          }
        />
        <AccessToggles />
      </div>

      <div className="lp-stage wl-stage" data-phase={phase}>
        <section className="lp-pane wl-guide" aria-label="Ava">
          <MouthReference ref={mouthRef} cue={null} />
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
            {realtimeOn && (
              <span className="lp-pill wl-pill" role="status">
                <MessageCircle size={16} aria-hidden="true" />
                Live conversation
              </span>
            )}
          </div>
        </section>
        <section className="lp-pane wl-board" aria-label={`The word ${SPEC.word}`}>
          <WordBoard
            spec={SPEC}
            frames={voice}
            lip={lipFrame}
            mode={boardMode}
            attemptId={attemptId}
            onAttemptEnd={onAttemptEnd}
            focusZoneId={focusZoneId}
          />
        </section>
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
