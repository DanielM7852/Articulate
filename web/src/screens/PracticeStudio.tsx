import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, ScanFace, Snail, Square, TriangleAlert, Video, VideoOff, Volume2, X } from 'lucide-react';
import { ResultSheet } from '../components/ResultSheet';
import { CaptionBar, useNarration } from '../components/Narration';
import { OnboardingFrame, Segmented, StepHeading, Switch } from '../components/Onboarding';
import { AmplitudeMeter, CameraTile, LESSON_STEPS } from '../components/practice';
import { VowelGraph } from '../components/VowelGraph';
import { MouthReference, cueForSound, type MouthView } from '../components/MouthReference';
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

/** Keeps the sheet mounted long enough for its own exit motion to finish. */
const SHEET_EXIT_MS = 260;

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
  const { plan, updatePlan, attempts, addAttempt, updateAttempt, camera, setCamera, narration: readAloud } = useAppState();
  const [phase, setPhase] = useState<Phase>('ready');
  const [current, setCurrent] = useState<Attempt | null>(null);
  const [coach, setCoach] = useState<CoachResponse | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [referencePlaying, setReferencePlaying] = useState(false);
  const replayRef = useRef<HTMLAudioElement | null>(null);

  // The graph is the main view. The 3D guide or the mirror open beside it on request;
  // on phones there is one pane and a switcher.
  const compact = useMediaQuery('(max-width: 720px)');
  const [view, setView] = useState<View>('graph');
  const [refView, setRefView] = useState<MouthView>('front');
  const [slow, setSlow] = useState(false);

  // Live F1/F2 on the same microphone stream; it runs whenever the mic is open.
  const tracking = useVowelTracking(mic.stream, TARGETS[plan.sound]);

  const s = SOUNDS[plan.sound];

  // The guide's instruction for this sound, read aloud when the sound changes
  // and shown as text while recording (never spoken over the microphone).
  const narration = useNarration(speech);
  const phaseRef = useRef<Phase>('ready');
  phaseRef.current = phase;
  useEffect(() => {
    if (phase === 'ready') narration.say(`Say “${s.spelled}” as in “${s.example}”. Hold it for about 3 seconds.`);
    else if (phase === 'recording') narration.show('Keep a comfortable sound. Stop when you’re ready.');
    else narration.show(null);
  }, [phase, s.spelled, s.example, narration.say, narration.show]);
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
    setPhase('ready');
    setCurrent(null);
    setCoach(null);
  }

  async function startRecording() {
    speech.stop(); // playback must stop before the learner is recorded
    replayRef.current?.pause();
    setReferencePlaying(false);
    setCoach(null);
    const ok = await mic.beginRecording();
    if (!ok) return;
    tracking.beginWindow();
    setPhase('recording');
  }

  async function stopRecording() {
    const target = tracking.endWindow();
    const summary = await mic.endRecording();
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingUrl(summary.recordingUrl);
    const attempt: Attempt = {
      attemptId: crypto.randomUUID(),
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
    const response = await analyzeAttempt(attempt, history);
    setCoach(response);
    setPhase('feedback');
    if (readAloud) speech.speak(`${response.observation} ${response.nextCue}`);
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
      <MouthReference cue={cueForSound(plan.sound)} view={refView} slow={slow} />
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
        <CameraTile enabled />
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

  return (
    <OnboardingFrame
      step={stepIndex + 1}
      total={LESSON_STEPS.length}
      progressLabel="Lesson progress"
      stageKey="practice"
      className="lp ob-content--full"
      onClose={{ label: 'Pause or finish', onClick: () => navigate('/summary') }}
      caption={<CaptionBar text={narration.caption} />}
      footer={
        <>
          <button type="button" className="ob-text-btn lp-listen" onClick={playReference} disabled={busy}>
            <Volume2 size={18} aria-hidden="true" />
            {referencePlaying ? 'Playing…' : 'Hear example'}
          </button>
          <div className="lp-meter" aria-hidden={!recording && !micWarning}>
            {micWarning ? (
              <span className="ob-status ob-status--warn" role="alert">
                <TriangleAlert size={16} aria-hidden="true" /> {micWarning}
              </span>
            ) : (
              recording && <AmplitudeMeter levels={mic.levels} active />
            )}
          </div>
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
            onReadAloud={() => coach && speech.speak(`${coach.observation} ${coach.nextCue}`, { force: true })}
            onTryAgain={startRecording}
            onOnMyOwn={() => navigate('/summary')}
            onDismiss={resetForSound}
          />
        )
      }
    >
      <div className="lp-head">
        <StepHeading
          title={
            <>
              Find your {s.spelled} <span className="navy">{s.ipa}</span>
            </>
          }
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

      <div className={`lp-stage ${solo ? 'is-solo' : ''}`}>
        {!compact && graphPane}
        {!solo && sidePane}
        {compact && sidePane}
      </div>
    </OnboardingFrame>
  );
}
