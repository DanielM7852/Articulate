import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppState } from '../state/AppState';
import { bakedEntryReady } from './bakedVoice';

/**
 * Spoken narration and reference playback.
 *
 * Cartesia is requested from /v1/speech when that endpoint is available.
 * The browser speechSynthesis path below remains the offline fallback.
 * Text is always shown on screen too; audio is optional by design.
 */
const SPEECH_URL = (import.meta.env.VITE_SPEECH_URL as string | undefined) || '/v1/speech';

/** Why a line stopped: it played to the end, or audio failed or was blocked. */
export type SpeechEnd = 'ended' | 'failed';

function synth(): SpeechSynthesis | null {
  return typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
}

async function playCartesia(
  text: string,
  rate: number | undefined,
  clipRef: { current: HTMLAudioElement | null },
  setSpeaking: (value: boolean) => void,
  isCurrent: () => boolean,
  isPaused: () => boolean,
  onEnd?: (reason: SpeechEnd) => void,
): Promise<boolean> {
  try {
    // Fixed scripted lines are prebaked: play the static file instead of spending TTS credits.
    let baked: string | null = null;
    try { baked = (await bakedEntryReady(text, rate))?.file ?? null; } catch { baked = null; }
    if (!isCurrent()) return false;
    let url: string;
    let revoke = false;
    if (baked) {
      url = baked;
    } else {
      const res = await fetch(SPEECH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, rate: rate ?? null }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok || !isCurrent()) return false;
      const blob = await res.blob();
      if (!blob.size || !isCurrent()) return false;
      url = URL.createObjectURL(blob);
      revoke = true;
    }
    const el = new Audio(url);
    const release = () => {
      if (revoke) URL.revokeObjectURL(url);
      if (clipRef.current === el) clipRef.current = null;
    };
    el.onended = () => {
      release();
      if (!isCurrent()) return;
      setSpeaking(false);
      onEnd?.('ended');
    };
    el.onerror = () => {
      release();
      if (!isCurrent()) return;
      setSpeaking(false);
      onEnd?.('failed');
    };
    clipRef.current = el;
    setSpeaking(true);
    // Paused before the clip was ready: hold it here; resume() starts it.
    if (!isPaused()) await el.play();
    return true;
  } catch {
    return false;
  }
}

export function useSpeech() {
  const { audio } = useAppState();
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPausedState] = useState(false);
  const pausedRef = useRef(false);
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null);
  const clipRef = useRef<HTMLAudioElement | null>(null);
  const generation = useRef(0);

  const setPaused = useCallback((value: boolean) => {
    pausedRef.current = value;
    setPausedState(value);
  }, []);

  const stop = useCallback(() => {
    generation.current += 1;
    const ss = synth();
    if (ss) {
      ss.cancel();
      // Some engines keep the paused flag across cancel(); clear it so the next line plays.
      if (ss.paused) ss.resume();
    }
    utterRef.current = null;
    if (clipRef.current) {
      clipRef.current.pause();
      clipRef.current.src = '';
      clipRef.current = null;
    }
    setPaused(false);
    setSpeaking(false);
  }, [setPaused]);

  const speakWithBrowser = useCallback((text: string, rate: number | undefined, token: number, onEnd?: (reason: SpeechEnd) => void) => {
    const ss = synth();
    if (!ss) {
      onEnd?.('failed');
      return false;
    }
    ss.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate ?? 0.92;
    const done = (reason: SpeechEnd) => {
      if (generation.current !== token) return;
      if (utterRef.current === u) utterRef.current = null;
      setSpeaking(false);
      onEnd?.(reason);
    };
    u.onend = () => done('ended');
    // 'interrupted' and 'canceled' come from our own stop(); the token check above ignores them.
    u.onerror = () => done('failed');
    utterRef.current = u;
    setSpeaking(true);
    ss.speak(u);
    // Paused while the clip was being fetched: queue the utterance but hold it.
    if (pausedRef.current) ss.pause();
    return true;
  }, []);

  /**
   * Speak a line. Returns false when audio is off (unless `force`). `onEnd` fires once
   * with 'ended' after playback, or 'failed' if the audio was blocked or unavailable.
   * Starting a line clears any pause.
   */
  const speak = useCallback(
    (text: string, opts: { rate?: number; force?: boolean; onEnd?: (reason: SpeechEnd) => void } = {}) => {
      if (!audio && !opts.force) return false;
      stop();
      const token = generation.current;
      void (async () => {
        const played = await playCartesia(
          text,
          opts.rate,
          clipRef,
          setSpeaking,
          () => generation.current === token,
          () => pausedRef.current,
          opts.onEnd,
        );
        if (generation.current !== token) return;
        if (!played) speakWithBrowser(text, opts.rate, token, opts.onEnd);
      })();
      return true;
    },
    [audio, speakWithBrowser, stop],
  );

  /**
   * Hold the current line where it is. Does not end it: `onEnd` waits for resume().
   * With nothing playing, the next line to start stays held until resume().
   */
  const pause = useCallback(() => {
    setPaused(true);
    clipRef.current?.pause();
    synth()?.pause();
  }, [setPaused]);

  /** Continue a held line, or let a held-at-start line begin. */
  const resume = useCallback(() => {
    setPaused(false);
    const el = clipRef.current;
    // A blocked play() reports through the element's error path, so onEnd('failed') still fires.
    if (el) void el.play().catch(() => el.dispatchEvent(new Event('error')));
    synth()?.resume();
  }, [setPaused]);

  // Turning audio off stops anything playing.
  useEffect(() => {
    if (!audio) stop();
  }, [audio, stop]);

  useEffect(() => stop, [stop]);

  return { speak, stop, pause, resume, paused, speaking, available: synth() !== null };
}
