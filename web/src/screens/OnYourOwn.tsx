import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Mic, Square, TriangleAlert, X } from 'lucide-react';
import { ResultSheet } from '../components/ResultSheet';
import { CaptionBar, useNarration } from '../components/Narration';
import { AccessToggles, OnboardingFrame, Segmented, StepHeading } from '../components/Onboarding';
import { AmplitudeMeter, LESSON_STEPS } from '../components/practice';
import { useMicrophone } from '../audio/useMicrophone';
import { useSpeech } from '../audio/useSpeech';
import { analyzeAttempt, type CoachResponse } from '../services/coach';
import { attemptsFor, useAppState } from '../state/AppState';
import { SOUNDS, SOUND_ORDER, type Attempt } from '../state/types';

/**
 * On your own: the same studio with the cues taken away. No graph, no target,
 * no mouth guide; one big word to say. Captions, the written instruction and
 * the stop control stay. Results open in the same floating sheet as guided
 * practice and are always reported separately from guided attempts.
 */
type Phase = 'ready' | 'recording' | 'analyzing' | 'feedback';
/** The sustained vowel, or the vowel inside its example word. */
type Say = 'sound' | 'word';

const SHEET_EXIT_MS = 260;

export default function OnYourOwn() {
  const navigate = useNavigate();
  const mic = useMicrophone();
  const speech = useSpeech();
  const { plan, updatePlan, attempts, addAttempt, updateAttempt, narration: readAloud, preferences } = useAppState();
  const [phase, setPhase] = useState<Phase>('ready');
  const [say, setSay] = useState<Say>('sound');
  const [current, setCurrent] = useState<Attempt | null>(null);
  const [coach, setCoach] = useState<CoachResponse | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);

  const s = SOUNDS[plan.sound];
  const word = say === 'sound' ? s.spelled : s.example;
  const recording = phase === 'recording';
  const busy = recording || phase === 'analyzing';

  const narration = useNarration(speech);
  useEffect(() => {
    if (phase === 'ready')
      narration.say(
        say === 'sound'
          ? `On your own now. Say “${s.spelled}” as in “${s.example}” and hold it for about 3 seconds.`
          : `Now inside a word. Say “${s.example}”, and let the “${s.spelled}” ring.`,
      );
    else if (phase === 'recording') narration.show('No cues this time. Stop when you’re ready.');
    else narration.show(null);
  }, [phase, say, s.spelled, s.example, narration.say, narration.show]);

  const history = useMemo(() => attemptsFor(attempts, plan.sound), [attempts, plan.sound]);
  const guidedBest = useMemo(
    () =>
      history
        .filter((a) => a.kind === 'guided' && a.quality === 'usable')
        .reduce<number | null>((m, a) => (m === null || a.usableVoicedSec > m ? a.usableVoicedSec : m), null),
    [history],
  );

  useEffect(() => () => {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  }, [recordingUrl]);

  function resetForSound() {
    setPhase('ready');
    setCurrent(null);
    setCoach(null);
  }

  async function startRecording() {
    speech.stop();
    setCoach(null);
    const ok = await mic.beginRecording();
    if (!ok) return;
    setPhase('recording');
  }

  async function stopRecording() {
    const summary = await mic.endRecording();
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingUrl(summary.recordingUrl);
    const attempt: Attempt = {
      attemptId: crypto.randomUUID(),
      sound: plan.sound,
      kind: 'independent',
      assistance: 'none',
      startedAt: Date.now(),
      durationSec: summary.durationSec,
      usableVoicedSec: summary.usableVoicedSec,
      timeInTargetSec: null,
      longestHoldSec: null,
      quality: summary.quality,
      qualityReason: summary.qualityReason,
      recognizedText: null,
    };
    addAttempt(attempt);
    setCurrent(attempt);
    setPhase('analyzing');
    const response = await analyzeAttempt(attempt, history, { plan, preferences });
    if (response.plan) updatePlan({ pace: response.plan.pace, assistance: response.plan.assistance });
    setCoach(response);
    setPhase('feedback');
    if (readAloud) speech.speak(`${response.observation} ${response.nextCue}`);
  }

  function replayRecording() {
    if (!recordingUrl) return;
    speech.stop();
    new Audio(recordingUrl).play().catch(() => undefined);
  }

  function backToCues() {
    updatePlan({ assistance: 'cue-target' });
    navigate('/practice');
  }

  function nextSound() {
    const next = SOUND_ORDER[(SOUND_ORDER.indexOf(plan.sound) + 1) % SOUND_ORDER.length];
    updatePlan({ sound: next, assistance: 'cue-target' });
    navigate('/practice');
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

  const micWarning =
    mic.status === 'denied'
      ? 'Microphone blocked · allow it in site settings'
      : mic.status === 'unsupported'
        ? 'Microphone unsupported in this browser'
        : null;

  return (
    <OnboardingFrame
      step={LESSON_STEPS.length}
      total={LESSON_STEPS.length}
      bar="none"
      stageKey="own"
      className="lp ob-content--full"
      footer={
        <>
          <button type="button" className="ob-text-btn lp-listen" onClick={backToCues} disabled={busy}>
            <ChevronLeft size={18} aria-hidden="true" />
            Back to cues
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
            mode="independent"
            compare={guidedBest}
            attempt={lastResult.current.attempt}
            coach={lastResult.current.coach}
            leaving={!sheetOpen}
            feeling={attempts.find((a) => a.attemptId === lastResult.current?.attempt.attemptId)?.feeling}
            onFeeling={(id) => updateAttempt(lastResult.current!.attempt.attemptId, { feeling: id })}
            onReplay={recordingUrl ? replayRecording : undefined}
            onReadAloud={() => coach && speech.speak(`${coach.observation} ${coach.nextCue}`, { force: true })}
            onTryAgain={startRecording}
            onNextSound={nextSound}
            onDismiss={resetForSound}
          />
        )
      }
    >
      <div className="lp-head">
        <button type="button" className="ob-icon-btn" aria-label="Finish session" title="Finish session" onClick={() => navigate('/')}>
          <X size={22} aria-hidden="true" />
        </button>
        <StepHeading
          title={
            <>
              On your own · {s.spelled} <span className="navy">{s.ipa}</span>
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
        <AccessToggles />
        <button type="button" className="ob-text-btn" onClick={() => navigate('/match')} disabled={busy}>
          Advanced · head
        </button>
      </div>

      <div className={`own-stage ${recording ? 'is-recording' : ''}`}>
        <div>
          <p className="own-word" aria-live="polite">
            {word}
          </p>
          <p className="own-sub">
            {say === 'sound' ? (
              <>
                as in <span className="serif">{s.example}</span> · hold it for about 3 seconds
              </>
            ) : (
              <>
                let the <span className="serif">{s.spelled}</span> ring inside the word
              </>
            )}
          </p>
        </div>
        <Segmented
          className="lp-overlay lp-overlay--tl lp-mini"
          label="What to say"
          options={[
            { id: 'sound' as Say, label: `Sound · ${s.spelled}` },
            { id: 'word' as Say, label: `Word · ${s.example}` },
          ]}
          value={say}
          disabled={busy}
          onChange={setSay}
        />
        <CaptionBar className="cap-card" text={narration.caption} paused={narration.paused} onToggle={narration.toggle} />
      </div>
    </OnboardingFrame>
  );
}
