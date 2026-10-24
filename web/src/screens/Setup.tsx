import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Hand, Mic, ShieldCheck, Square, Video } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { AmplitudeMeter, CameraTile, VowelGlyph } from '../components/practice';
import { Badge, Button } from '../components/ui';
import { useMicrophone, type CaptureSummary } from '../audio/useMicrophone';
import { useAppState } from '../state/AppState';
import { SOUNDS } from '../state/types';

export default function Setup() {
  const navigate = useNavigate();
  const mic = useMicrophone();
  const { camera, setCamera, addAttempt, plan } = useAppState();
  const [baseline, setBaseline] = useState<CaptureSummary | null>(null);
  const sound = SOUNDS[plan.sound];

  const micBadge =
    mic.status === 'ready' || mic.status === 'recording' ? (
      <Badge tone="success">Microphone ready</Badge>
    ) : mic.status === 'denied' ? (
      <Badge tone="warn">Microphone blocked</Badge>
    ) : mic.status === 'unsupported' ? (
      <Badge tone="warn">Not supported in this browser</Badge>
    ) : (
      <Badge tone="neutral">Not checked yet</Badge>
    );

  async function toggleBaseline() {
    if (mic.status === 'recording') {
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

  const recording = mic.status === 'recording';

  return (
    <AppShell context="Set up your space" footerNote="Microphone calibration, graph scale, and sound targets are separate.">
      <div className="page stack gap-28" style={{ paddingTop: 34 }}>
        <header className="stack gap-16">
          <div className="stack gap-12" style={{ maxWidth: 890 }}>
            <p className="eyebrow">Before your first lesson</p>
            <h1 className="display-md">Let’s make room for your sound.</h1>
            <p className="body">
              Check your microphone, then try a short sound without a cue. This helps suggest support. It is not a
              pronunciation score.
            </p>
          </div>
          <Badge>Setup + a short first try</Badge>
        </header>

        <div className="setup-grid">
          <div className="stack gap-18">
            <section className="card" aria-labelledby="mic-h">
              <div className="card-head">
                <p className="eyebrow" id="mic-h">
                  01 / Microphone check
                </p>
                {micBadge}
              </div>
              <div className="inset-tile row" style={{ gap: 18, justifyContent: 'center', padding: 24 }}>
                <span className="row" style={{ gap: 10, color: 'var(--color-navy)' }} aria-hidden="true">
                  <Mic size={30} strokeWidth={1.5} />
                  <span style={{ width: 80, borderTop: '2px dashed var(--color-navy-mist)' }} />
                  <Hand size={30} strokeWidth={1.5} />
                </span>
                <p className="small" style={{ maxWidth: 220 }}>
                  Speak naturally, about a hand’s length from the microphone.
                </p>
              </div>
              <div className="inset-tile row row--between wrap" style={{ padding: 14, borderRadius: 6 }}>
                <div className="stack gap-4">
                  <AmplitudeMeter levels={mic.levels} active={mic.status === 'ready' || recording} />
                  <p className="fine">Input amplitude · capture quality only</p>
                </div>
                {mic.noiseLevel === 'quiet' && <Badge tone="success">Quiet enough to begin</Badge>}
                {mic.noiseLevel === 'noisy' && <Badge tone="warn">Room sounds noisy</Badge>}
              </div>
              {mic.status === 'denied' && (
                <p className="fine" role="alert">
                  Microphone access was blocked. Allow it in your browser’s site settings, then check again. You can also
                  continue without a sample.
                </p>
              )}
              <div className="btn-row">
                <Button size="sm" onClick={() => mic.start()}>
                  {mic.status === 'idle' || mic.status === 'denied' ? 'Check microphone' : 'Check microphone again'}
                </Button>
                {mic.devices.length > 1 && (
                  <select
                    className="btn btn--sm"
                    aria-label="Change device"
                    onChange={(e) => mic.start(e.target.value)}
                    defaultValue=""
                  >
                    <option value="" disabled>
                      Change device
                    </option>
                    {mic.devices.map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Microphone ${i + 1}`}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </section>

            <section className="card" aria-labelledby="cam-h">
              <div className="card-head">
                <p className="eyebrow" id="cam-h">
                  Optional / Lip camera
                </p>
                <Badge tone={camera ? 'success' : 'neutral'}>{camera ? 'On' : 'Off'}</Badge>
              </div>
              <div className="inset-tile stack gap-16" style={{ alignItems: 'center' }}>
                <CameraTile enabled={camera} />
                <p className="small">
                  See your visible lip movement in a small mirror tile. The camera is off unless you choose to enable it;
                  it cannot show internal tongue position.
                </p>
              </div>
              <div className="btn-row">
                <Button size="sm" icon={<Video size={17} aria-hidden="true" />} aria-pressed={camera} onClick={() => setCamera(!camera)}>
                  {camera ? 'Turn camera off' : 'Enable camera'}
                </Button>
                {!camera && (
                  <Button size="sm" onClick={() => setCamera(false)}>
                    Skip camera
                  </Button>
                )}
              </div>
            </section>

            <p className="row row--top fine" style={{ gap: 10, padding: '0 4px' }}>
              <ShieldCheck size={19} color="var(--color-navy)" aria-hidden="true" style={{ flexShrink: 0 }} />
              Recordings are transient and aren’t saved without your consent. No camera is needed. You can stop or skip at
              any time.
            </p>
          </div>

          <div className="stack gap-18">
            <section className="card card--lg" aria-labelledby="base-h">
              <div className="card-head">
                <p className="eyebrow" id="base-h">
                  02 / A short first try
                </p>
                <Badge>Unassisted · no reference yet</Badge>
              </div>
              <div className="inset-tile inset-tile--soft">
                <VowelGlyph sound={plan.sound} />
                <p className="small" style={{ textAlign: 'center', marginTop: 12 }}>
                  Hold the vowel comfortably for about 3 seconds.
                </p>
              </div>
              <p className="small">
                Take a comfortable breath, select Record, and try the sound once. There’s no example playing and no target
                to follow for this first attempt. Stop whenever you need.
              </p>
              <div className="btn-row" aria-live="polite">
                <Button
                  variant="primary"
                  icon={recording ? <Square size={17} aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}
                  onClick={toggleBaseline}
                  disabled={mic.status === 'unsupported'}
                >
                  {recording ? `Stop · ${mic.elapsed.toFixed(1)} s` : baseline ? 'Record first try again' : 'Record first try'}
                </Button>
                {recording ? (
                  <Badge live>Recording</Badge>
                ) : (
                  <Button onClick={() => navigate('/plan')}>Skip first try</Button>
                )}
              </div>
              {recording && <AmplitudeMeter levels={mic.levels} active />}
              {baseline?.quality === 'usable' && (
                <div className="card card--success" style={{ padding: 18, gap: 6 }} role="status">
                  <p className="strong" style={{ color: 'var(--color-success)', fontSize: 13 }}>
                    Usable capture · {baseline.usableVoicedSec.toFixed(1)} s of voiced sound
                  </p>
                  <p className="fine">Saved as your baseline for “{sound.spelled}”. This is not a score.</p>
                </div>
              )}
              <p className="fine">
                This checks usable capture and can inform support later. A first try does not establish a speech level or
                diagnose anything.
              </p>
            </section>

            <div className="card card--warn" style={{ padding: 18, gap: 8 }} role={baseline?.quality === 'unclear' ? 'alert' : undefined}>
              <p className="strong" style={{ color: 'var(--color-warn)', fontSize: 12, textTransform: 'uppercase' }}>
                {baseline?.quality === 'unclear' ? 'That capture was unclear' : 'If the room is noisy or no voice is captured'}
              </p>
              <p className="ink" style={{ fontSize: 13, lineHeight: 1.6 }}>
                {baseline?.qualityReason === 'clipping'
                  ? '“That was too loud for the microphone. Try moving a little further away.”'
                  : '“I couldn’t measure that clearly. Try moving closer to the microphone.”'}{' '}
                Nothing is scored. Retry, change device, or continue without a sample.
              </p>
            </div>
          </div>
        </div>

        <div className="row row--between">
          <Button icon={<ArrowLeft size={17} aria-hidden="true" />} onClick={() => navigate(-1)}>
            Back
          </Button>
          <Button
            variant="primary"
            icon={<ArrowRight size={17} aria-hidden="true" />}
            onClick={() => {
              mic.stop();
              navigate('/plan');
            }}
          >
            See my suggested plan
          </Button>
        </div>
      </div>
    </AppShell>
  );
}
