import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EyeOff, Mic, Play, Square, Type, Volume2, VolumeX } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { LessonHeader } from '../components/LessonHeader';
import { AmplitudeMeter, LessonSteps } from '../components/practice';
import { Badge, Button } from '../components/ui';
import { useMicrophone } from '../audio/useMicrophone';
import { useSpeech } from '../audio/useSpeech';
import { analyzeAttempt, assistanceLabel, type CoachResponse } from '../services/coach';
import { attemptsFor, useAppState } from '../state/AppState';
import { SOUNDS, SOUND_ORDER, type Attempt } from '../state/types';

/**
 * Independent attempt + session summary. Task-specific cues (cursor, target,
 * hold ring, mouth cue) are hidden; captions, written instructions, audio
 * preferences and stop controls stay available. Guided and independent results
 * are always reported separately.
 */
export default function Summary() {
  const navigate = useNavigate();
  const mic = useMicrophone();
  const speech = useSpeech();
  const { plan, updatePlan, attempts, addAttempt, audio, setAudio, signOut, learnerEmail } = useAppState();
  const [envelope, setEnvelope] = useState<number[]>([]);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [coach, setCoach] = useState<CoachResponse | null>(null);
  const [latest, setLatest] = useState<Attempt | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const s = SOUNDS[plan.sound];
  const history = useMemo(() => attemptsFor(attempts, plan.sound), [attempts, plan.sound]);
  const usable = history.filter((a) => a.quality === 'usable');
  const best = (kind: Attempt['kind']) =>
    usable.filter((a) => a.kind === kind).reduce<Attempt | null>((m, a) => (!m || a.usableVoicedSec > m.usableVoicedSec ? a : m), null);
  const guidedBest = best('guided');
  const independentBest = best('independent');
  const recording = mic.status === 'recording';

  async function toggleRecord() {
    if (!recording) {
      speech.stop();
      setCoach(null);
      await mic.beginRecording();
      return;
    }
    const summary = await mic.endRecording();
    setEnvelope(summary.envelope);
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
    setLatest(attempt);
    setAnalyzing(true);
    const res = await analyzeAttempt(attempt, history, { learnerId: learnerEmail, plan });
    if (res.plan) updatePlan(res.plan);
    setCoach(res);
    setAnalyzing(false);
  }

  const env = envelope.length ? envelope : [];
  const envMax = Math.max(0.05, ...env);
  const nextSound = SOUND_ORDER[(SOUND_ORDER.indexOf(plan.sound) + 1) % SOUND_ORDER.length];

  return (
    <AppShell context="Practice studio" inLesson footerNote="Your pace. Your choice.">
      <div className="page--tight" style={{ gap: 24 }}>
        <LessonHeader eyebrow="Your session / A little more independence" assistanceNote="reduced · captions remain on" disabled={recording} />
        <LessonSteps current={4} />

        <div className="summary-grid">
          <div className="stack gap-16">
            <section className="card card--lg" aria-labelledby="ind-h">
              <div className="card-head">
                <p className="eyebrow" id="ind-h">
                  Try independently
                </p>
                <Badge tone={latest ? (latest.quality === 'usable' ? 'success' : 'warn') : 'info'}>
                  {recording ? 'Recording' : latest ? (latest.quality === 'usable' ? 'Attempt captured' : 'Unclear capture') : 'Ready when you are'}
                </Badge>
              </div>

              <div className="row wrap" style={{ gap: 24 }}>
                <div className="stack gap-10" style={{ background: 'var(--color-navy-soft)', borderRadius: 6, padding: 26, width: 240, textAlign: 'center' }}>
                  <p className="serif navy" style={{ fontSize: 38, lineHeight: 1.2 }}>
                    {s.spelled} · as in {s.example}
                  </p>
                  <p className="small">Caption: Take a comfortable breath. Hold “{s.spelled}” for about 3 seconds, without following a target.</p>
                </div>
              </div>

              <p className="row row--top small" style={{ gap: 12 }}>
                <EyeOff size={20} color="var(--color-navy)" aria-hidden="true" style={{ flexShrink: 0 }} />
                During this attempt, task-specific cues are hidden. Captions, written instructions,
                audio preferences, and stop controls stay available.
              </p>

              <div className="stack gap-10">
                <StepLabel n={1}>Record your attempt</StepLabel>
                <div className="btn-row">
                  <Button
                    variant="primary"
                    icon={recording ? <Square size={17} aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}
                    onClick={toggleRecord}
                    disabled={analyzing || mic.status === 'unsupported'}
                  >
                    {recording ? `Stop · ${mic.elapsed.toFixed(1)} s` : latest ? 'Try independently again' : 'Try independently'}
                  </Button>
                  <Button
                    icon={<Play size={17} aria-hidden="true" />}
                    disabled={!recordingUrl || recording}
                    onClick={() => recordingUrl && new Audio(recordingUrl).play().catch(() => undefined)}
                  >
                    Replay recording
                  </Button>
                </div>
                {recording && <AmplitudeMeter levels={mic.levels} active />}
                <p className="fine">Reference and narration stop before recording. Recording is transient unless you choose to save it.</p>
              </div>

              <div className="stack gap-10">
                <StepLabel n={2}>Your sound: post-attempt review</StepLabel>
                <div className="stack gap-8" style={{ background: 'var(--color-navy-soft)', border: '1px solid var(--color-line)', borderRadius: 8, padding: 16 }}>
                  <div className="row row--between">
                    <p className="fine">Capture amplitude · relative</p>
                    <span className="row fine" style={{ gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--color-navy)' }} /> Voiced
                      <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--color-line)', marginLeft: 8 }} /> Quiet
                    </span>
                  </div>
                  <div className="envelope" aria-hidden="true">
                    {env.length ? (
                      env.map((v, i) => (
                        <span key={i} style={{ height: `${Math.max(6, (v / envMax) * 100)}%`, background: v >= 0.02 ? 'var(--color-navy)' : 'var(--color-line)' }} />
                      ))
                    ) : (
                      <p className="fine" style={{ alignSelf: 'center' }}>
                        Your amplitude envelope appears here after an attempt.
                      </p>
                    )}
                  </div>
                  <div className="row row--between fine">
                    <span>0 s</span>
                    <span>{latest ? `${latest.durationSec.toFixed(1)} s` : ''}</span>
                  </div>
                  <p className="fine">
                    {latest
                      ? `Usable voiced duration: ${latest.usableVoicedSec.toFixed(1)} s. The shape reflects this attempt only, not a scored comparison to the target.`
                      : 'Amplitude reflects capture only, not a scored comparison to the target.'}
                  </p>
                </div>
              </div>

              <div className="btn-row" style={{ gap: 8 }}>
                <Button
                  size="sm"
                  icon={<Type size={17} aria-hidden="true" />}
                  onClick={() => speech.speak(`${s.spelled}, as in ${s.example}. Hold it for about three seconds.`, { force: true })}
                  disabled={recording}
                >
                  Read text aloud
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    updatePlan({ assistance: 'cue-target' });
                    navigate('/practice');
                  }}
                >
                  Restore guidance
                </Button>
                <Badge tone="neutral">Captions on</Badge>
              </div>
            </section>

            <section className="panel-navy" style={{ borderRadius: 12, padding: 24, gap: 14 }}>
              <p className="eyebrow">Another context / Try it in a word</p>
              <div className="row" style={{ gap: 24 }}>
                <p className="serif" style={{ fontSize: 48 }}>
                  {s.example}
                </p>
                <p className="small grow" style={{ color: 'var(--color-navy-mist)', lineHeight: 1.7 }}>
                  Try your “{s.spelled}” inside a word when you feel ready. Caption: “{s.example}”. You can return to the
                  sustained vowel at any time.
                </p>
              </div>
            </section>
          </div>

          <div className="stack gap-16">
            <section className="card card--highlight" aria-labelledby="coach2-h">
              <div className="card-head">
                <div className="row" style={{ gap: 10 }}>
                  <StepPill n={3} />
                  <p className="eyebrow" id="coach2-h">
                    AI coach analysis
                  </p>
                </div>
                <Badge tone={analyzing ? 'neutral' : 'info'}>{analyzing ? 'Analyzing…' : coach ? 'Grounded response' : 'Waiting for an attempt'}</Badge>
              </div>
              <div className="coach-body" style={{ padding: 14, gap: 6 }}>
                <p className="eyebrow" style={{ color: 'var(--color-muted)' }}>
                  What was captured
                </p>
                <p className="serif ink" style={{ fontSize: 20 }}>
                  “{s.spelled}”
                </p>
                <p className="fine">
                  {latest
                    ? `Usable voiced duration: ${latest.usableVoicedSec.toFixed(1)} s. This is not a speech score or clinical measurement.`
                    : 'Record an independent attempt to see what was captured.'}
                </p>
              </div>
              <div className="row wrap" style={{ background: 'var(--color-navy-soft)', border: '1px solid var(--color-line)', borderRadius: 8, padding: '10px 14px', gap: 12 }}>
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Play size={14} aria-hidden="true" />}
                  disabled={!coach}
                  onClick={() => coach && speech.speak(`${coach.observation} ${coach.nextCue}`, { force: true })}
                >
                  {speech.speaking ? 'Playing…' : 'Play AI response'}
                </Button>
                <Button
                  size="sm"
                  aria-pressed={!audio}
                  icon={audio ? <Volume2 size={14} aria-hidden="true" /> : <VolumeX size={14} aria-hidden="true" />}
                  onClick={() => setAudio(!audio)}
                >
                  AI audio {audio ? 'on' : 'off'}
                </Button>
              </div>
              <div className="stack gap-10" style={{ background: 'var(--color-success-tint)', border: '1px solid var(--color-line)', borderRadius: 8, padding: 18 }} aria-live="polite">
                <p className="row strong" style={{ gap: 6, fontSize: 12, color: 'var(--color-success)' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--color-success)' }} />
                  Full response, always visible if audio is unavailable
                </p>
                <div className="coach-text">
                  {coach ? (
                    <>
                      <p>{coach.observation}</p>
                      <p>{coach.nextCue}</p>
                    </>
                  ) : (
                    <p className="small">The coach responds after your independent attempt, using only what was measured.</p>
                  )}
                </div>
              </div>
            </section>

            <section className="card">
              <div className="card-head">
                <p className="eyebrow">Today’s exploration</p>
                <Badge tone="neutral">This session</Badge>
              </div>
              <p className="title-serif ink">{independentBest ? 'You made space for a new try.' : 'One more step: try it on your own.'}</p>
              <div className="grid-2" style={{ gap: 16 }}>
                <ResultTile title="Guided sample" attempt={guidedBest} note="Visual cue + target shown" tone="soft" />
                <ResultTile title="Independent sample" attempt={independentBest} note="Task-specific cues hidden" tone="plain" />
              </div>
              <p className="fine">
                Support differed between these samples. They are separate observations, not evidence of retention, a speech
                level, or therapy outcomes.
              </p>
            </section>

            <section className="card">
              <p className="eyebrow">Usable attempt history</p>
              <div className="history-row fine" style={{ borderBottom: 0, paddingBottom: 0 }}>
                <span>Attempt</span>
                <span>Assistance</span>
                <span>Usable duration</span>
              </div>
              <div>
                {usable.length === 0 && <p className="fine">No usable attempts for {s.ipa} yet.</p>}
                {usable.map((a) => (
                  <div key={a.attemptId} className="history-row">
                    <span className="ink">
                      {a.kind === 'baseline' ? 'Baseline' : a.kind === 'guided' ? 'Guided' : 'Independent'} {s.ipa}
                    </span>
                    <span className="fine">{a.kind === 'baseline' ? 'No cues' : assistanceLabel(a.assistance)}</span>
                    <span className="navy">{a.usableVoicedSec.toFixed(1)} s</span>
                  </div>
                ))}
              </div>
              <p className="fine">Unclear captures are not scored as failures and don’t appear as usable attempts.</p>
            </section>

            <section className="card card--success" style={{ gap: 14 }}>
              <p style={{ color: 'var(--color-success)', fontSize: 14 }}>
                Next time, revisit a comfortable “{s.spelled}”, then explore “{s.example}”. Keep or restore whichever support
                feels useful.
              </p>
              <div className="btn-row" style={{ gap: 8 }}>
                <Button variant="primary" size="sm" onClick={() => navigate('/practice')}>
                  Continue with “{s.example}”
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    updatePlan({ sound: nextSound, assistance: 'cue-target' });
                    navigate('/practice');
                  }}
                >
                  Switch to {SOUNDS[nextSound].ipa}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    signOut();
                    navigate('/');
                  }}
                >
                  Finish session
                </Button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function StepPill({ n }: { n: number }) {
  return (
    <span className="badge" style={{ background: 'var(--color-navy)', color: '#fff', padding: '3px 8px', fontSize: 11 }}>
      STEP {n}
    </span>
  );
}

function StepLabel({ n, children }: { n: number; children: string }) {
  return (
    <div className="row" style={{ gap: 8 }}>
      <StepPill n={n} />
      <p className="eyebrow">{children}</p>
    </div>
  );
}

function ResultTile({ title, attempt, note, tone }: { title: string; attempt: Attempt | null; note: string; tone: 'soft' | 'plain' }) {
  return (
    <div
      className="stack gap-10"
      style={{
        background: tone === 'soft' ? 'var(--color-navy-soft)' : 'var(--color-cream)',
        border: tone === 'plain' ? '1px solid var(--color-line)' : '1px solid transparent',
        borderRadius: 6,
        padding: 16,
      }}
    >
      <p className="navy strong" style={{ fontSize: 13 }}>
        {title}
      </p>
      <p className="navy" style={{ fontSize: 24, lineHeight: 1.1 }}>
        {attempt ? `${attempt.usableVoicedSec.toFixed(1)} s` : '—'}
      </p>
      <p className="fine">
        Usable voiced duration
        <br />
        {note}
      </p>
    </div>
  );
}
