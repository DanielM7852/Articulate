import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Captions, Mic, MicOff, RotateCcw, TriangleAlert, Video, VideoOff, X } from 'lucide-react';
import { CaptionBar, readingTime, useNarration } from '../components/Narration';
import { AccessToggles, OnboardingFrame, StepHeading } from '../components/Onboarding';
import { CameraTile } from '../components/practice';
import { MouthReference, type MouthReferenceHandle } from '../components/MouthReference';
import { TeacherCaptions } from '../components/TeacherCaptions';
import { WordBoard } from '../components/WordBoard';
import { prepareTeacher, unlockTeacherAudio } from '../audio/teacher';
import { useMicrophone, type MicStatus } from '../audio/useMicrophone';
import { useVoiceFrames, type VoiceFrames } from '../audio/useVoiceFrames';
import { useLipTracking, type LipTrackingStatus } from '../vision/useLipTracking';
import { useCoachSequence } from '../live/useCoachSequence';
import type { CueId } from '../live/liveCoach';
import { requestWordCoach, scoreWord, wordFallbackLine } from '../live/wordCoach';
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

  useEffect(
    () => () => {
      runId.current++;
      coachAbort.current?.abort();
    },
    [],
  );

  // Ask for the microphone as soon as the screen opens.
  const micStart = mic.start;
  useEffect(() => {
    void micStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** One Ava line. With narration off the caption stays up for its reading time. False if superseded. */
  const line = useCallback(
    async (text: string, side = false, cueId: CueId | null = null): Promise<boolean> => {
      const my = runId.current;
      const started = Date.now();
      await seq.speakLine({ text, cueId, showSideView: side }, { narration: voiceOnRef.current });
      if (runId.current !== my) return false;
      if (!voiceOnRef.current) {
        const left = readingTime(text) - (Date.now() - started);
        if (left > 0) await sleep(left);
      }
      return runId.current === my;
    },
    [seq.speakLine],
  );

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
    triesRef.current = 0;
    setTries(0);
    setFocusZoneId(null);
    setPhase('intro');
    if (!(await line(LINES.intro))) return;
    setPhase('demo');
    const demoStart = Date.now();
    // Side cutaway while Ava says the word; the board plays the zone sequence alongside.
    if (!(await line(LINES.demo, true))) return;
    const left = DEMO_MIN_MS - (Date.now() - demoStart);
    if (left > 0) await sleep(left);
    if (runId.current !== my) return;
    await goLive(LINES.yourTurn);
  }, [goLive, line, narration.show, setPhase]);

  /** Mouse path: skip whatever Ava is saying and start a new attempt now. */
  const skipToTurn = useCallback(() => {
    runId.current++;
    coachAbort.current?.abort();
    seq.cancel();
    newAttempt();
    setPhase('live');
  }, [newAttempt, seq.cancel, setPhase]);

  const onAttemptEnd = useCallback(
    async (result: WordAttemptResult) => {
      if (phaseRef.current !== 'live' || result.attemptId !== attemptIdRef.current) return;
      const my = ++runId.current;
      setPhase('thinking');
      const count = ++triesRef.current;
      setTries(count);
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
      setFocusZoneId(focus);
      setPhase('coaching');
      if (!(await line(caption, side, cueId))) return;

      if (verdict === 'on_target' || count >= MAX_ATTEMPTS) {
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
    [goLive, line, profileId, seq.say, setPhase],
  );

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
    completeOnboarding();
    navigate('/');
  }

  function leave() {
    runId.current++;
    coachAbort.current?.abort();
    seq.cancel();
    navigate('/');
  }

  const boardMode = phase === 'demo' ? 'demo' : phase === 'live' ? 'live' : 'idle';
  const lipFrame = camera && lip.status === 'tracking' ? lip.latest : null;
  const micWarning =
    mic.status === 'denied' ? 'Microphone blocked · allow it in site settings' : mic.status === 'unsupported' ? 'Microphone unsupported in this browser' : null;
  const showTeacherCaption = captions && !!seq.caption && phase !== 'setup';

  const statusText =
    phase === 'live'
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
      <button type="button" className="ob-cta" onClick={skipToTurn} disabled={phase === 'live'}>
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
              <TeacherCaptions className="cap-text" speech={seq.speech} text={seq.caption!} />
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
          </div>
        </section>
        <section className="lp-pane wl-board" aria-label={`The word ${SPEC.word}`}>
          <WordBoard
            spec={SPEC}
            frames={voice}
            lip={lipFrame}
            mode={boardMode}
            attemptId={attemptId}
            onAttemptEnd={(r) => void onAttemptEnd(r)}
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
