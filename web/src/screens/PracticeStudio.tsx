import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Info, Mic, Play, Square, Type, Volume2, VolumeX } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { LessonHeader } from '../components/LessonHeader';
import { AmplitudeMeter, CameraTile, LessonSteps, ReferencePanel, SoundPanel, type GraphMode } from '../components/practice';
import { Badge, Button, ChoiceButton } from '../components/ui';
import { useMicrophone } from '../audio/useMicrophone';
import { useSpeech } from '../audio/useSpeech';
import { analyzeAttempt, assistanceLabel, type CoachResponse } from '../services/coach';
import { attemptsFor, useAppState } from '../state/AppState';
import { SOUNDS, type Attempt } from '../state/types';

/**
 * Practice Studio: one screen, explicit states.
 *   ready     -> preview the reference, nothing recording
 *   recording -> example and narration stopped, mic capturing
 *   analyzing -> attempt saved, coach response pending
 *   feedback  -> measured summary + grounded coach response + retry choices
 * Scoring never waits on the coach; the summary renders before the response arrives.
 */
type Phase = 'ready' | 'recording' | 'analyzing' | 'feedback';

export default function PracticeStudio() {
  const navigate = useNavigate();
  const mic = useMicrophone();
  const speech = useSpeech();
  const { plan, updatePlan, attempts, addAttempt, updateAttempt, camera, narration, audio, setAudio } = useAppState();
  const [phase, setPhase] = useState<Phase>('ready');
  const [current, setCurrent] = useState<Attempt | null>(null);
  const [coach, setCoach] = useState<CoachResponse | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [referencePlaying, setReferencePlaying] = useState(false);
  const replayRef = useRef<HTMLAudioElement | null>(null);

  const s = SOUNDS[plan.sound];
  const history = useMemo(() => attemptsFor(attempts, plan.sound), [attempts, plan.sound]);
  const guidedCount = history.filter((a) => a.kind === 'guided' && a.quality === 'usable').length;
  const stepIndex = phase === 'feedback' ? (guidedCount > 1 ? 3 : 2) : guidedCount > 0 ? 3 : 1;
  const assistanceOn = plan.assistance !== 'none';

  const graphMode: GraphMode = !assistanceOn ? 'hidden' : phase === 'recording' ? 'live' : phase === 'feedback' ? 'review' : 'preview';

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
    if (ok) setPhase('recording');
  }

  async function stopRecording() {
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
      // Filled by the formant measurement service once connected.
      timeInTargetSec: null,
      longestHoldSec: null,
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
    if (narration) speech.speak(`${response.observation} ${response.nextCue}`);
  }

  function playReference() {
    setReferencePlaying(true);
    speech.speak(`${s.spelled}. ${s.spelled}. As in, ${s.example}.`, { force: true, rate: 0.8 });
  }

  function readAloud() {
    speech.speak(`${s.spelled}, as in ${s.example}. Breathe comfortably and hold ${s.spelled} for about three seconds.`, {
      force: true,
    });
  }

  function replayRecording() {
    if (!recordingUrl) return;
    speech.stop();
    const el = new Audio(recordingUrl);
    replayRef.current = el;
    el.play().catch(() => undefined);
  }

  const recording = phase === 'recording';
  const lastTwo = history.filter((a) => a.quality === 'usable').slice(-4);

  return (
    <AppShell
      context="Practice studio"
      inLesson
      footerNote="Live capture · Formant tracking and 3D reference connect through integration slots."
    >
      <div className="page--tight">
        <LessonHeader
          eyebrow="Lesson 01 / Sustained vowels"
          disabled={recording || phase === 'analyzing'}
          onSoundChange={resetForSound}
        />
        <LessonSteps current={stepIndex} />

        <div className="grid-2">
          <SoundPanel
            sound={plan.sound}
            mode={graphMode}
            stream={mic.stream}
            title={phase === 'ready' ? 'Your voice → sound graph' : 'Your recorded sound'}
            badge={
              recording ? (
                <Badge live>Recording · {mic.elapsed.toFixed(1)} s</Badge>
              ) : phase === 'feedback' && current ? (
                <Badge>Last attempt · {current.durationSec.toFixed(1)} s</Badge>
              ) : (
                <Badge>Preview · not recording</Badge>
              )
            }
            footer={
              <>
                <p className="fine">
                  {recording
                    ? 'The hold ring fills only while valid sound stays inside the target.'
                    : 'In a recording, the hold ring fills only for valid measurements inside the target.'}
                </p>
                <div className="row" style={{ borderTop: '1px solid var(--color-line)', paddingTop: 12, gap: 16 }}>
                  <div className="stack gap-4 grow">
                    <p className="strong" style={{ fontSize: 12, color: mic.status === 'denied' ? 'var(--color-warn)' : 'var(--color-success)' }}>
                      ● {recording ? 'Recording · capturing' : mic.status === 'denied' ? 'Microphone blocked' : mic.status === 'ready' ? 'Microphone ready' : 'Microphone starts when you record'}
                    </p>
                    <div className="row" style={{ gap: 10 }}>
                      <AmplitudeMeter levels={mic.levels} active={recording} />
                      <span className="fine">Amplitude</span>
                    </div>
                  </div>
                  <CameraTile enabled={camera} compact />
                </div>
              </>
            }
          />
          <ReferencePanel sound={plan.sound} status={referencePlaying ? 'Playing example' : recording ? 'Paused' : `${s.ipa} illustration`} />
        </div>

        <section className="prompt-bar" aria-label="Prompt and recording">
          <div className="stack gap-8">
            <p style={{ fontSize: 12, color: 'var(--color-navy-mist)', letterSpacing: '0.04em' }}>TEXT TO READ</p>
            <p className="prompt-word">
              {s.spelled} · as in {s.example}
            </p>
            <p style={{ fontSize: 12, color: 'var(--color-navy-mist)' }}>
              {recording ? 'Keep a comfortable sound. Stop when ready.' : `Take a comfortable breath. Hold “${s.spelled}” for about 3 seconds.`}
            </p>
          </div>
          <div className="stack gap-10">
            <div className="btn-row" style={{ gap: 8 }}>
              <Button size="sm" icon={<Type size={17} aria-hidden="true" />} onClick={readAloud} disabled={recording}>
                Read text aloud
              </Button>
              <Button size="sm" icon={<Play size={17} aria-hidden="true" />} onClick={playReference} disabled={recording}>
                Watch example
              </Button>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <Button size="sm" icon={<Volume2 size={17} aria-hidden="true" />} onClick={playReference} disabled={recording}>
                Hear example
              </Button>
              <span style={{ fontSize: 12, color: 'var(--color-navy-mist)' }} aria-live="polite">
                {recording ? 'Playback paused' : referencePlaying ? 'Example playing' : 'Reference stopped'}
              </span>
            </div>
          </div>
          <div className="stack gap-8" style={{ alignItems: 'flex-end' }}>
            {recording ? (
              <Button icon={<Square size={17} aria-hidden="true" />} onClick={stopRecording}>
                Stop · {mic.elapsed.toFixed(1)} s
              </Button>
            ) : (
              <Button
                icon={<Mic size={17} aria-hidden="true" />}
                onClick={startRecording}
                disabled={phase === 'analyzing' || mic.status === 'unsupported'}
              >
                {phase === 'feedback' ? 'Record again' : 'Record your voice'}
              </Button>
            )}
            <p style={{ fontSize: 12, color: 'var(--color-navy-mist)', textAlign: 'right' }}>
              {recording ? 'Example and narration paused while recording.' : 'Recording starts only after example playback stops.'}
            </p>
          </div>
        </section>

        {mic.status === 'denied' && (
          <div className="card card--warn" role="alert" style={{ padding: 18, gap: 6 }}>
            <p className="strong" style={{ color: 'var(--color-warn)', fontSize: 13 }}>
              Microphone access is blocked
            </p>
            <p className="small ink">Allow microphone access in your browser’s site settings, then select Record again. Nothing was scored.</p>
          </div>
        )}

        {phase === 'ready' && (
          <div className="practice-row">
            <div className="card" style={{ padding: 20, gap: 12 }}>
              <p className="eyebrow">What you said</p>
              <p className="ink" style={{ fontSize: 14 }}>
                No attempt yet.
              </p>
              <p className="fine">Recognized text appears here after an attempt.</p>
            </div>
            <div className="card card--soft" style={{ padding: 22, gap: 12 }}>
              <div className="card-head">
                <p className="eyebrow">Next step</p>
                <Badge tone="neutral">{guidedCount ? `${guidedCount} guided ${guidedCount === 1 ? 'try' : 'tries'}` : 'No attempt'}</Badge>
              </div>
              <p className="ink" style={{ fontSize: 14 }}>
                Look at the reference, then try “{s.spelled}” on your own.
              </p>
              <div className="btn-row">
                <ChoiceButton selected={!assistanceOn} onClick={() => updatePlan({ assistance: 'none' })}>
                  Hide cues
                </ChoiceButton>
                <ChoiceButton selected={assistanceOn} onClick={() => updatePlan({ assistance: 'cue-target' })}>
                  Keep guidance
                </ChoiceButton>
                <span className="fine">Narration {narration ? 'on' : 'off'}</span>
              </div>
            </div>
          </div>
        )}

        {recording && (
          <div className="practice-row">
            <div className="card" style={{ padding: 20, gap: 12 }}>
              <div className="card-head">
                <p className="eyebrow">Recording</p>
                <Badge live>{mic.elapsed.toFixed(1)} s</Badge>
              </div>
              <p className="ink" style={{ fontSize: 14 }}>
                Hold a comfortable “{s.spelled}”.
              </p>
              <p className="fine">What you said: shown when you stop.</p>
            </div>
            <div className="card card--warn" style={{ padding: 20, gap: 10 }}>
              <div className="card-head">
                <p className="eyebrow">If the cursor fades</p>
                <Badge tone="warn">Capture tip</Badge>
              </div>
              <p className="ink" style={{ fontSize: 14, fontWeight: 500 }}>
                Move closer to the microphone.
              </p>
              <p className="fine">Silence pauses progress; it is never counted as a failure.</p>
              <p className="fine" style={{ color: 'var(--color-warn)' }}>
                Amplitude checks capture, not speech quality.
              </p>
            </div>
          </div>
        )}

        {(phase === 'analyzing' || phase === 'feedback') && current && (
          <>
            <div className="practice-row">
              <div className="card" style={{ padding: 20, gap: 12 }}>
                <p className="eyebrow">What you said</p>
                <p className="serif ink" style={{ fontSize: 28 }}>
                  {current.quality === 'unclear' ? '…' : current.recognizedText ? `“${current.recognizedText}”` : `“${s.spelled}”`}
                </p>
                <p className="fine">
                  {current.quality === 'unclear'
                    ? 'Nothing clear enough to show. That is a capture issue, not a mistake.'
                    : current.recognizedText
                      ? 'Recognized from your attempt.'
                      : 'Prompted text. Speech recognition connects with the measurement service.'}
                </p>
              </div>
              <div className="card" style={{ padding: 22 }}>
                <div className="card-head">
                  <p className="eyebrow">{current.quality === 'usable' ? 'A usable guided attempt' : 'An unclear capture'}</p>
                  <Badge tone={current.quality === 'usable' ? 'success' : 'warn'}>
                    {current.quality === 'usable' ? 'Measured in your browser' : 'Not scored'}
                  </Badge>
                </div>
                <div className="metrics">
                  <Metric value={`${current.usableVoicedSec.toFixed(1)} s`} label="Usable voiced duration" />
                  <Metric value={current.timeInTargetSec != null ? `${current.timeInTargetSec.toFixed(1)} s` : '—'} label="Time in target region" />
                  <Metric value={current.longestHoldSec != null ? `${current.longestHoldSec.toFixed(1)} s` : '—'} label="Longest stable hold" />
                </div>
                <p className="fine">
                  These describe this acoustic task only, not overall pronunciation, intelligibility, or a speech level.
                  Target metrics appear when formant tracking is connected.
                </p>
                <div className="btn-row">
                  <Button size="sm" icon={<Play size={17} aria-hidden="true" />} onClick={replayRecording} disabled={!recordingUrl}>
                    Replay your recording
                  </Button>
                  <Button size="sm" icon={<Volume2 size={17} aria-hidden="true" />} onClick={playReference}>
                    Play reference
                  </Button>
                  <span className="fine">One at a time</span>
                </div>
              </div>
            </div>

            <section className="card" aria-labelledby="coach-h" aria-busy={phase === 'analyzing'}>
              <div className="card-head">
                <div className="stack gap-4">
                  <p className="eyebrow">AI coach analysis</p>
                  <h2 id="coach-h" className="card-title">
                    Coach feedback
                  </h2>
                </div>
                <Badge tone={phase === 'analyzing' ? 'neutral' : 'info'}>
                  {phase === 'analyzing' ? 'Analyzing…' : coach?.source === 'agent' ? 'Coach agent' : 'Grounded in measured fields'}
                </Badge>
              </div>
              <div className="btn-row">
                <Button
                  size="sm"
                  icon={<Play size={17} aria-hidden="true" />}
                  disabled={!coach}
                  onClick={() => coach && speech.speak(`${coach.observation} ${coach.nextCue}`, { force: true })}
                >
                  Play AI advice
                </Button>
                <Button
                  size="sm"
                  aria-pressed={!audio}
                  icon={audio ? <VolumeX size={17} aria-hidden="true" /> : <Volume2 size={17} aria-hidden="true" />}
                  onClick={() => {
                    speech.stop();
                    setAudio(!audio);
                  }}
                >
                  {audio ? 'Mute AI' : 'Unmute AI'}
                </Button>
                <span className="fine grow">The written response below is always shown, whether or not audio plays.</span>
              </div>
              <div className="coach-body" aria-live="polite">
                <p className="eyebrow">Analysis of the captured sound</p>
                {coach ? (
                  <div className="coach-text">
                    <p>{coach.observation}</p>
                    <p className="navy" style={{ fontWeight: 500 }}>
                      {coach.nextCue}
                    </p>
                  </div>
                ) : (
                  <p className="small">Reading the measured fields for this attempt…</p>
                )}
                {coach && (
                  <p className="fine row" style={{ gap: 6 }}>
                    <Info size={14} aria-hidden="true" /> Evidence: {coach.evidence.join(' · ')}
                  </p>
                )}
              </div>
            </section>

            {phase === 'feedback' && (
              <div className="practice-row practice-row--even">
                <div className="card card--soft" style={{ padding: 22, gap: 12 }}>
                  <p className="eyebrow">Notice, then explore</p>
                  <p className="ink" style={{ fontSize: 14 }}>
                    {current.quality === 'usable'
                      ? 'That describes the sound pattern, not where your tongue was.'
                      : 'Let’s repair the capture first. Nothing was counted.'}
                  </p>
                  <p className="navy" style={{ fontSize: 14, fontWeight: 500 }}>
                    For the next try: {s.cue.toLowerCase()} Choose one cue to explore comfortably.
                  </p>
                  <div className="btn-row">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        updatePlan({ assistance: 'cue-target' });
                        startRecording();
                      }}
                    >
                      Retry with guidance
                    </Button>
                    <Button size="sm" icon={<ArrowRight size={15} aria-hidden="true" />} onClick={() => navigate('/summary')}>
                      Try with less guidance
                    </Button>
                  </div>
                </div>
                <div className="card" style={{ padding: 22, gap: 12 }}>
                  <div className="row row--between">
                    <p className="eyebrow">Attempt history</p>
                    <p className="fine">Usable attempts only</p>
                  </div>
                  <div>
                    {lastTwo.length === 0 && <p className="fine">No usable attempts yet.</p>}
                    {lastTwo.map((a) => (
                      <div key={a.attemptId} className="history-row">
                        <span className="ink">{a.kind === 'baseline' ? 'First try' : a.kind === 'independent' ? 'Independent' : 'Guided try'}</span>
                        <span className="fine">{a.kind === 'baseline' ? 'No cues · baseline' : assistanceLabel(a.assistance)}</span>
                        <span className="navy">{a.usableVoicedSec.toFixed(1)} s usable</span>
                      </div>
                    ))}
                  </div>
                  <p className="ink" style={{ fontSize: 13 }} id="feel-h">
                    How did that feel?
                  </p>
                  <div className="btn-row" role="group" aria-labelledby="feel-h">
                    {(
                      [
                        ['too-hard', 'Too hard'],
                        ['okay', 'Okay'],
                        ['ready', 'Ready for more'],
                      ] as const
                    ).map(([id, label]) => (
                      <ChoiceButton
                        key={id}
                        selected={attempts.find((a) => a.attemptId === current.attemptId)?.feeling === id}
                        onClick={() => {
                          updateAttempt(current.attemptId, { feeling: id });
                          if (id === 'ready') updatePlan({ assistance: 'target-only' });
                        }}
                      >
                        {label}
                      </ChoiceButton>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        <div className="row row--top wrap" style={{ borderTop: '1px solid var(--color-line)', paddingTop: 14, gap: 24 }}>
          <p className="navy strong" style={{ fontSize: 12, width: 330 }}>
            Acoustic match is not a pronunciation score.
          </p>
          <p className="fine grow">
            Target source: illustrative {s.ipa} preset, not a universal or speaker-calibrated target. Reference: schematic
            articulatory illustration, not measured anatomy. Microphone calibration is separate.
          </p>
        </div>
      </div>
    </AppShell>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="stack gap-4">
      <p className="metric-value">{value}</p>
      <p className="fine">{label}</p>
    </div>
  );
}
