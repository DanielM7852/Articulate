import { useState } from 'react';
import { CheckCircle2, Mic, ShieldCheck, Square, TriangleAlert, Video } from 'lucide-react';
import { OnboardingFrame, StepHeading, Switch, stepTransition, useStepNav } from '../components/Onboarding';
import { AmplitudeMeter, CameraTile } from '../components/practice';
import { useMicrophone, type CaptureSummary } from '../audio/useMicrophone';
import { useAppState } from '../state/AppState';
import { SOUNDS } from '../state/types';

/** Two onboarding steps on one route so the microphone stream carries over. */
type Stage = 'mic' | 'try';

const UNCLEAR: Record<NonNullable<CaptureSummary['qualityReason']>, string> = {
  silence: 'I couldn’t hear that clearly. Try moving a little closer.',
  'too-short': 'That was quite short. Try holding the sound a bit longer.',
  clipping: 'That was too loud for the microphone. Try moving a little further away.',
};

export default function Setup() {
  const go = useStepNav();
  const mic = useMicrophone();
  const { camera, setCamera, addAttempt, plan } = useAppState();
  const [stage, setStage] = useState<Stage>('mic');
  const [baseline, setBaseline] = useState<CaptureSummary | null>(null);
  const sound = SOUNDS[plan.sound];
  const recording = mic.status === 'recording';
  const live = mic.status === 'ready' || recording;

  async function toggleBaseline() {
    if (recording) {
      const summary = await mic.endRecording();
      setBaseline(summary);
      addAttempt({
        attemptId: crypto.randomUUID(),
        sound: plan.sound,
        kind: 'baseline',
        assistance: 'none',
        startedAt: Date.now(),
        durationSec: summary.durationSec,
        usableVoicedSec: summary.usableVoicedSec,
        timeInTargetSec: null,
        longestHoldSec: null,
        quality: summary.quality,
        qualityReason: summary.qualityReason,
        recognizedText: null,
      });
    } else {
      setBaseline(null);
      await mic.beginRecording();
    }
  }

  const toPlan = () => {
    mic.stop();
    go('/plan');
  };

  if (stage === 'mic') {
    const status =
      mic.status === 'denied' ? (
        <span className="ob-status ob-status--warn" role="alert">
          <TriangleAlert size={17} aria-hidden="true" /> Microphone blocked. Allow it in site settings, or skip for now.
        </span>
      ) : mic.status === 'unsupported' ? (
        <span className="ob-status ob-status--warn">
          <TriangleAlert size={17} aria-hidden="true" /> This browser can’t use a microphone. You can skip this.
        </span>
      ) : live && mic.noiseLevel === 'noisy' ? (
        <span className="ob-status ob-status--warn">
          <TriangleAlert size={17} aria-hidden="true" /> The room sounds a little noisy
        </span>
      ) : live ? (
        <span className="ob-status ob-status--ok">
          <CheckCircle2 size={17} aria-hidden="true" /> Microphone ready{mic.noiseLevel === 'quiet' ? ' · quiet enough to begin' : ''}
        </span>
      ) : (
        <span className="ob-status">Not checked yet</span>
      );

    return (
      <OnboardingFrame
        step={4}
        stageKey="mic"
        onBack={() => go('/quiz/3', 'back')}
        secondary={{ label: 'Skip setup', onClick: toPlan }}
        primary={{ label: 'Continue', onClick: () => stepTransition(() => setStage('try')) }}
      >
        <StepHeading title="Let’s check your microphone." hint="Speak naturally, about a hand’s length away." />

        <div className="ob-panel" aria-live="polite">
          <AmplitudeMeter levels={mic.levels} active={live} />
          {status}
          <div className="btn-row" style={{ justifyContent: 'center' }}>
            {!live && mic.status !== 'unsupported' && (
              <button type="button" className="btn btn--sm" onClick={() => mic.start()} disabled={mic.status === 'requesting'}>
                <Mic size={16} aria-hidden="true" />
                {mic.status === 'denied' ? 'Try again' : 'Check microphone'}
              </button>
            )}
            {mic.devices.length > 1 && (
              <select className="btn btn--sm" aria-label="Change microphone" onChange={(e) => mic.start(e.target.value)} defaultValue="">
                <option value="" disabled>
                  Change microphone
                </option>
                {mic.devices.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Microphone ${i + 1}`}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        <div className="ob-cam">
          {camera ? (
            <CameraTile enabled />
          ) : (
            <span className="ob-cam-icon" aria-hidden="true">
              <Video size={22} />
            </span>
          )}
          <span className="ob-row-copy grow">
            <span className="ob-label">Lip mirror · optional</span>
            <span className="ob-fine">See your lips while you practice. Off unless you turn it on.</span>
          </span>
          <Switch label="Lip mirror camera" checked={camera} onChange={setCamera} />
        </div>

        <p className="ob-fine row" style={{ gap: 8, justifyContent: 'center' }}>
          <ShieldCheck size={16} color="var(--color-navy)" aria-hidden="true" style={{ flexShrink: 0 }} />
          Recordings aren’t saved without your consent.
        </p>
      </OnboardingFrame>
    );
  }

  return (
    <OnboardingFrame
      step={5}
      stageKey="try"
      onBack={() => stepTransition(() => setStage('mic'), 'back')}
      secondary={baseline?.quality === 'usable' ? undefined : { label: 'Skip', onClick: toPlan, disabled: recording }}
      primary={{ label: 'Continue', onClick: toPlan, disabled: recording }}
    >
      <StepHeading
        title="Try a sound on your own."
        hint="Hold it comfortably for about 3 seconds. No example, no score."
      />

      <div className="ob-panel" style={{ gap: 18 }}>
        <div className="stack gap-4" style={{ alignItems: 'center' }}>
          <p className="ob-glyph">{sound.ipa}</p>
          <p className="ob-hint">
            {sound.spelled} · as in {sound.example}
          </p>
        </div>
        <AmplitudeMeter levels={mic.levels} active={recording} />
        <button
          type="button"
          className="ob-record"
          aria-pressed={recording}
          aria-label={recording ? 'Stop recording' : 'Record'}
          onClick={toggleBaseline}
          disabled={mic.status === 'unsupported'}
        >
          {recording ? <Square size={24} fill="currentColor" aria-hidden="true" /> : <Mic size={28} aria-hidden="true" />}
        </button>
        <div aria-live="polite" role="status">
          {recording ? (
            <span className="ob-status">Recording · {mic.elapsed.toFixed(1)} s</span>
          ) : baseline?.quality === 'usable' ? (
            <span className="ob-status ob-status--ok">
              <CheckCircle2 size={17} aria-hidden="true" /> Got it · {baseline.usableVoicedSec.toFixed(1)} s of voiced sound
            </span>
          ) : baseline ? (
            <span className="ob-status ob-status--warn">
              <TriangleAlert size={17} aria-hidden="true" /> {UNCLEAR[baseline.qualityReason ?? 'silence']}
            </span>
          ) : (
            <span className="ob-status">Tap to record, tap again to stop</span>
          )}
        </div>
      </div>

      <p className="ob-fine ob-hide-short" style={{ textAlign: 'center' }}>
        This first try only checks that we can hear you. It isn’t a score or a diagnosis.
      </p>
    </OnboardingFrame>
  );
}
