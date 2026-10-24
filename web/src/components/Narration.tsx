import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Captions } from 'lucide-react';
import { useSpeech } from '../audio/useSpeech';
import { useAppState } from '../state/AppState';

/**
 * The guide's voice and its captions.
 *
 * `useNarration` speaks a line through Cartesia (or the browser voice) and always
 * exposes it as text. A line is "done" when the audio ends; with audio off, or
 * when playback is blocked, a reading-time timer stands in so scripted screens
 * still advance. `say` and `show` keep a stable identity so screens can call
 * them from effects. Pass an existing `useSpeech()` when a screen also plays
 * other audio, so one line always interrupts the other.
 */
const WORDS_PER_SEC = 2.6;
const MIN_HOLD_MS = 1600;

export function readingTime(text: string) {
  return Math.max(MIN_HOLD_MS, (text.split(/\s+/).filter(Boolean).length / WORDS_PER_SEC) * 1000 + 500);
}

export type Speech = ReturnType<typeof useSpeech>;

export function useNarration(shared?: Speech) {
  const own = useSpeech();
  const speech = shared ?? own;
  const speechRef = useRef(speech);
  speechRef.current = speech;
  const [caption, setCaption] = useState<string | null>(null);
  const timer = useRef(0);
  const token = useRef(0);

  const clear = useCallback(() => {
    token.current += 1;
    clearTimeout(timer.current);
    speechRef.current.stop();
  }, []);

  /** Show and speak a line. `onEnd` fires once, when the audio finishes or the reading time passes. */
  const say = useCallback(
    (text: string, onEnd?: () => void) => {
      clear();
      const mine = token.current;
      setCaption(text);
      const finish = () => {
        if (token.current !== mine) return;
        token.current += 1;
        onEnd?.();
      };
      const started = performance.now();
      const spoke = speechRef.current.speak(text, {
        onEnd: (reason) => {
          if (token.current !== mine) return;
          if (reason === 'ended') return finish();
          // Blocked or failed audio: fall back to reading time from when the line appeared.
          const remaining = readingTime(text) - (performance.now() - started);
          timer.current = window.setTimeout(finish, Math.max(0, remaining));
        },
      });
      if (!spoke) timer.current = window.setTimeout(finish, readingTime(text));
    },
    [clear],
  );

  /** Caption only, no voice: for lines shown while the learner is recording. */
  const show = useCallback(
    (text: string | null) => {
      clear();
      setCaption(text);
    },
    [clear],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  // `say` and `show` are stable; depend on them, not on this object, inside effects.
  const speaking = speech.speaking;
  return useMemo(() => ({ caption, say, show, speaking }), [caption, say, show, speaking]);
}

export function CaptionBar({ text, hint }: { text: string | null; hint?: string }) {
  const { captions } = useAppState();
  if (!captions || !text) return null;
  return (
    <div className="cap" role="status" aria-live="polite">
      <span className="cap-icon" aria-hidden="true">
        <Captions size={16} />
      </span>
      <p key={text} className="cap-text">
        {text}
      </p>
      {hint && <span className="cap-hint">{hint}</span>}
    </div>
  );
}
