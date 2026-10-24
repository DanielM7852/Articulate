import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Mic, TriangleAlert } from 'lucide-react';
import type { VowelPoint } from '@vowel-mapper/audio/tracker';
import { useMicrophone } from '../audio/useMicrophone';
import { useVowelTracking } from '../audio/useVowelTracking';
import { MouthReference } from '../components/MouthReference';
import { CaptionBar, useNarration } from '../components/Narration';
import { OnboardingFrame, ONBOARDING_STEPS } from '../components/Onboarding';
import { VowelGraph } from '../components/VowelGraph';
import { useAppState } from '../state/AppState';
import { HOLD_GOAL_SEC, TARGETS, inTarget } from '../vowel/targets';

/**
 * The guide explains the graph once, with "ee":
 *   watch  -> the mouth shape, on the 3D guide
 *   dot    -> a demo cursor glides to the ee region while the guide explains the axes
 *   ring   -> the cursor rests there and the hold ring fills
 *   mic    -> ask for the microphone
 *   you    -> the guide leaves; the learner's own voice drives the graph
 *   done   -> a short hold inside the region, then on to practice
 * Skip is always available; practice asks for the microphone itself if needed.
 */
type Phase = 'watch' | 'dot' | 'ring' | 'mic' | 'you' | 'done';

const LINES: Record<Phase, string> = {
  watch: 'Watch my mouth. For “ee”, the lips spread and the tongue comes forward.',
  dot: 'The dot is your voice. Tongue forward moves it left. Jaw open moves it down.',
  ring: 'Hold the sound steady and the ring fills. Three seconds, and you’ve found it.',
  mic: 'Now you. Allow the microphone, then hold “ee” as in “see”.',
  you: 'Hold “ee” as in “see”. Keep it steady until the ring fills.',
  done: 'That’s it. Let’s practice.',
};

const TARGET = TARGETS.i;
const DEMO_START = { f1: 620, f2: 1500 };
const GLIDE_MS = 2600;
const YOU_HOLD_SEC = 1.5;

/**
 * A scripted cursor for the explanation: glides into the ee region, then rests there.
 * The hold only counts once `holding`; `paused` freezes it on its own clock.
 */
function useDemoCursor(active: boolean, holding: boolean, paused: boolean) {
  const flags = useRef({ holding, paused });
  flags.current = { holding, paused };
  const [state, setState] = useState<{ point: VowelPoint | null; trace: VowelPoint[]; holdSec: number }>({
    point: null,
    trace: [],
    holdSec: 0,
  });
  useEffect(() => {
    if (!active) {
      setState({ point: null, trace: [], holdSec: 0 });
      return;
    }
    let raf = 0;
    let elapsed = 0; // ms on the demo's own clock, which stops while paused
    let prev = performance.now();
    let sinceFrame = 0;
    let arrivedAt: number | null = null;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = now - prev;
      prev = now;
      if (flags.current.paused) return;
      elapsed += dt;
      sinceFrame += dt;
      if (sinceFrame < 40) return;
      sinceFrame = 0;
      const t = Math.min(1, elapsed / GLIDE_MS);
      const e = 1 - Math.pow(1 - t, 3);
      const wobble = t < 1 ? Math.sin(elapsed / 90) * 0.03 * (1 - t) : Math.sin(elapsed / 160) * 0.012;
      const point: VowelPoint = {
        f1: DEMO_START.f1 * Math.exp((Math.log(TARGET.f1 / DEMO_START.f1) + wobble) * e),
        f2: DEMO_START.f2 * Math.exp((Math.log(TARGET.f2 / DEMO_START.f2) - wobble) * e),
        timestampMs: elapsed,
        segment: 0,
      };
      if (flags.current.holding && inTarget(point, TARGET)) arrivedAt ??= elapsed;
      else arrivedAt = null;
      setState((s) => ({
        point,
        trace: [...s.trace.slice(-120), point],
        holdSec: arrivedAt !== null ? (elapsed - arrivedAt) / 1000 : 0,
      }));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return state;
}

export default function Tutorial() {
  const navigate = useNavigate();
  const { completeOnboarding } = useAppState();
  const narration = useNarration();
  const mic = useMicrophone();
  const live = useVowelTracking(mic.stream, TARGET);
  const [phase, setPhase] = useState<Phase>('watch');
  const demo = useDemoCursor(phase === 'dot' || phase === 'ring', phase === 'ring', narration.paused);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const finish = () => {
    completeOnboarding();
    navigate('/practice');
  };

  // Each phase speaks its line; scripted phases advance when the line ends.
  useEffect(() => {
    const next: Partial<Record<Phase, Phase>> = { watch: 'dot', dot: 'ring', ring: 'mic' };
    narration.say(LINES[phase], () => {
      const n = next[phase];
      if (n && phaseRef.current === phase) setPhase(n);
      if (phase === 'done') finish();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // The microphone is live: the guide steps aside and the learner's voice takes over.
  useEffect(() => {
    if (phase === 'mic' && (mic.status === 'ready' || mic.status === 'recording')) setPhase('you');
  }, [phase, mic.status]);
  useEffect(() => {
    if (phase === 'you' && live.holdSec >= YOU_HOLD_SEC) setPhase('done');
  }, [phase, live.holdSec]);

  const solo = phase === 'you' || phase === 'done';
  const graph = solo ? live : { ...demo, tracking: phase !== 'watch', status: 'tracking' as const };
  const micBlocked = mic.status === 'denied' || mic.status === 'unsupported';
  const micMessage =
    mic.status === 'denied' ? 'Microphone blocked · allow it in site settings' : mic.status === 'unsupported' ? 'No microphone in this browser · you can skip ahead' : null;

  const primary =
    phase === 'mic'
      ? {
          label: mic.status === 'denied' ? 'Try the microphone again' : 'Allow microphone',
          icon: <Mic size={18} aria-hidden="true" />,
          onClick: () => void mic.start(),
          disabled: mic.status === 'requesting' || mic.status === 'unsupported',
        }
      : phase === 'done'
        ? { label: 'Start practicing', icon: <ArrowRight size={18} aria-hidden="true" />, onClick: finish }
        : undefined;

  return (
    <OnboardingFrame
      step={ONBOARDING_STEPS}
      stageKey="tutorial"
      className="tut ob-content--full"
      caption={
        <div className={`cap-wrap ${solo ? 'cap-wrap--large' : ''}`}>
          <CaptionBar text={narration.caption} paused={narration.paused} onToggle={narration.toggle} />
        </div>
      }
      secondary={phase === 'done' ? undefined : { label: 'Skip', onClick: finish }}
      primary={primary}
    >
      <div className={`tut-stage ${solo ? 'is-solo' : ''}`}>
        {/* Full-size guide while explaining; once the learner takes over it shrinks into a corner of the graph. */}
        {!solo && (
          <section className="lp-pane tut-guide" aria-label="Mouth guide">
            <MouthReference cue="spread-lips" zoom={phase === 'watch' ? 0.8 : 1} paused={narration.paused} />
          </section>
        )}
        <section className="lp-pane" aria-label="Your sound">
          <VowelGraph
            sound="i"
            point={graph.point}
            trace={graph.trace}
            tracking={graph.tracking}
            statusLabel={solo ? (live.tracking ? 'Tracking your vowel' : 'Listening') : phase === 'watch' ? 'Watch the guide' : 'Example'}
            holdSec={Math.min(graph.holdSec, HOLD_GOAL_SEC)}
            emptyHint={solo ? 'Hold “ee” and your sound appears here.' : 'Watch the example.'}
          />
          {micBlocked && micMessage && (
            <span className="lp-overlay lp-overlay--bl lp-pill" role="alert">
              <TriangleAlert size={15} aria-hidden="true" /> {micMessage}
            </span>
          )}
          {solo && (
            <div className="tut-pip" aria-label="Mouth guide, small">
              <MouthReference cue="spread-lips" zoom={0.75} paused={narration.paused} />
            </div>
          )}
        </section>
      </div>
    </OnboardingFrame>
  );
}
