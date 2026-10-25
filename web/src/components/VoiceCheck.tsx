import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines } from 'lucide-react';
import { Segmented } from './Onboarding';
import type { VoiceFrames } from '../audio/useVoiceFrames';
import type { VoiceFrame } from '../game/types';
import type { GhostVoiceGroup } from '../game/ghost/types';
import { DEFAULT_FACTOR, voiceFactor } from '../game/ghost/voice';
import '../styles/voice-check.css';

/**
 * Voice check: the learner holds "uh" for about a second, then says whether they are a man, woman, boy or girl.
 * voiceFactor() turns both into one ln size factor that the ghost board uses to size the model to their voice.
 */
export interface StoredVoice {
  factor: number;
  group: GhostVoiceGroup | null;
}

export const VOICE_STORAGE_KEY = 'articulate.voice';
const GROUPS: GhostVoiceGroup[] = ['man', 'woman', 'boy', 'girl'];
const GROUP_LABEL: Record<GhostVoiceGroup, string> = { man: 'Man', woman: 'Woman', boy: 'Boy', girl: 'Girl' };

/** Voiced frames wanted (25 ms apart, so 40 is about a second) and how long to wait for them. */
const TARGET_VOICED = 40;
const LISTEN_TIMEOUT_MS = 8000;

/** The saved voice, or null when none is stored (or storage is unavailable). The lesson works without storage. */
export function readStoredVoice(): StoredVoice | null {
  try {
    const raw = localStorage.getItem(VOICE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredVoice>;
    if (typeof parsed.factor !== 'number' || !Number.isFinite(parsed.factor)) return null;
    const group = GROUPS.includes(parsed.group as GhostVoiceGroup) ? (parsed.group as GhostVoiceGroup) : null;
    return { factor: parsed.factor, group };
  } catch {
    return null;
  }
}

export function storeVoice(voice: StoredVoice): void {
  try {
    localStorage.setItem(VOICE_STORAGE_KEY, JSON.stringify(voice));
  } catch {
    /* storage blocked: the voice is kept for this session only */
  }
}

type Stage = 'listen' | 'group' | 'retry';

export function VoiceCheck({
  frames,
  ready,
  onDone,
}: {
  frames: VoiceFrames;
  /** The microphone is open and being tracked. */
  ready: boolean;
  /** `stored` is false for a skip: the default size is used for this session only. */
  onDone: (voice: StoredVoice, stored: boolean) => void;
}) {
  const [stage, setStage] = useState<Stage>('listen');
  const [group, setGroup] = useState<GhostVoiceGroup | undefined>(undefined);
  const [voicedCount, setVoicedCount] = useState(0);
  const [reason, setReason] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const heard = useRef<VoiceFrame[]>([]);

  // Listen for the held "uh": keep the voiced frames, stop when about a second is in or the time is up.
  useEffect(() => {
    if (stage !== 'listen' || !ready) return;
    heard.current = [];
    setVoicedCount(0);
    let count = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      off();
      clearTimeout(timer);
      setStage('group');
    };
    const off = frames.subscribe((frame) => {
      if (!frame.voiced) return;
      heard.current.push(frame);
      count++;
      if (count % 4 === 0 || count >= TARGET_VOICED) setVoicedCount(count);
      if (count >= TARGET_VOICED) finish();
    });
    const timer = setTimeout(finish, LISTEN_TIMEOUT_MS);
    return () => {
      finished = true;
      off();
      clearTimeout(timer);
    };
  }, [stage, ready, frames.subscribe, attempt]);

  const choose = useCallback(
    (g: GhostVoiceGroup) => {
      setGroup(g);
      const result = voiceFactor(heard.current, g);
      if (result.ok) {
        onDone({ factor: result.factor, group: g }, true);
        return;
      }
      setReason(result.reason ?? 'That could not be measured.');
      setStage('retry');
    },
    [onDone],
  );

  const retry = () => {
    setReason(null);
    setGroup(undefined);
    setAttempt((n) => n + 1);
    setStage('listen');
  };

  const pct = Math.min(100, Math.round((voicedCount / TARGET_VOICED) * 100));

  return (
    <div className="vc" role="group" aria-label="Voice check">
      <div className="vc-icon" aria-hidden="true">
        <AudioLines size={26} />
      </div>
      {stage === 'listen' && (
        <>
          <h2 className="vc-title">Hold “uh” for about a second</h2>
          <p className="vc-text">This sizes the ghost to your voice. Say it steadily, like a relaxed “uh”.</p>
          <div className="vc-meter" role="progressbar" aria-label="Voice heard" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ width: `${pct}%` }} />
          </div>
          {!ready && <p className="vc-note">Waiting for the microphone…</p>}
        </>
      )}
      {stage === 'group' && (
        <>
          <h2 className="vc-title">Whose voice is this?</h2>
          <p className="vc-text">Pick the closest. It only changes the size of the ghost.</p>
          <Segmented<GhostVoiceGroup>
            className="vc-seg"
            label="Voice group"
            value={group}
            onChange={choose}
            options={GROUPS.map((g) => ({ id: g, label: GROUP_LABEL[g] }))}
          />
        </>
      )}
      {stage === 'retry' && (
        <>
          <h2 className="vc-title">Let’s try that again</h2>
          <p className="vc-text" role="alert">
            {reason}
          </p>
          <div className="vc-actions">
            <button type="button" className="ob-cta" onClick={retry}>
              Try again
            </button>
            <button type="button" className="ob-text-btn" onClick={() => onDone({ factor: DEFAULT_FACTOR, group: null }, false)}>
              Skip
            </button>
          </div>
        </>
      )}
    </div>
  );
}
