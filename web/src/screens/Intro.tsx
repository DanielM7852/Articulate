import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Camera, CameraOff, MousePointer2 } from 'lucide-react';
import { CaptionBar, readingTime, useNarration, type Narration } from '../components/Narration';
import { MouthReference, type MouthReferenceHandle } from '../components/MouthReference';
import { OnboardingFrame, useStepNav } from '../components/Onboarding';
import { prepareTeacher, speakTeacher, unlockTeacherAudio, type TeacherSpeech } from '../audio/teacher';
import type { SpeechHandle } from '@mouth-demo/src/mouth-demo.js';
import { useAppState } from '../state/AppState';
import { useFaceTracking, usePointerLook } from '../vision/useLook';
import '../styles/intro.css';

/**
 * First screen: an empty stage, only the ambient particles, and one Go button.
 * The tap unlocks audio (browsers block sound before it), then the guide's dots
 * fly in and build her head, she introduces herself with a lip-synced voice and
 * captions, and dissolves again on the way to the survey. The camera is asked
 * for right away so she looks at the learner; if that is denied she follows the
 * pointer instead. Returning learners get a shorter line and go to the lesson.
 */
type Phase = 'idle' | 'assembling' | 'talking' | 'leaving';
type GuideState = 'loading' | 'ready' | 'error';

const GREETING = [
  'Hi, I’m Ava. I’ll show you each sound with my mouth, and you’ll see your own voice on the board.',
  'First, a quick survey so I know what to focus on.',
];
const WELCOME_BACK = ['Welcome back. Let’s pick up where we left off.'];

const ASSEMBLE_MS = 1600;
const DISPERSE_MS = 1100;
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
  const face = useFaceTracking(true);
  const pointer = usePointerLook(face.status !== 'tracking');
  const look = face.look ?? pointer;
  const guide = useRef<MouthReferenceHandle>(null);
  const [guideState, setGuideState] = useState<GuideState>('loading');
  const [phase, setPhase] = useState<Phase>('idle');
  const narration = useNarration();
  const play = useGuideVoice(guide, narration, audio);

  // Warm the voice connection while the learner is still looking at the Go button.
  useEffect(() => {
    if (audio) prepareTeacher();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const begin = () => {
    if (phase !== 'idle') return;
    void unlockTeacherAudio(); // inside the tap, so the voice may play
    setPhase('assembling');
  };

  // After Go (and once the guide has loaded or failed): build the head, then say hello.
  useEffect(() => {
    if (phase !== 'assembling' || guideState === 'loading') return;
    let current = true;
    const built = guideState === 'ready' && guide.current ? guide.current.assemble({ durationMs: ASSEMBLE_MS }) : Promise.resolve(true);
    void built.then(() => {
      if (!current) return;
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
      <span className="lp-overlay lp-overlay--tl lp-pill intro-camera" aria-live="polite">
        {cameraLine.icon}
        {cameraLine.text}
      </span>
      <CaptionBar className="cap-card" text={narration.caption} paused={narration.paused} onToggle={narration.toggle} />
      <button
        type="button"
        className="intro-go"
        data-gone={phase !== 'idle' || undefined}
        disabled={phase !== 'idle'}
        onClick={begin}
      >
        Go
      </button>
    </OnboardingFrame>
  );
}
