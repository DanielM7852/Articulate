import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Camera, CameraOff, MousePointer2 } from 'lucide-react';
import { CaptionBar, readingTime, useNarration, type Narration } from '../components/Narration';
import { MouthReference, type MouthReferenceHandle } from '../components/MouthReference';
import { OnboardingFrame, useStepNav } from '../components/Onboarding';
import { prepareTeacher, speakTeacher, unlockTeacherAudio, type TeacherSpeech } from '../audio/teacher';
import type { SpeechHandle } from '@mouth-demo/src/mouth-demo.js';
import { useAppState } from '../state/AppState';
import { useQuality } from '../guide/quality';
import { useFaceTracking, usePointerLook } from '../vision/useLook';
import brandMark from '../assets/landing/brand-mark.svg';
import closingLinework from '../assets/landing/closing-linework.svg';
import voiceContour from '../assets/landing/voice-contour.svg';
import sculpturalVoice from '../assets/landing/sculptural-voice.png';
import '../styles/intro.css';

/**
 * First screen: the landing page over the stage, with its ribbon picture and a
 * Begin button. The tap unlocks audio (browsers block sound before it), the
 * guide's dots take the ribbon's place, the page fades, and the dots morph into
 * her head; she introduces herself with a lip-synced voice and
 * captions, and dissolves again on the way to the survey. The camera is asked
 * for on Begin so she looks at the learner; if that is denied she follows the
 * pointer instead. Returning learners get a shorter line and go to the lesson.
 * In the simple view (no 3D, see guide/quality.ts) there is no head to build: the picture stays and Begin
 * goes straight on to the next screen.
 */
/** forming: Begin was tapped and the guide's dots are taking the ribbon picture's place. */
type Phase = 'idle' | 'forming' | 'assembling' | 'talking' | 'leaving';
type GuideState = 'loading' | 'ready' | 'error';

const GREETING = [
  'Hi, I’m Ava. I’ll show you each sound with my mouth, and you’ll see your own voice on the board.',
  'First, a quick survey so I know what to focus on.',
];
const WELCOME_BACK = ['Welcome back. Let’s pick up where we left off.'];

const ASSEMBLE_MS = 1600;
const DISPERSE_MS = 1100;
/** The landing's paper colour (--color-cream): the stage takes it while the ribbon is drawn in dots. */
const PAPER = '#faf9f6';
/** As the morph starts the stage eases from the paper back to its own gradient. */
const BACKDROP_MS = 700;
/** Speech that has not started by now (no voice, blocked audio) falls back to reading time. */
const START_TIMEOUT_MS = 6000;

/**
 * Scripted lines in the guide's own voice: Cartesia (browser fallback) with lip sync on the guide,
 * the same path the practice coach uses, and the caption through `narration.show`. Each line
 * advances when its audio ends; with audio off, or speech that never starts, reading time stands in.
 * Pausing the narration stops the line and resuming replays it from the start.
 */
function useGuideVoice(guide: RefObject<MouthReferenceHandle | null>, narration: Narration, voice: boolean) {
  const { show, paused } = narration;
  const run = useRef<{ lines: string[]; index: number; onDone: () => void } | null>(null);
  const live = useRef<(() => void) | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const halt = useCallback(() => {
    live.current?.();
    live.current = null;
  }, []);

  const start = useCallback(() => {
    halt();
    const r = run.current;
    if (!r) return;
    const text = r.lines[r.index];
    show(text);
    if (pausedRef.current) return; // resume replays this line

    const began = performance.now();
    const timers: number[] = [];
    const offs: (() => void)[] = [];
    let sp: TeacherSpeech | null = null;
    let lip: SpeechHandle | null = null;
    let over = false;
    const stop = () => {
      over = true;
      timers.forEach(clearTimeout);
      offs.forEach((off) => off());
      lip?.stop();
      sp?.cancel();
    };
    const next = () => {
      if (over) return;
      stop();
      live.current = null;
      if (run.current !== r) return;
      r.index += 1;
      if (r.index < r.lines.length) start();
      else {
        run.current = null;
        r.onDone();
      }
    };
    const hold = () => timers.push(window.setTimeout(next, readingTime(text) - (performance.now() - began)));
    live.current = stop;

    if (!voiceRef.current) {
      hold();
      return;
    }
    const speech = speakTeacher(text);
    sp = speech;
    let started = false;
    offs.push(
      speech.on('start', () => {
        started = true;
      }),
    );
    offs.push(
      speech.on('end', (reason) => {
        if (reason !== 'finished') return;
        if (started) next();
        else hold(); // no voice in this browser: keep the caption up for its reading time
      }),
    );
    const g = guide.current;
    if (g?.ready) {
      g.stop(); // a looping cue owns the mouth and would block lip sync
      lip = g.speak({ clock: () => speech.clock(), timeline: { words: [...speech.words], phonemes: [...speech.phonemes] } });
      if (lip) offs.push(speech.on('timeline', (added) => lip?.append(added)));
    }
    timers.push(
      window.setTimeout(() => {
        if (started || over) return;
        speech.cancel();
        hold();
      }, START_TIMEOUT_MS),
    );
    // Playback that starts but never reports an end.
    timers.push(window.setTimeout(next, readingTime(text) * 2.5));
  }, [guide, halt, show]);

  const play = useCallback(
    (lines: string[], onDone: () => void) => {
      run.current = { lines, index: 0, onDone };
      start();
    },
    [start],
  );

  // Pause holds the line; resume, or switching the voice on or off, replays it.
  useEffect(() => {
    if (!run.current) return;
    if (paused) halt();
    else start();
  }, [paused, voice, halt, start]);

  useEffect(
    () => () => {
      run.current = null;
      halt();
    },
    [halt],
  );

  return play;
}

export default function Intro() {
  const go = useStepNav();
  const { onboarded, audio } = useAppState();
  const [phase, setPhase] = useState<Phase>('idle');
  const face = useFaceTracking(phase !== 'idle');
  const pointer = usePointerLook(face.status !== 'tracking');
  const look = face.look ?? pointer;
  const guide = useRef<MouthReferenceHandle>(null);
  const [guideState, setGuideState] = useState<GuideState>('loading');
  const narration = useNarration();
  const play = useGuideVoice(guide, narration, audio);
  const sculpture = useRef<HTMLImageElement>(null);
  // The ribbon is drawn by the guide's dots (the picture is hidden); false keeps the picture.
  const [dotted, setDotted] = useState(false);
  // The landing page has left: it fades while the head is built.
  const pageGone = phase !== 'idle' && phase !== 'forming';
  const quality = useQuality();
  const leftEarly = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; // a shape that resolves after this is ignored
    };
  }, []);

  // Warm the voice connection while the learner is still looking at the Go button.
  useEffect(() => {
    if (audio) prepareTeacher();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The overlay fades and the head is built (from the dotted ribbon when it formed, else the usual fly-in).
  const assemble = () => {
    guide.current?.setBackdrop(null, { durationMs: BACKDROP_MS });
    setPhase('assembling');
  };

  // Begin: the guide's dots take the ribbon picture's place (measured now, where it sits on screen) and
  // morph straight into her head. The stage takes the paper colour so the overlay can turn see-through.
  // Without a ready particle guide, or if the picture cannot be read, the overlay simply fades as before.
  const begin = () => {
    if (phase !== 'idle' || leftEarly.current) return; // the overlay is also inert from here on
    void unlockTeacherAudio(); // inside the tap, so the voice may play
    if (quality.tier === 'simple') {
      // no dots to morph and no head to build: straight on, under the usual page crossfade
      leftEarly.current = true;
      go(onboarded ? '/lesson' : '/quiz/1');
      return;
    }
    const g = guideState === 'ready' ? guide.current : null;
    const rect = sculpture.current?.getBoundingClientRect();
    if (!g || !rect?.width || !rect.height) {
      assemble();
      return;
    }
    setPhase('forming');
    g.setBackdrop(PAPER);
    const settle = (ok: boolean) => {
      if (!mounted.current) return;
      if (!ok) {
        g.setBackdrop(null); // still under the opaque overlay, so this is not seen
        assemble();
        return;
      }
      // The dots take the picture's place and start moving at once; their 80 ms fade-in and the picture's 200 ms fade-out run over the morph's start.
      setDotted(true);
      assemble();
    };
    g.setStartShapeFromImage({ src: sculpturalVoice, rect, fit: 'cover' }).then(settle, () => settle(false));
  };

  // After Go (and once the guide has loaded or failed): build the head, then say hello.
  useEffect(() => {
    if (phase !== 'assembling' || guideState === 'loading') return;
    let current = true;
    const built = guideState === 'ready' && guide.current ? guide.current.assemble({ durationMs: ASSEMBLE_MS }) : Promise.resolve(true);
    void built.then(() => {
      if (!current) return;
      guide.current?.clearStartShape(); // the ribbon has become her head; later dissolves are the usual ones
      setPhase('talking');
      if (onboarded) play(WELCOME_BACK, () => go('/lesson'));
      else play(GREETING, () => setPhase('leaving'));
    });
    return () => {
      current = false;
    };
  }, [phase, guideState, onboarded, play, go]);

  // The head dissolves, then the survey.
  useEffect(() => {
    if (phase !== 'leaving') return;
    let current = true;
    const gone = guideState === 'ready' && guide.current ? guide.current.disperse({ durationMs: DISPERSE_MS }) : Promise.resolve(true);
    void gone.then(() => {
      if (current) go('/quiz/1');
    });
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

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
      bar="float"
      actions={false}
      stageKey="intro"
      className="intro ob-content--full"
    >
      <MouthReference
        ref={guide}
        cue={null}
        look={look}
        zoom={1.12}
        paused={narration.paused}
        startDispersed
        onReady={() => setGuideState('ready')}
        onError={() => setGuideState('error')}
      />
      {pageGone && (
        <span className="lp-overlay lp-overlay--tl lp-pill intro-camera" aria-live="polite">
          {cameraLine.icon}
          {cameraLine.text}
        </span>
      )}
      <CaptionBar className="cap-card" text={narration.caption} paused={narration.paused} onToggle={narration.toggle} />
      <section
        className="intro-landing"
        data-gone={pageGone || undefined}
        data-dotted={dotted || undefined}
        {...(phase !== 'idle' ? { inert: '' } : {})} /* React 18 takes inert as an empty string */
        aria-label="Welcome"
      >
        <header className="intro-landing__head">
          <img src={brandMark} alt="" aria-hidden="true" width={30} height={32} />
          <span className="intro-landing__brand">articulate</span>
        </header>
        <div className="intro-landing__body">
          <h1 className="intro-landing__title">
            Give your voice
            <br />
            room to take shape.
          </h1>
          <div className="intro-landing__art" aria-hidden="true">
            <img ref={sculpture} className="intro-landing__sculpture" src={sculpturalVoice} alt="" />
            <img className="intro-landing__contour" src={voiceContour} alt="" />
          </div>
          <div className="intro-landing__invite">
            <p>See your voice and explore speech at your own pace.</p>
            <button type="button" className="intro-landing__begin" onClick={begin}>
              Begin
            </button>
          </div>
        </div>
        <img className="intro-landing__close" src={closingLinework} alt="" aria-hidden="true" />
      </section>
    </OnboardingFrame>
  );
}
