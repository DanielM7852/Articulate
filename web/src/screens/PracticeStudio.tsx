import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, ScanFace, Snail, TriangleAlert, Video, VideoOff, Volume2, X } from 'lucide-react';
import { ResultSheet } from '../components/ResultSheet';
import { CaptionBar, useNarration } from '../components/Narration';
import { AccessToggles, OnboardingFrame, Segmented, StepHeading, Switch } from '../components/Onboarding';
import { AmplitudeMeter, CameraTile, LESSON_STEPS } from '../components/practice';
import { VowelGraph } from '../components/VowelGraph';
import { MouthReference, cueForSound, type MouthReferenceHandle, type MouthView } from '../components/MouthReference';
import { TeacherCaptions } from '../components/TeacherCaptions';
import { prepareTeacher, unlockTeacherAudio } from '../audio/teacher';
import { useConversationAudio } from '../conversation/audio';
import { InsightBadge, SessionControls, SessionStatus } from '../conversation/director/SessionControls';
import { useSessionDirector, type CaptureOutcome } from '../conversation/director/useSessionDirector';
import '../conversation/director/director.css';
import { bridgeLine } from '../live/bridge';
import '../live/bridge.css';
import { useLipTracking } from '../vision/useLipTracking';
import { AttemptRecorder } from '../live/attemptRecorder';
import { offlineSink, type MetricSink } from '../live/metricSink';
import { createSpacetimeSink } from '../live/spacetimeSink';
import { requestLiveCoach, type LiveCoachResponse } from '../live/liveCoach';
import { uploadArticulation } from '../live/articulationUpload';
import { getLiveIdentity } from '../live/transport';
import { useCoachSequence } from '../live/useCoachSequence';
import { useMicrophone, type MicStatus } from '../audio/useMicrophone';
import { useSpeech } from '../audio/useSpeech';
import { useVowelTracking, type TrackingStatus } from '../audio/useVowelTracking';
import { analyzeAttempt, type CoachResponse } from '../services/coach';
import { attemptsFor, useAppState } from '../state/AppState';
import { learnerProfileId } from '../state/learnerId';
import { SOUNDS, SOUND_ORDER, type Attempt } from '../state/types';
import { TARGETS } from '../vowel/targets';
import { setCaptureBusy } from '../classroom/captureGate';

/**
 * Practice Studio: a therapist-led, hands-free session (see conversation/director/useSessionDirector.ts for the
 * conversation state machine). The capture phases below are driven by the director, never by a button:
 *   ready     -> nothing captured
 *   recording -> a voiced segment was detected; mic, F1/F2 window, lips and recorder are capturing
 *   analyzing -> attempt saved, result sheet opens, coach response pending (bridge line speaks meanwhile)
 *   feedback  -> measured summary + grounded coach response
 * Scoring never waits on the coach; the sheet opens before the response arrives and closes when the next
 * capture begins, so it never blocks the hands-free flow.
 */
type Phase = 'ready' | 'recording' | 'analyzing' | 'feedback';
type View = 'graph' | 'guide' | 'mirror';

/** Keeps the sheet mounted long enough for its own exit motion to finish. */
const SHEET_EXIT_MS = 260;

/** One short line for the graph's status chip. Tracking words come from the vowel-mapper engine. */
function trackingLabel(tracking: TrackingStatus, mic: MicStatus) {
  if (mic === 'denied') return 'Microphone blocked';
  if (mic === 'unsupported') return 'Microphone unsupported';
  switch (tracking) {
    case 'off':
      return 'Starts with the session';
    case 'starting':
      return 'Starting…';
    case 'tracking':
      return 'Tracking your vowel';
    case 'acquiring':
    case 'uncertain':
      return 'Finding your vowel';
    case 'quiet':
      return 'Listening';
    case 'unvoiced':
      return 'Hold a steady vowel';
    case 'clipped':
      return 'Too loud · move back a little';
    case 'paused':
      return 'Audio paused';
    case 'invalid':
    case 'error':
      return 'Tracking unavailable';
  }
}

/** Short verdict string from a backend audio/video analysis blob; falls back when no known field is present. */
function verdictOf(blob: Record<string, unknown>, fallback: string): string {
  for (const k of ['verdict', 'status', 'quality']) {
    const v = blob[k];
    if (typeof v === 'string' && v) return v;
  }
  return fallback;
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

export default function PracticeStudio() {
  const navigate = useNavigate();
  const mic = useMicrophone();
  const speech = useSpeech();
  const { plan, updatePlan, attempts, addAttempt, updateAttempt, camera, setCamera, narration: voiceOn, captions, preferences, lessonTarget, lessonCue, lessonRevision, lessonRepetitions } = useAppState();
  const profileId = useMemo(() => learnerProfileId(), []);
  const [liveResp, setLiveResp] = useState<LiveCoachResponse | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const lip = useLipTracking(videoEl, camera);
  const mouthRef = useRef<MouthReferenceHandle | null>(null);
  const recorder = useRef<AttemptRecorder | null>(null);
  // The recorder holds one stable sink that delegates to whichever SpacetimeDB sink is live
  // for the current profile; until one is ready it behaves exactly like offlineSink.
  const sinkRef = useRef<MetricSink>(offlineSink);
  const delegate = useRef<MetricSink>({
    get connected() {
      return sinkRef.current.connected;
    },
    beginAttempt: (id, sound) => sinkRef.current.beginAttempt(id, sound),
    push: (kind, seq, frames) => sinkRef.current.push(kind, seq, frames),
    endAttempt: (id) => sinkRef.current.endAttempt(id),
  });
  if (!recorder.current) recorder.current = new AttemptRecorder(delegate.current);
  useEffect(() => {
    let disposed = false;
    let sink: ReturnType<typeof createSpacetimeSink> | null = null;
    // In shared mode the authenticated API queues inline features. Browser SDK identities cannot
    // write signed guest profiles or impersonate the API's backend identity.
    void getLiveIdentity().then((principal) => {
      if (disposed || principal.shared) return;
      sink = createSpacetimeSink({ profileId, displayName: '' });
      sinkRef.current = sink;
    }).catch(() => { /* Local coaching remains available if the backend cannot be reached. */ });
    return () => {
      disposed = true;
      sinkRef.current = offlineSink;
      sink?.close();
    };
  }, [profileId]);
  const attemptIdRef = useRef<string>('');
  const runId = useRef(0);
  const coachAbort = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<Phase>('ready');
  useEffect(() => {
    setCaptureBusy(phase === 'recording' || phase === 'analyzing');
    return () => setCaptureBusy(false);
  }, [phase]);
  const [current, setCurrent] = useState<Attempt | null>(null);
  const [coach, setCoach] = useState<CoachResponse | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [referencePlaying, setReferencePlaying] = useState(false);
  const [sheetClosed, setSheetClosed] = useState(false);
  const replayRef = useRef<HTMLAudioElement | null>(null);

  // The graph is the main view. The 3D guide or the mirror open beside it on request;
  // on phones there is one pane and a switcher.
  const compact = useMediaQuery('(max-width: 720px)');
  const [view, setView] = useState<View>('graph');
  const [refView, setRefView] = useState<MouthView>('front');
  const [slow, setSlow] = useState(false);

  // Live F1/F2 on the same microphone stream; it runs whenever the mic is open.
  const tracking = useVowelTracking(mic.stream, TARGETS[plan.sound]);

  const seq = useCoachSequence(
    () => mouthRef.current,
    () => setView('guide'),
  );

  // Real tracker output only: frames are recorded between recorder.begin and recorder.end.
  useEffect(() => tracking.subscribe((f) => recorder.current?.pushAudio(f)), [tracking.subscribe]);
  useEffect(() => lip.subscribe((f) => recorder.current?.pushVideo(f)), [lip.subscribe]);

  // Leaving the screen cancels speech, resets the demo and abandons any in-flight request.
  useEffect(
    () => () => {
      runId.current++;
      coachAbort.current?.abort();
      recorder.current?.discard();
    },
    [],
  );

  const s = SOUNDS[plan.sound];
  const history = useMemo(() => attemptsFor(attempts, plan.sound), [attempts, plan.sound]);
  const guidedCount = history.filter((a) => a.kind === 'guided' && a.quality === 'usable').length;
  const stepIndex = phase === 'feedback' ? (guidedCount > 1 ? 3 : 2) : guidedCount > 0 ? 3 : 1;
  const assistanceOn = plan.assistance !== 'none';
  const recording = phase === 'recording';

  useEffect(() => {
    if (!speech.speaking) setReferencePlaying(false);
  }, [speech.speaking]);

  useEffect(() => () => {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  }, [recordingUrl]);

  function resetForSound() {
    runId.current++;
    coachAbort.current?.abort();
    recorder.current?.discard();
    seq.cancel();
    setPhase('ready');
    setCurrent(null);
    setCoach(null);
    setLiveResp(null);
  }

  const captureActive = useRef(false);

  /** Segment started: begin an attempt capture. Phase 'recording' also closes the result sheet. */
  async function beginCapture() {
    runId.current++;
    coachAbort.current?.abort();
    speech.stop();
    replayRef.current?.pause();
    setReferencePlaying(false);
    setCoach(null);
    setLiveResp(null);
    const attemptId = crypto.randomUUID();
    attemptIdRef.current = attemptId;
    captureActive.current = true;
    await recorder.current!.begin(attemptId, plan.sound);
    const ok = await mic.beginRecording();
    if (!ok) {
      captureActive.current = false;
      recorder.current!.discard();
      return;
    }
    tracking.beginWindow();
    lip.beginWindow();
    setPhase('recording');
  }

  /** Drop a capture without storing an attempt; also supersedes any grading in flight. Safe when idle. */
  function discardCapture() {
    runId.current++;
    coachAbort.current?.abort();
    if (!captureActive.current) return;
    captureActive.current = false;
    tracking.endWindow();
    lip.endWindow();
    recorder.current?.discard();
    void mic.endRecording().then((s) => {
      if (s.recordingUrl) URL.revokeObjectURL(s.recordingUrl);
    });
    setPhase('ready');
  }

  /** Segment ended as an attempt: grade it. Resolves with the coach summary for the director. */
  async function finishCapture(): Promise<CaptureOutcome | null> {
    const myRun = ++runId.current;
    captureActive.current = false;
    const attemptPcm = convAudio.takeAttemptPcm(); // taken now so a later segment can't replace it
    prepareTeacher(); // fetch the speech token and open the socket while the coach call runs
    void unlockTeacherAudio();
    const target = tracking.endWindow();
    const lipOn = camera && lip.status === 'tracking';
    lip.endWindow();
    const recorded = recorder.current!.end(); // stops frame capture now; resolves after the final flush
    const summary = await mic.endRecording();
    if (runId.current !== myRun) {
      if (summary.recordingUrl) URL.revokeObjectURL(summary.recordingUrl);
      return null;
    }
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingUrl(summary.recordingUrl);
    const attempt: Attempt = {
      attemptId: attemptIdRef.current || crypto.randomUUID(),
      sound: plan.sound,
      kind: 'guided',
      assistance: plan.assistance,
      startedAt: Date.now(),
      durationSec: summary.durationSec,
      usableVoicedSec: summary.usableVoicedSec,
      // From the on-device F1/F2 tracker; null if tracking never ran during this take.
      timeInTargetSec: target?.timeInTargetSec ?? null,
      longestHoldSec: target?.longestHoldSec ?? null,
      quality: summary.quality,
      qualityReason: summary.qualityReason,
      recognizedText: null,
      lessonRevision,
      referenceVersion: lessonTarget ?? plan.sound,
    };
    addAttempt(attempt);
    const finding = summary.quality === 'usable'
      ? 'none'
      : summary.qualityReason === 'too-short'
        ? 'too_short'
        : summary.qualityReason === 'clipping'
          ? 'clipping'
          : summary.qualityReason === 'silence'
            ? 'silence'
            : summary.qualityReason === 'no-mic'
              ? 'no_mic'
              : 'insufficient';
    window.dispatchEvent(new CustomEvent('articulate-practice-attempt', {
      detail: { attemptId: attempt.attemptId, exercise: lessonTarget ?? plan.sound, usable: summary.quality === 'usable', finding },
    }));
    setCurrent(attempt);
    setSheetClosed(false);
    setPhase('analyzing');
    // Bridge: say what was measured right away while the coach call runs.
    void seq.say(
      bridgeLine({
        sound: attempt.sound,
        timeInTargetSec: attempt.timeInTargetSec,
        longestHoldSec: attempt.longestHoldSec,
        usableVoicedSec: attempt.usableVoicedSec,
        quality: attempt.quality,
        lipTracking: lipOn,
      }),
      { narration: voiceOn },
    );

    // Live coaching first; any failure falls back to the existing local/agent path.
    let live: LiveCoachResponse | null = null;
    // Background articulation analysis: fire-and-forget, parallel to (never blocking) the coach call.
    let insight: Promise<boolean> | undefined;
    if (attemptPcm) {
      insight = uploadArticulation({
        attemptId: attempt.attemptId,
        profileId,
        sound: attempt.sound,
        pcm: attemptPcm.pcm,
        captureStartMonotonicMs: attemptPcm.startMs,
        timeOriginUnixMs: performance.timeOrigin,
      });
    }
    try {
      const rec = await recorded;
      const ctl = new AbortController();
      coachAbort.current = ctl;
      live = await requestLiveCoach(
        {
          attemptId: attempt.attemptId,
          profileId,
          sound: attempt.sound,
          metricsSource: rec.streamed ? 'spacetimedb' : 'inline',
          clientSummary: {
            durationSec: attempt.durationSec,
            usableVoicedSec: attempt.usableVoicedSec,
            timeInTargetSec: attempt.timeInTargetSec,
            longestHoldSec: attempt.longestHoldSec,
            quality: attempt.quality,
            qualityReason: attempt.qualityReason ?? null,
          },
          frames: rec.streamed ? null : { audio: rec.audio, video: rec.video },
        },
        ctl.signal,
      );
    } catch {
      live = null;
    }
    if (runId.current !== myRun) return null; // superseded (barge-in, tap control, leaving the screen)

    if (live) {
      setLiveResp(live);
      setCoach({
        attemptId: live.attemptId,
        source: live.source === 'agent' ? 'agent' : 'local',
        observation: live.observation,
        nextCue: '',
        nextAction: live.nextAction === 'next_sound' ? 'next-context' : live.nextAction === 'rest' ? 'simplify' : 'repeat',
        evidence: live.evidence.map((e) => `${e.field}: ${String(e.value)}`),
      });
      setPhase('feedback');
      await seq.run(live, { narration: voiceOn });
      if (runId.current !== myRun) return null;
      return {
        attemptId: attempt.attemptId,
        insight,
        coach: {
          caption: live.caption,
          cueId: live.cueId,
          nextAction: live.nextAction,
          audioVerdict: verdictOf(live.audio, attempt.qualityReason ?? attempt.quality),
          videoVerdict: live.video ? verdictOf(live.video, '') || null : null,
        },
      };
    }

    const response = await analyzeAttempt(attempt, history, { learnerId: profileId, plan, preferences });
    // The session director owns the current sound; apply only pace and assistance.
    if (response.plan) updatePlan({ pace: response.plan.pace, assistance: response.plan.assistance });
    await seq.whenIdle(); // never overlap the bridge line
    if (runId.current !== myRun) return null;
    setCoach(response);
    setPhase('feedback');
    const text = `${response.observation} ${response.nextCue}`.trim();
    await seq.speakLine({ text, cueId: null, showSideView: false }, { narration: voiceOn });
    if (runId.current !== myRun) return null;
    return {
      attemptId: attempt.attemptId,
      insight,
      coach: {
        caption: text,
        cueId: null,
        nextAction: response.nextAction === 'next-context' ? 'next_sound' : response.nextAction === 'simplify' ? 'rest' : 'retry',
        audioVerdict: attempt.qualityReason ?? attempt.quality,
        videoVerdict: null,
      },
    };
  }

  /* ---------- Hands-free session ---------- */
  const [armed, setArmed] = useState(false);
  const vowel = useMemo(() => ({ subscribe: tracking.subscribe }), [tracking.subscribe]);
  const convAudio = useConversationAudio({ vowel, enabled: armed });
  const director = useSessionDirector({
    audio: convAudio,
    profileId,
    displayName: '',
    sound: plan.sound,
    setSound: (id) => {
      updatePlan({ sound: id });
      setCurrent(null);
      setCoach(null);
      setLiveResp(null);
      setPhase('ready');
    },
    narration: voiceOn,
    speakLine: seq.speakLine,
    cancelSpeech: () => seq.cancel(),
    prepare: async () => {
      setArmed(true);
      return mic.start();
    },
    capture: { begin: beginCapture, finish: finishCapture, discard: discardCapture },
    onEnded: () => navigate('/own'),
  });
  const sessionRunning = director.active;
  const sessionShown = sessionRunning || director.state === 'ended';
  // Starting, running or just ended: Ava owns the voice.
  const sessionBusy = director.state !== 'idle' && director.state !== 'error';

  // One voice: before the session the guide reads the instruction; once it starts Ava does the talking.
  const narration = useNarration(speech);
  useEffect(() => {
    if (sessionBusy) narration.show(null);
    else narration.say(`Say “${s.spelled}” as in “${s.example}”. Hold it for about 3 seconds, then press Begin session.`);
  }, [sessionBusy, s.spelled, s.example, narration.say, narration.show]);

  function readFeedback() {
    if (liveResp) void seq.run(liveResp, { narration: true });
    else if (coach) speech.speak(`${coach.observation} ${coach.nextCue}`, { force: true });
  }

  function playReference() {
    setReferencePlaying(true);
    speech.speak(`${s.spelled}. ${s.spelled}. As in, ${s.example}.`, { force: true, rate: 0.8 });
  }

  function replayRecording() {
    if (!recordingUrl) return;
    speech.stop();
    const el = new Audio(recordingUrl);
    replayRef.current = el;
    el.play().catch(() => undefined);
  }

  /** Stop speech, capture and in-flight grading before navigating away; unmount tears the session down. */
  function leaveTo(path: string) {
    runId.current++;
    coachAbort.current?.abort();
    seq.cancel();
    recorder.current?.discard();
    navigate(path);
  }

  /* ---------- Result sheet: stays mounted briefly so it can slide back down ---------- */
  const sheetOpen = (phase === 'analyzing' || phase === 'feedback') && current !== null && !sheetClosed;
  const [sheetMounted, setSheetMounted] = useState(false);
  const lastResult = useRef<{ attempt: Attempt; coach: CoachResponse | null } | null>(null);
  if (sheetOpen && current) lastResult.current = { attempt: current, coach };
  useEffect(() => {
    if (sheetOpen) return setSheetMounted(true);
    const t = setTimeout(() => setSheetMounted(false), SHEET_EXIT_MS);
    return () => clearTimeout(t);
  }, [sheetOpen]);

  /* ---------- Panes ---------- */
  const viewSwitch = (
    <Segmented
      className="lp-mini lp-mini--views"
      label="View"
      options={[
        { id: 'graph' as View, label: 'Sound' },
        { id: 'guide' as View, label: 'Guide' },
        { id: 'mirror' as View, label: 'Mirror' },
      ]}
      value={view}
      onChange={setView}
    />
  );

  const graphPane = (
    <section className="lp-pane" aria-label="Your sound">
      <VowelGraph
        sound={plan.sound}
        point={tracking.point}
        trace={tracking.trace}
        tracking={tracking.tracking}
        statusLabel={trackingLabel(tracking.status, mic.status)}
        holdSec={tracking.holdSec}
        hidden={!assistanceOn}
        live={tracking.status !== 'off' && tracking.status !== 'error'}
        emptyHint={lessonTarget ? `Teacher target: ${lessonTarget}. Repetitions ${lessonRepetitions}.` : `Begin the session, then hold “${s.spelled}” steadily.`}
      />
      <div className="lp-overlay lp-overlay--tl lp-pills">
        {compact ? (
          viewSwitch
        ) : (
          view === 'graph' && (
            <button type="button" className="lp-pill" onClick={() => setView('guide')}>
              <ScanFace size={16} aria-hidden="true" />
              Show guide
            </button>
          )
        )}
      </div>
      <label className="lp-overlay lp-overlay--br lp-pill lp-target">
        Target
        <Switch label="Show target" checked={assistanceOn} onChange={(on) => updatePlan({ assistance: on ? 'cue-target' : 'none' })} />
      </label>
    </section>
  );

  const guidePane = (
    <section className="lp-pane" aria-label="Mouth guide">
      <MouthReference ref={mouthRef} cue={lessonCue === 'spread-lips' || lessonCue === 'round-lips' || lessonCue === 'open-jaw' ? lessonCue : cueForSound(plan.sound)} view={refView} slow={slow} paused={narration.paused} />
      <div className="lp-overlay lp-overlay--tl lp-pills">
        {compact ? (
          viewSwitch
        ) : (
          <>
            <button type="button" className="lp-pill" aria-label="Hide guide" title="Hide guide" onClick={() => setView('graph')}>
              <X size={16} aria-hidden="true" />
            </button>
            <button type="button" className="lp-pill" onClick={() => setView('mirror')}>
              <Video size={16} aria-hidden="true" />
              Mirror
            </button>
          </>
        )}
        <button type="button" className="lp-pill" aria-pressed={slow} onClick={() => setSlow((v) => !v)}>
          <Snail size={16} aria-hidden="true" />
          Slow
        </button>
      </div>
      <Segmented
        className="lp-overlay lp-overlay--tr lp-mini"
        label="Reference view"
        options={[
          { id: 'front' as MouthView, label: 'Front' },
          { id: 'side' as MouthView, label: 'Side · tongue' },
        ]}
        value={refView}
        onChange={setRefView}
      />
      <div className="lp-overlay lp-overlay--bl lp-note">
        <p className="ob-label navy">{s.tongue}</p>
        <p className="ob-fine">{s.lips}</p>
      </div>
    </section>
  );

  const mirrorPane = (
    <section className={`lp-pane lp-mirror ${camera ? 'is-on' : ''}`} aria-label="Mirror">
      {camera ? (
        <CameraTile enabled onVideoElement={setVideoEl} lipStatus={lip.status} />
      ) : (
        <div className="lp-empty">
          <span className="ob-cam-icon" aria-hidden="true">
            <Video size={22} />
          </span>
          <p className="ob-label">See your lips while you practice</p>
          <p className="ob-fine">Nothing is saved.</p>
          <button type="button" className="btn btn--sm" onClick={() => setCamera(true)}>
            <Video size={16} aria-hidden="true" /> Turn on camera
          </button>
        </div>
      )}
      <div className="lp-overlay lp-overlay--tl lp-pills">
        {compact ? (
          viewSwitch
        ) : (
          <>
            <button type="button" className="lp-pill" aria-label="Hide mirror" title="Hide mirror" onClick={() => setView('graph')}>
              <X size={16} aria-hidden="true" />
            </button>
            <button type="button" className="lp-pill" onClick={() => setView('guide')}>
              <ScanFace size={16} aria-hidden="true" />
              Guide
            </button>
          </>
        )}
        {camera && (
          <button type="button" className="lp-pill" onClick={() => setCamera(false)}>
            <VideoOff size={16} aria-hidden="true" />
            Turn off
          </button>
        )}
      </div>
      {camera && <span className="lp-overlay lp-overlay--bl lp-pill">Visible lips only · not saved</span>}
    </section>
  );

  const sidePane = view === 'graph' ? graphPane : view === 'guide' ? guidePane : mirrorPane;
  const solo = compact || view === 'graph';

  const micWarning =
    mic.status === 'denied' ? 'Microphone blocked · allow it in site settings' : mic.status === 'unsupported' ? 'Microphone unsupported in this browser' : null;
  const beginLabel = director.state === 'starting' ? 'Starting…' : director.state === 'error' ? 'Try again' : 'Begin session';
  const showHeard = sessionShown && director.heard !== null;
  const showTeacherCaption = sessionShown && captions && !!seq.caption;

  return (
    <OnboardingFrame
      step={stepIndex + 1}
      total={LESSON_STEPS.length}
      progressLabel="Lesson progress"
      bar="none"
      stageKey="practice"
      className="lp ob-content--full"
      footer={
        sessionShown ? (
          <>
            <div className="lp-meter" aria-hidden={!recording && !micWarning}>
              {micWarning ? (
                <span className="ob-status ob-status--warn" role="alert">
                  <TriangleAlert size={16} aria-hidden="true" /> {micWarning}
                </span>
              ) : (
                recording && <AmplitudeMeter levels={mic.levels} active />
              )}
            </div>
            <div className="sd-bar sd-bar--footer">
              <SessionStatus state={director.state} label={director.statusLabel} />
              {director.insightPending && <InsightBadge />}
              <SessionControls
                state={director.state}
                onControl={director.control}
                bargeInMode={convAudio.bargeInMode}
                onBargeInMode={convAudio.setBargeInMode}
              />
            </div>
          </>
        ) : (
          <>
            <button type="button" className="ob-text-btn lp-listen" onClick={playReference} disabled={director.state === 'starting'}>
              <Volume2 size={18} aria-hidden="true" />
              {referencePlaying ? 'Playing…' : 'Hear example'}
            </button>
            <div className="lp-meter sd-begin-note">
              {micWarning ? (
                <span className="ob-status ob-status--warn" role="alert">
                  <TriangleAlert size={16} aria-hidden="true" /> {micWarning}
                </span>
              ) : (
                <>
                  {director.state === 'starting' && <SessionStatus state="starting" label="Getting ready…" />}
                  {director.error && (
                    <p className="sd-error" role="alert">
                      {director.error}
                    </p>
                  )}
                  <p className="ob-fine">One tap lets your browser play Ava’s voice. Captions are always shown.</p>
                </>
              )}
            </div>
            <button
              type="button"
              className="ob-cta"
              onClick={() => void director.begin()}
              disabled={director.state === 'starting' || mic.status === 'unsupported'}
            >
              <Mic size={18} aria-hidden="true" />
              {beginLabel}
            </button>
          </>
        )
      }
      overlay={
        sheetMounted &&
        lastResult.current && (
          <ResultSheet
            attempt={lastResult.current.attempt}
            coach={lastResult.current.coach}
            leaving={!sheetOpen}
            feeling={attempts.find((a) => a.attemptId === lastResult.current?.attempt.attemptId)?.feeling}
            onFeeling={(id) => {
              updateAttempt(lastResult.current!.attempt.attemptId, { feeling: id });
              if (id === 'ready') updatePlan({ assistance: 'target-only' });
            }}
            onReplay={recordingUrl ? replayRecording : undefined}
            onReadAloud={readFeedback}
            retryLabel="Try again"
            onTryAgain={() => {
              setSheetClosed(true);
              if (sessionRunning) director.control('ready');
            }}
            onOnMyOwn={() => leaveTo('/own')}
            onDismiss={() => setSheetClosed(true)}
          />
        )
      }
    >
      <div className="lp-head">
        <button type="button" className="ob-icon-btn" aria-label="Finish session" title="Finish session" onClick={() => leaveTo('/')}>
          <X size={22} aria-hidden="true" />
        </button>
        <StepHeading
          title={
            lessonTarget === 'head' ? (
              <>Practice <span className="navy">head</span></>
            ) : (
              <>
                Find your {s.spelled} <span className="navy">{s.ipa}</span>
              </>
            )
          }
        />
        {lessonRevision > 0 && (
          <p className="ob-fine">
            {lessonTarget === 'head' ? 'Word' : 'Isolated sound'} · {lessonCue === 'spread-lips' ? 'Spread lips' : lessonCue === 'round-lips' ? 'Round lips' : lessonCue === 'open-jaw' ? 'Open jaw' : 'No cue'} · {plan.assistance === 'cue-target' ? 'Cue and target' : plan.assistance === 'target-only' ? 'Target only' : 'No extra support'} · {lessonRepetitions} {lessonRepetitions === 1 ? 'repetition' : 'repetitions'}
          </p>
        )}
        <Segmented
          className="lp-sounds"
          label="Choose a sound"
          options={SOUND_ORDER.map((id) => ({
            id,
            label: (
              <>
                <span className="serif">{SOUNDS[id].ipa}</span> {SOUNDS[id].spelled}
              </>
            ),
          }))}
          value={plan.sound}
          disabled={recording || sessionBusy}
          onChange={(id) => {
            updatePlan({ sound: id });
            resetForSound();
          }}
        />
        <AccessToggles />
      </div>

      <div className={`lp-stage ${solo ? 'is-solo' : ''}`}>
        {!compact && graphPane}
        {!solo && sidePane}
        {compact && sidePane}
        {/* Keep the camera and lip tracking alive while another pane is showing (the teacher sequence opens the guide). */}
        {camera && view !== 'mirror' && (
          <div className="sd-offscreen" aria-hidden="true">
            <CameraTile enabled onVideoElement={setVideoEl} lipStatus={lip.status} />
          </div>
        )}
        {sessionShown ? (
          (showTeacherCaption || showHeard) && (
            <div className="cap cap-card sd-cap">
              {showTeacherCaption && <TeacherCaptions className="cap-text" speech={seq.speech} text={seq.caption!} />}
              {showHeard && (
                <p className="sd-heard" aria-live="polite">
                  You said: {director.heard ? `“${director.heard}”` : '(nothing I could make out)'}
                </p>
              )}
            </div>
          )
        ) : (
          <CaptionBar className="cap-card" text={narration.caption} paused={narration.paused} onToggle={narration.toggle} />
        )}
      </div>
    </OnboardingFrame>
  );
}
