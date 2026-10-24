import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Mic, Play, ScanFace, Snail, Square, TriangleAlert, Video, VideoOff, Volume2 } from 'lucide-react';
import { OnboardingFrame, Segmented, StepHeading, Switch } from '../components/Onboarding';
import { AmplitudeMeter, CameraTile, LESSON_STEPS } from '../components/practice';
import { VowelGraph } from '../components/VowelGraph';
import { MouthReference, type MouthReferenceHandle, type MouthView } from '../components/MouthReference';
import { TeacherCaptions } from '../components/TeacherCaptions';
import { unlockTeacherAudio } from '../audio/teacher';
import { useLipTracking } from '../vision/useLipTracking';
import { AttemptRecorder } from '../live/attemptRecorder';
import { offlineSink, type MetricSink } from '../live/metricSink';
import { createSpacetimeSink, type SinkStatus } from '../live/spacetimeSink';
import { profileIdFor, requestLiveCoach, type LiveCoachResponse } from '../live/liveCoach';
import { useCoachSequence } from '../live/useCoachSequence';
import { useMicrophone, type MicStatus } from '../audio/useMicrophone';
import { useSpeech } from '../audio/useSpeech';
import { useVowelTracking, type TrackingStatus } from '../audio/useVowelTracking';
import { analyzeAttempt, type CoachResponse } from '../services/coach';
import { attemptsFor, useAppState } from '../state/AppState';
import { SOUNDS, SOUND_ORDER, type Attempt } from '../state/types';
import { TARGETS } from '../vowel/targets';

/**
 * Practice Studio: one screen, explicit states.
 *   ready     -> preview the reference, nothing recording
 *   recording -> example and narration stopped, mic capturing
 *   analyzing -> attempt saved, result sheet opens, coach response pending
 *   feedback  -> measured summary + grounded coach response + retry choices
 * Scoring never waits on the coach; the sheet opens before the response arrives.
 */
type Phase = 'ready' | 'recording' | 'analyzing' | 'feedback';
type View = 'graph' | 'guide' | 'mirror';

const FEELINGS = [
  { id: 'too-hard', label: 'Too hard' },
  { id: 'okay', label: 'Okay' },
  { id: 'ready', label: 'Ready for more' },
] as const;

const SHEET_EXIT_MS = 220;

/** One short line for the graph's status chip. Tracking words come from the vowel-mapper engine. */
function trackingLabel(tracking: TrackingStatus, mic: MicStatus) {
  if (mic === 'denied') return 'Microphone blocked';
  if (mic === 'unsupported') return 'Microphone unsupported';
  switch (tracking) {
    case 'off':
      return 'Starts when you record';
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
  const { plan, updatePlan, attempts, addAttempt, updateAttempt, camera, setCamera, narration, captions, learnerName } = useAppState();
  const profileId = profileIdFor(learnerName);
  const [liveResp, setLiveResp] = useState<LiveCoachResponse | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const lip = useLipTracking(videoEl, camera);
  const mouthRef = useRef<MouthReferenceHandle | null>(null);
  const recorder = useRef<AttemptRecorder | null>(null);
  // The recorder holds one stable sink that delegates to whichever SpacetimeDB sink is live
  // for the current profile; until one is ready it behaves exactly like offlineSink.
  const sinkRef = useRef<MetricSink>(offlineSink);
  const [syncStatus, setSyncStatus] = useState<SinkStatus>('offline');
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
    const sink = createSpacetimeSink({ profileId, displayName: learnerName || 'Learner', onStatus: setSyncStatus });
    sinkRef.current = sink;
    setSyncStatus(sink.status);
    return () => {
      sinkRef.current = offlineSink;
      sink.close();
    };
  }, [profileId, learnerName]);
  const attemptIdRef = useRef<string>('');
  const runId = useRef(0);
  const coachAbort = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<Phase>('ready');
  const [current, setCurrent] = useState<Attempt | null>(null);
  const [coach, setCoach] = useState<CoachResponse | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [referencePlaying, setReferencePlaying] = useState(false);
  const replayRef = useRef<HTMLAudioElement | null>(null);

  // One tile on phones (switch between views), two side by side on wider screens.
  const compact = useMediaQuery('(max-width: 720px)');
  const [view, setView] = useState<View>(camera ? 'mirror' : 'guide');
  const [refView, setRefView] = useState<MouthView>('front');
  const [slow, setSlow] = useState(false);
  const sideView: View = compact ? view : view === 'graph' ? 'guide' : view;

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
  const busy = recording || phase === 'analyzing';

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

  async function startRecording() {
    void unlockTeacherAudio(); // must run inside the click gesture
    runId.current++;
    coachAbort.current?.abort();
    seq.cancel(); // cancels teacher speech, lip sync and cue; returns the avatar to front view
    speech.stop(); // playback must stop before the learner is recorded
    replayRef.current?.pause();
    setReferencePlaying(false);
    setCoach(null);
    setLiveResp(null);
    const attemptId = crypto.randomUUID();
    attemptIdRef.current = attemptId;
    await recorder.current!.begin(attemptId, plan.sound);
    const ok = await mic.beginRecording();
    if (!ok) {
      recorder.current!.discard();
      return;
    }
    tracking.beginWindow();
    lip.beginWindow();
    setPhase('recording');
  }

  async function stopRecording() {
    const myRun = ++runId.current;
    const target = tracking.endWindow();
    lip.endWindow();
    const recorded = recorder.current!.end(); // stops frame capture now; resolves after the final flush
    const summary = await mic.endRecording();
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
    };
    addAttempt(attempt);
    setCurrent(attempt);
    setPhase('analyzing');

    // Live coaching first; any failure falls back to the existing local/agent path.
    let live: LiveCoachResponse | null = null;
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
    if (runId.current !== myRun) return; // a newer attempt or leaving the screen superseded this one

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
      void seq.run(live, { narration });
      return;
    }

    const response = await analyzeAttempt(attempt, history);
    if (runId.current !== myRun) return;
    setCoach(response);
    setPhase('feedback');
    if (narration) speech.speak(`${response.observation} ${response.nextCue}`);
  }

  function readAloud() {
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

  /* ---------- Result sheet: stays mounted briefly so it can slide back down ---------- */
  const sheetOpen = (phase === 'analyzing' || phase === 'feedback') && current !== null;
  const [sheetMounted, setSheetMounted] = useState(false);
  const lastResult = useRef<{ attempt: Attempt; coach: CoachResponse | null } | null>(null);
  if (sheetOpen && current) lastResult.current = { attempt: current, coach };
  useEffect(() => {
    if (sheetOpen) return setSheetMounted(true);
    const t = setTimeout(() => setSheetMounted(false), SHEET_EXIT_MS);
    return () => clearTimeout(t);
  }, [sheetOpen]);

  const micLine =
    mic.status === 'denied' ? (
      <span className="ob-status ob-status--warn" role="alert">
        <TriangleAlert size={16} aria-hidden="true" /> Microphone blocked · allow it in site settings
      </span>
    ) : recording ? (
      <span className="ob-status">Recording · {mic.elapsed.toFixed(1)} s</span>
    ) : (
      <span className="ob-status">{mic.status === 'ready' ? 'Microphone ready' : 'Mic starts when you record'}</span>
    );

  const graphBody = (
    <div className="lp-tile-body">
      <VowelGraph
        sound={plan.sound}
        point={tracking.point}
        trace={tracking.trace}
        tracking={tracking.tracking}
        statusLabel={trackingLabel(tracking.status, mic.status)}
        holdSec={tracking.holdSec}
        hidden={!assistanceOn}
      />
    </div>
  );

  const guideBody = (
    <div className="lp-tile-body">
      <MouthReference ref={mouthRef} sound={plan.sound} view={refView} slow={slow} />
      <div className="lp-overlay lp-overlay--bl">
        <p className="ob-label navy">{s.tongue}</p>
        <p className="ob-fine">{s.lips}</p>
      </div>
      <button
        type="button"
        className="lp-overlay lp-overlay--tl ob-pill lp-slow"
        aria-pressed={slow}
        title={slow ? 'Normal speed' : 'Slow motion'}
        onClick={() => setSlow((v) => !v)}
      >
        <Snail size={16} aria-hidden="true" />
        Slow
      </button>
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
    </div>
  );

  const mirrorBody = (
    <div className={`lp-tile-body lp-mirror ${camera ? 'is-on' : ''}`}>
      {camera ? (
        <>
          <CameraTile enabled onVideoElement={setVideoEl} lipStatus={lip.status} />
          <span className="lp-overlay lp-overlay--bl lp-chip">Visible lips only · not saved</span>
          <button type="button" className="lp-overlay lp-overlay--tr ob-pill" onClick={() => setCamera(false)}>
            <VideoOff size={16} aria-hidden="true" />
            <span style={{ marginLeft: 6 }}>Turn off</span>
          </button>
        </>
      ) : (
        <div className="lp-empty">
          <span className="ob-cam-icon" aria-hidden="true">
            <Video size={22} />
          </span>
          <p className="ob-label">See your lips while you practice</p>
          <p className="ob-fine">The camera stays off unless you turn it on, and nothing is saved.</p>
          <button type="button" className="btn btn--sm" onClick={() => setCamera(true)}>
            <Video size={16} aria-hidden="true" /> Turn on mirror
          </button>
        </div>
      )}
    </div>
  );

  const viewOptions = [
    ...(compact ? [{ id: 'graph' as View, label: 'Your sound' }] : []),
    { id: 'guide' as View, label: 'Mouth guide' },
    { id: 'mirror' as View, label: 'Mirror' },
  ];

  return (
    <OnboardingFrame
      step={stepIndex + 1}
      total={LESSON_STEPS.length}
      progressLabel="Lesson progress"
      stageKey="practice"
      width={1040}
      className="lp"
      onClose={{ label: 'Pause or finish', onClick: () => navigate('/summary') }}
      footer={
        <>
          <button type="button" className="ob-text-btn lp-listen" onClick={playReference} disabled={busy}>
            <Volume2 size={18} aria-hidden="true" />
            {referencePlaying ? 'Playing…' : 'Hear example'}
          </button>
          <span role="status" style={{ fontSize: 12, opacity: 0.65 }}>
            Live sync {syncStatus === 'ready' ? 'on' : 'off'}
          </span>
          <button
            type="button"
            className={`ob-cta ${recording ? 'ob-cta--stop' : ''}`}
            onClick={recording ? stopRecording : startRecording}
            disabled={phase === 'analyzing' || mic.status === 'unsupported'}
          >
            {recording ? <Square size={16} fill="currentColor" aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
            {recording ? `Stop · ${mic.elapsed.toFixed(1)} s` : 'Record'}
          </button>
        </>
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
            onReadAloud={readAloud}
            captionsNode={captions && liveResp ? <TeacherCaptions speech={seq.speech} text={liveResp.caption} /> : null}
            onTryAgain={startRecording}
            onLessHelp={() => navigate('/summary')}
          />
        )
      }
    >
      <div className="lp-head">
        <StepHeading
          eyebrow={`Lesson 1 · ${LESSON_STEPS[stepIndex]}`}
          title={
            <>
              Find your {s.spelled} <span className="navy">{s.ipa}</span>
            </>
          }
          hint={recording ? 'Keep a comfortable sound. Stop when you’re ready.' : `Take a breath and hold “${s.spelled}” for about 3 seconds.`}
        />
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
          disabled={busy}
          onChange={(id) => {
            updatePlan({ sound: id });
            resetForSound();
          }}
        />
      </div>

      <div className="lp-tiles">
        {!compact && (
          <section className="lp-tile" aria-label="Your sound">
            <div className="lp-tile-head">
              <h2 className="ob-label">Your sound</h2>
              <label className="row fine" style={{ gap: 10 }}>
                Show target
                <Switch label="Show target" checked={assistanceOn} onChange={(on) => updatePlan({ assistance: on ? 'cue-target' : 'none' })} />
              </label>
            </div>
            {graphBody}
            <div className="lp-tile-foot">
              <AmplitudeMeter levels={mic.levels} active={recording} />
              {micLine}
            </div>
          </section>
        )}

        <section className="lp-tile" aria-label={sideView === 'mirror' ? 'Mirror' : sideView === 'guide' ? 'Mouth guide' : 'Your sound'}>
          <div className="lp-tile-head">
            <Segmented className="lp-views" label="View" options={viewOptions} value={sideView} onChange={setView} />
          </div>
          {sideView === 'graph' ? graphBody : sideView === 'guide' ? guideBody : null}
          {/* The mirror stays mounted (off-screen when not shown) so the camera and lip tracking keep running
              while the mouth guide is up for the teacher sequence. */}
          <div
            style={
              sideView === 'mirror'
                ? { display: 'contents' }
                : { position: 'fixed', left: -9999, top: 0, width: 320, height: 240, opacity: 0, pointerEvents: 'none' }
            }
            aria-hidden={sideView === 'mirror' ? undefined : true}
          >
            {mirrorBody}
          </div>
          {compact ? (
            <div className="lp-tile-foot">
              <AmplitudeMeter levels={mic.levels} active={recording} />
              {micLine}
            </div>
          ) : (
            <div className="lp-tile-foot">
              <span className="ob-status">
                <ScanFace size={16} aria-hidden="true" /> “{s.spelled}” · {s.cue}
              </span>
            </div>
          )}
        </section>
      </div>
    </OnboardingFrame>
  );
}

function ResultSheet({
  attempt,
  coach,
  leaving,
  feeling,
  onFeeling,
  onReplay,
  onReadAloud,
  onTryAgain,
  onLessHelp,
  captionsNode,
}: {
  captionsNode?: React.ReactNode;
  attempt: Attempt;
  coach: CoachResponse | null;
  leaving: boolean;
  feeling: Attempt['feeling'];
  onFeeling: (id: NonNullable<Attempt['feeling']>) => void;
  onReplay?: () => void;
  onReadAloud: () => void;
  onTryAgain: () => void;
  onLessHelp: () => void;
}) {
  const usable = attempt.quality === 'usable';
  return (
    <section
      className={`lp-sheet ${usable ? 'lp-sheet--ok' : 'lp-sheet--warn'} ${leaving ? 'is-leaving' : ''}`}
      aria-label="Result"
      aria-busy={!coach}
    >
      <div className="lp-sheet-inner">
        <div className="lp-sheet-head">
          <span className="lp-sheet-icon" aria-hidden="true">
            {usable ? <CheckCircle2 size={26} /> : <TriangleAlert size={24} />}
          </span>
          <div className="grow">
            <h2 className="lp-sheet-title">
              {usable ? `Got it · ${attempt.usableVoicedSec.toFixed(1)} s of usable voice` : 'Let’s try that capture again'}
            </h2>
            <p className="ob-fine">
              {usable ? 'This describes the sound only. It isn’t a pronunciation score.' : 'That’s a capture issue, not a mistake.'}
            </p>
          </div>
          <button type="button" className="ob-pill" aria-label="Read feedback aloud" title="Read feedback aloud" onClick={onReadAloud} disabled={!coach}>
            <Volume2 size={17} aria-hidden="true" />
          </button>
        </div>

        <div className="lp-coach" aria-live="polite">
          {coach ? (
            <>
              <p>{coach.observation}</p>
              {coach.nextCue && <p className="lp-cue">{coach.nextCue}</p>}
              {captionsNode}
            </>
          ) : (
            <p className="ob-fine">Reading your attempt…</p>
          )}
        </div>

        <div className="lp-sheet-tools">
          <button type="button" className="ob-text-btn" onClick={onReplay} disabled={!onReplay}>
            <Play size={16} aria-hidden="true" /> Replay mine
          </button>
          {usable && (
            <div className="lp-feel">
              <span className="ob-fine">How did that feel?</span>
              <Segmented label="How did that feel?" options={[...FEELINGS]} value={feeling} onChange={onFeeling} />
            </div>
          )}
        </div>

        <div className="lp-sheet-actions">
          <button type="button" className="ob-text-btn" onClick={onLessHelp}>
            Try with less help
          </button>
          <button type="button" className="ob-cta" onClick={onTryAgain} disabled={!coach}>
            <Mic size={18} aria-hidden="true" /> Try again
          </button>
        </div>
      </div>
    </section>
  );
}
