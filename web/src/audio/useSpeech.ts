import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppState } from '../state/AppState';

/**
 * Spoken narration and reference playback.
 *
 * Today this uses the browser's speechSynthesis so the flow works offline.
 * Swap `speakWithProvider` for the Cartesia streaming client when the backend is
 * ready; the UI contract (speak / stop / speaking) stays the same.
 * Text is always shown on screen too; audio is optional by design.
 */
export function useSpeech() {
  const { audio } = useAppState();
  const [speaking, setSpeaking] = useState(false);
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null);

  const stop = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    (text: string, opts: { rate?: number; force?: boolean } = {}) => {
      if (!audio && !opts.force) return false;
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = opts.rate ?? 0.92;
      u.onend = () => setSpeaking(false);
      u.onerror = () => setSpeaking(false);
      utterRef.current = u;
      setSpeaking(true);
      window.speechSynthesis.speak(u);
      return true;
    },
    [audio],
  );

  // Turning audio off stops anything playing.
  useEffect(() => {
    if (!audio) stop();
  }, [audio, stop]);

  useEffect(() => stop, [stop]);

  return { speak, stop, speaking, available: typeof window !== 'undefined' && 'speechSynthesis' in window };
}
