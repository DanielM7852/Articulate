import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Captions, Pause, Play } from 'lucide-react';
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
 *
 * `pause` holds the current line: the voice stops where it is and the timers
 * freeze, so `onEnd` never fires until `resume`. A line started while paused
 * shows its caption and waits.
 */
const WORDS_PER_SEC = 2.6;
const MIN_HOLD_MS = 1600;

export function readingTime(text: string) {
  return Math.max(MIN_HOLD_MS, (text.split(/\s+/).filter(Boolean).length / WORDS_PER_SEC) * 1000 + 500);
}

export type Speech = ReturnType<typeof useSpeech>;
export type Narration = ReturnType<typeof useNarration>;

export function useNarration(shared?: Speech) {
  const own = useSpeech();
  const speech = shared ?? own;
  const speechRef = useRef(speech);
  speechRef.current = speech;
  const [caption, setCaption] = useState<string | null>(null);
  const [paused, setPausedState] = useState(false);
  const pausedRef = useRef(false);
  const timer = useRef(0);
  const token = useRef(0);
  // The one pending timer, kept here so it can be frozen on pause and re-armed on resume.
  const pending = useRef<(() => void) | null>(null);
  const deadline = useRef(0);
  const remaining = useRef(0);
  // Time spent paused during the current line, so reading time excludes it.
  const pausedAt = useRef(0);
  const pausedTotal = useRef(0);

  const disarm = useCallback(() => {
    clearTimeout(timer.current);
    pending.current = null;
  }, []);

  /** Run `fn` after `ms`, unless paused: then it waits, with `ms` left, for resume(). */
  const arm = useCallback((fn: () => void, ms: number) => {
    clearTimeout(timer.current);
    pending.current = fn;
    const wait = Math.max(0, ms);
    if (pausedRef.current) {
      remaining.current = wait;
      return;
    }
    deadline.current = performance.now() + wait;
    timer.current = window.setTimeout(() => {
      pending.current = null;
      fn();
    }, wait);
  }, []);

  const clear = useCallback(() => {
    token.current += 1;
    disarm();
    speechRef.current.stop();
  }, [disarm]);

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
      pausedTotal.current = 0;
      if (pausedRef.current) pausedAt.current = started;
      const spoke = speechRef.current.speak(text, {
        onEnd: (reason) => {
          if (token.current !== mine) return;
          if (reason === 'ended') return finish();
          // Blocked or failed audio: fall back to reading time from when the line appeared, not counting pauses.
          const held = pausedTotal.current + (pausedRef.current ? performance.now() - pausedAt.current : 0);
          arm(finish, readingTime(text) - (performance.now() - started - held));
        },
      });
      // speak() clears any pause on the voice; a paused narration holds the new line at its start.
      if (spoke && pausedRef.current) speechRef.current.pause();
      // Audio off: reading time. Audio on: a watchdog, in case playback starts but never reports an end.
      arm(finish, spoke ? readingTime(text) * 2.5 : readingTime(text));
    },
    [arm, clear],
  );

  /** Caption only, no voice: for lines shown while the learner is recording. */
  const show = useCallback(
    (text: string | null) => {
      clear();
      setCaption(text);
    },
    [clear],
  );

  /** Hold the current line: voice and timers freeze until resume(). */
  const pause = useCallback(() => {
    if (pausedRef.current) return;
    pausedRef.current = true;
    setPausedState(true);
    pausedAt.current = performance.now();
    if (pending.current) {
      clearTimeout(timer.current);
      remaining.current = Math.max(0, deadline.current - performance.now());
    }
    speechRef.current.pause();
  }, []);

  /** Continue the held line from where it stopped. */
  const resume = useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    setPausedState(false);
    pausedTotal.current += performance.now() - pausedAt.current;
    speechRef.current.resume();
    if (pending.current) arm(pending.current, remaining.current);
  }, [arm]);

  const toggle = useCallback(() => {
    if (pausedRef.current) resume();
    else pause();
  }, [pause, resume]);

  useEffect(() => () => clearTimeout(timer.current), []);

  // `say`, `show`, `pause`, `resume` and `toggle` are stable; depend on them, not on this object, inside effects.
  const speaking = speech.speaking;
  return useMemo(
    () => ({ caption, say, show, pause, resume, toggle, paused, speaking }),
    [caption, say, show, pause, resume, toggle, paused, speaking],
  );
}

export function CaptionBar({
  text,
  hint,
  paused,
  onToggle,
}: {
  text: string | null;
  hint?: string;
  paused?: boolean;
  onToggle?: () => void;
}) {
  const { captions } = useAppState();
  if (!captions || !text) return null;
  const label = paused ? 'Resume' : 'Pause';
  return (
    <div className="cap" role="status" aria-live="polite">
      <span className="cap-icon" aria-hidden="true">
        <Captions size={16} />
      </span>
      <p key={text} className="cap-text">
        {text}
      </p>
      {hint && <span className="cap-hint">{hint}</span>}
      {onToggle && (
        <div className="cap-controls">
          <button type="button" className="cap-pause" onClick={onToggle} aria-pressed={!!paused} aria-label={label} title={label}>
            {paused ? <Play size={16} /> : <Pause size={16} />}
          </button>
        </div>
      )}
    </div>
  );
}
