import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppState } from '../state/AppState';

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

async function playCartesia(
  text: string,
  rate: number | undefined,
  clipRef: { current: HTMLAudioElement | null },
  setSpeaking: (value: boolean) => void,
  isCurrent: () => boolean,
  onEnd?: (reason: SpeechEnd) => void,
): Promise<boolean> {
  try {
    const res = await fetch(SPEECH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, rate: rate ?? null }),
    });
    if (!res.ok || !isCurrent()) return false;
    const blob = await res.blob();
    if (!blob.size || !isCurrent()) return false;
    const url = URL.createObjectURL(blob);
    const el = new Audio(url);
    el.onended = () => {
      URL.revokeObjectURL(url);
      if (!isCurrent()) return;
      setSpeaking(false);
      onEnd?.('ended');
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      if (!isCurrent()) return;
      setSpeaking(false);
      onEnd?.('failed');
    };
    clipRef.current = el;
    setSpeaking(true);
    await el.play();
    return true;
  } catch {
    return false;
  }
}

export function useSpeech() {
  const { audio } = useAppState();
  const [speaking, setSpeaking] = useState(false);
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null);
  const clipRef = useRef<HTMLAudioElement | null>(null);
  const generation = useRef(0);

  const stop = useCallback(() => {
    generation.current += 1;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    if (clipRef.current) {
      clipRef.current.pause();
      clipRef.current.src = '';
      clipRef.current = null;
    }
    setSpeaking(false);
  }, []);

  const speakWithBrowser = useCallback((text: string, rate: number | undefined, token: number, onEnd?: (reason: SpeechEnd) => void) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      onEnd?.('failed');
      return false;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate ?? 0.92;
    const done = (reason: SpeechEnd) => {
      if (generation.current !== token) return;
      setSpeaking(false);
      onEnd?.(reason);
    };
    u.onend = () => done('ended');
    // 'interrupted' and 'canceled' come from our own stop(); the token check above ignores them.
    u.onerror = () => done('failed');
    utterRef.current = u;
    setSpeaking(true);
    window.speechSynthesis.speak(u);
    return true;
  }, []);

  /**
   * Speak a line. Returns false when audio is off (unless `force`). `onEnd` fires once
   * with 'ended' after playback, or 'failed' if the audio was blocked or unavailable.
   */
  const speak = useCallback(
    (text: string, opts: { rate?: number; force?: boolean; onEnd?: (reason: SpeechEnd) => void } = {}) => {
      if (!audio && !opts.force) return false;
      stop();
      const token = generation.current;
      void (async () => {
        const played = await playCartesia(text, opts.rate, clipRef, setSpeaking, () => generation.current === token, opts.onEnd);
        if (generation.current !== token) return;
        if (!played) speakWithBrowser(text, opts.rate, token, opts.onEnd);
      })();
      return true;
    },
    [audio, speakWithBrowser, stop],
  );

  // Turning audio off stops anything playing.
  useEffect(() => {
    if (!audio) stop();
  }, [audio, stop]);

  useEffect(() => stop, [stop]);

  return { speak, stop, speaking, available: typeof window !== 'undefined' && 'speechSynthesis' in window };
}
