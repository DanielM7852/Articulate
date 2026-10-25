import { useEffect, useState } from 'react';
import { readStoredVoice, type StoredVoice } from '../components/VoiceCheck';

/**
 * The saved voice (factor, group, per-vowel anchors), re-read when the warm-up saves a new one
 * ('articulate:voice') or another tab changes storage, so targets update right after the warm-up.
 * Null when nothing is stored.
 */
export function useStoredVoice(): StoredVoice | null {
  const [voice, setVoice] = useState<StoredVoice | null>(() => readStoredVoice());
  useEffect(() => {
    const reread = () => setVoice(readStoredVoice());
    window.addEventListener('articulate:voice', reread);
    window.addEventListener('storage', reread);
    return () => {
      window.removeEventListener('articulate:voice', reread);
      window.removeEventListener('storage', reread);
    };
  }, []);
  return voice;
}
