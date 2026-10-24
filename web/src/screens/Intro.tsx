import { useEffect, useState } from 'react';
import { ArrowRight, Camera, CameraOff, MousePointer2 } from 'lucide-react';
import { CaptionBar, useNarration } from '../components/Narration';
import { MouthReference } from '../components/MouthReference';
import { OnboardingFrame, useStepNav } from '../components/Onboarding';
import { useFaceTracking, usePointerLook } from '../vision/useLook';

/**
 * First screen: the guide, full-bleed, looking at the learner. The camera is
 * asked for right away and the head follows the learner's face; if that is
 * denied or unavailable it follows the pointer instead, so the greeting always
 * feels addressed to someone. Browsers block sound before the first tap, so the
 * greeting is shown as text here and the voice begins on the next screen.
 */
type Beat = 'loading' | 'hello' | 'ready';

const LINES: Record<Exclude<Beat, 'loading'>, string> = {
  hello: 'Hi. I’m your guide for speaking practice.',
  ready: 'I’ll show you each sound with my mouth, and you’ll see your own voice on a graph. Ready when you are.',
};

export default function Intro() {
  const go = useStepNav();
  const face = useFaceTracking(true);
  const pointer = usePointerLook(face.status !== 'tracking');
  const look = face.look ?? pointer;
  const [beat, setBeat] = useState<Beat>('loading');
  const [guideReady, setGuideReady] = useState(false);
  const narration = useNarration();

  useEffect(() => {
    if (beat === 'loading') return;
    narration.show(LINES[beat]);
  }, [beat, narration.show]);

  // Once the guide has materialised (or failed to): a beat, a smile and a hello, then the invitation.
  useEffect(() => {
    if (!guideReady) return;
    const hello = setTimeout(() => setBeat('hello'), 500);
    const ready = setTimeout(() => setBeat('ready'), 3800);
    return () => {
      clearTimeout(hello);
      clearTimeout(ready);
    };
  }, [guideReady]);

  const cameraLine =
    face.status === 'tracking'
      ? { icon: <Camera size={15} aria-hidden="true" />, text: 'Following you · stays on this device' }
      : face.status === 'requesting'
        ? { icon: <Camera size={15} aria-hidden="true" />, text: 'Asking for the camera…' }
        : face.status === 'loading' || face.status === 'searching'
          ? { icon: <Camera size={15} aria-hidden="true" />, text: 'Looking for you…' }
          : face.status === 'denied'
            ? { icon: <CameraOff size={15} aria-hidden="true" />, text: 'Camera off · following your pointer' }
            : { icon: <MousePointer2 size={15} aria-hidden="true" />, text: 'Following your pointer' };

  return (
    <OnboardingFrame
      step={0}
      progress={false}
      stageKey="intro"
      className="intro ob-content--full"
      caption={<CaptionBar text={narration.caption} paused={narration.paused} onToggle={narration.toggle} />}
      primary={{
        label: 'Let’s begin',
        icon: <ArrowRight size={18} aria-hidden="true" />,
        onClick: () => go('/quiz/1'),
      }}
    >
      <MouthReference
        cue={beat === 'loading' ? null : 'spread-lips'}
        look={look}
        zoom={beat === 'loading' ? 1 : 0.82}
        paused={narration.paused}
        onReady={() => setGuideReady(true)}
        onError={() => setGuideReady(true)}
      />
      <span className="lp-overlay lp-overlay--tl lp-pill intro-camera" aria-live="polite">
        {cameraLine.icon}
        {cameraLine.text}
      </span>
    </OnboardingFrame>
  );
}
