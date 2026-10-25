import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines } from 'lucide-react';
import { Segmented } from './Onboarding';
import type { VoiceFrames } from '../audio/useVoiceFrames';
import type { VoiceFrame } from '../game/types';
import type { GhostVoiceGroup } from '../game/ghost/types';
import {
  DEFAULT_FACTOR,
  anchorsConsistent,
  frontAnchorOk,
  voiceFactor,
  vowelAnchor,
  type AnchorId,
  type VowelAnchor,
} from '../game/ghost/voice';
import '../styles/voice-check.css';

/**
 * Voice check: the learner holds "uh" for about a second, then "eee", "ah" and "oo", then says whether they are
 * a man, woman, boy or girl. voiceFactor() turns the "uh" and the group into one ln size factor that the ghost
 * board uses to size the model to their voice. The vowel medians (Hz) are only the vowel graph's personal targets;
 * "eh" (head) and "a" (had) come after the three corner vowels, and one that lands in the wrong place is dropped.
 */
export type { AnchorId, VowelAnchor };
export interface StoredVoice {
  factor: number;
  group: GhostVoiceGroup | null;
  vowels?: Partial<Record<AnchorId, VowelAnchor>>;
}

export const VOICE_STORAGE_KEY = 'articulate.voice';
const GROUPS: GhostVoiceGroup[] = ['man', 'woman', 'boy', 'girl'];
const GROUP_LABEL: Record<GhostVoiceGroup, string> = { man: 'Man', woman: 'Woman', boy: 'Boy', girl: 'Girl' };

/** Voiced frames wanted (25 ms apart, so 40 is about a second) and how long to wait for them. */
const TARGET_VOICED = 40;
const LISTEN_TIMEOUT_MS = 8000;
/** Frames in the first moments of a vowel hold are skipped, so the end of the last sound is not counted. */
const SETTLE_MS = 700;

const VOWELS: AnchorId[] = ['i', 'a', 'u', 'eh', 'ae'];
const VOWEL_TEXT: Record<AnchorId, { say: string; label: string }> = {
  i: { say: '“eee” as in see', label: 'eee' },
  a: { say: '“ah” as in father', label: 'ah' },
  u: { say: '“oo” as in boot', label: 'oo' },
  eh: { say: '“eh” as in head', label: 'eh' },
  ae: { say: '“a” as in had', label: 'a' },
};

/** The stored vowel medians that are usable; a bad entry is dropped, and null when none is left. */
function readVowels(raw: unknown): StoredVoice['vowels'] | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Partial<Record<AnchorId, VowelAnchor>> = {};
  for (const id of VOWELS) {
    const v = (raw as Record<string, Partial<VowelAnchor> | undefined>)[id];
    if (v && Number.isFinite(v.f1) && Number.isFinite(v.f2) && v.f1! > 0 && v.f2! > 0) {
      out[id] = { f1: v.f1!, f2: v.f2!, n: Number.isFinite(v.n) ? v.n! : 0 };
    }
  }
  return Object.keys(out).length ? out : null;
}

/** The saved voice, or null when none is stored (or storage is unavailable). The lesson works without storage. */
export function readStoredVoice(): StoredVoice | null {
  try {
    const raw = localStorage.getItem(VOICE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredVoice>;
    if (typeof parsed.factor !== 'number' || !Number.isFinite(parsed.factor)) return null;
    const group = GROUPS.includes(parsed.group as GhostVoiceGroup) ? (parsed.group as GhostVoiceGroup) : null;
    const vowels = readVowels(parsed.vowels);
    return vowels ? { factor: parsed.factor, group, vowels } : { factor: parsed.factor, group };
  } catch {
    return null;
  }
}

export function storeVoice(voice: StoredVoice): void {
  try {
    localStorage.setItem(VOICE_STORAGE_KEY, JSON.stringify(voice));
    window.dispatchEvent(new Event('articulate:voice'));
  } catch {
    /* storage blocked: the voice is kept for this session only */
  }
}

type Stage = 'listen' | 'group' | 'retry' | 'vowelRetry' | 'alike';
type Hold = 'uh' | AnchorId;
const HOLDS: Hold[] = ['uh', ...VOWELS];

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
  const [hold, setHold] = useState<Hold>('uh');
  const [group, setGroup] = useState<GhostVoiceGroup | undefined>(undefined);
  const [voicedCount, setVoicedCount] = useState(0);
  const [reason, setReason] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const heard = useRef<VoiceFrame[]>([]);
  const uhFrames = useRef<VoiceFrame[]>([]);
  const vowels = useRef<Partial<Record<AnchorId, VowelAnchor>>>({});
  const redone = useRef(false);

  // After a vowel is captured or skipped: the next vowel, or the group pick once all are done. The three corner
  // vowels are checked against each other before "eh" and "a" are asked for.
  const nextVowel = useCallback((from: AnchorId) => {
    const next = VOWELS[VOWELS.indexOf(from) + 1];
    if (from !== 'u' && next) {
      setHold(next);
      setStage('listen');
    } else if (!next) {
      setStage('group');
    } else if (anchorsConsistent(vowels.current)) {
      setHold(next);
      setStage('listen');
    } else {
      vowels.current = {};
      if (redone.current) {
        setStage('group');
      } else {
        redone.current = true;
        setStage('alike');
      }
    }
  }, []);

  // Listen for the held sound: keep the voiced frames, stop when about a second is in or the time is up.
  useEffect(() => {
    if (stage !== 'listen' || !ready) return;
    heard.current = [];
    setVoicedCount(0);
    const startedAt = performance.now();
    let count = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      off();
      clearTimeout(timer);
      if (hold === 'uh') {
        uhFrames.current = heard.current;
        // A short "uh" is retried now, not after the three vowels (the group does not change the point count).
        const check = voiceFactor(heard.current, 'man');
        if (!check.ok) {
          setReason(check.reason ?? 'That could not be measured.');
          setStage('retry');
          return;
        }
        setHold('i');
        return;
      }
      const anchor = vowelAnchor(heard.current);
      if (anchor) {
        // An "eh" or "a" in the wrong place is dropped without a word; the flow carries on.
        if ((hold !== 'eh' && hold !== 'ae') || frontAnchorOk(hold, anchor, vowels.current)) vowels.current[hold] = anchor;
        nextVowel(hold);
      } else {
        setStage('vowelRetry');
      }
    };
    const off = frames.subscribe((frame) => {
      if (!frame.voiced) return;
      if (hold !== 'uh' && (frame.f1 === undefined || frame.f2 === undefined || performance.now() - startedAt < SETTLE_MS)) return;
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
  }, [stage, hold, ready, frames.subscribe, attempt, nextVowel]);

  const choose = useCallback(
    (g: GhostVoiceGroup) => {
      setGroup(g);
      const result = voiceFactor(uhFrames.current, g);
      if (result.ok) {
        const captured = vowels.current;
        onDone(Object.keys(captured).length ? { factor: result.factor, group: g, vowels: captured } : { factor: result.factor, group: g }, true);
        return;
      }
      setReason(result.reason ?? 'That could not be measured.');
      setStage('retry');
    },
    [onDone],
  );

  // Start again from "uh".
  const retry = () => {
    setReason(null);
    setGroup(undefined);
    vowels.current = {};
    redone.current = false;
    setHold('uh');
    setAttempt((n) => n + 1);
    setStage('listen');
  };

  const retryVowel = () => {
    setAttempt((n) => n + 1);
    setStage('listen');
  };

  const redoVowels = () => {
    setHold('i');
    setAttempt((n) => n + 1);
    setStage('listen');
  };

  const pct = Math.min(100, Math.round((voicedCount / TARGET_VOICED) * 100));
  const step = HOLDS.indexOf(hold);
  const vowelText = hold === 'uh' ? null : VOWEL_TEXT[hold];

  return (
    <div className="vc" role="group" aria-label="Voice check">
      <div className="vc-icon" aria-hidden="true">
        <AudioLines size={26} />
      </div>
      {stage === 'listen' && (
        <>
          <h2 className="vc-title">Hold {vowelText ? vowelText.say : '“uh”'} for about a second</h2>
          <p className="vc-text">
            {vowelText ? 'Say it steadily. This sets your own vowel targets.' : 'This sizes the ghost to your voice. Say it steadily, like a relaxed “uh”.'}
          </p>
          <ol className="vc-steps" aria-label="Sounds">
            {HOLDS.map((h, i) => (
              <li key={h} className={i < step ? 'done' : i === step ? 'now' : undefined} aria-current={i === step ? 'step' : undefined}>
                {h === 'uh' ? 'uh' : VOWEL_TEXT[h].label}
              </li>
            ))}
          </ol>
          <div className="vc-meter" role="progressbar" aria-label="Voice heard" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ width: `${pct}%` }} />
          </div>
          {!ready && <p className="vc-note">Waiting for the microphone…</p>}
        </>
      )}
      {stage === 'vowelRetry' && (
        <>
          <h2 className="vc-title">Let’s try “{vowelText?.label}” again</h2>
          <p className="vc-text" role="alert">
            That was too short to measure. Hold {vowelText?.say} a little longer.
          </p>
          <div className="vc-actions">
            <button type="button" className="ob-cta" onClick={retryVowel}>
              Try again
            </button>
            <button type="button" className="ob-text-btn" onClick={() => hold !== 'uh' && nextVowel(hold)}>
              Skip this sound
            </button>
          </div>
        </>
      )}
      {stage === 'alike' && (
        <>
          <h2 className="vc-title">Let’s try the three sounds again</h2>
          <p className="vc-text" role="alert">
            Those sounded alike — let’s try the three sounds again.
          </p>
          <div className="vc-actions">
            <button type="button" className="ob-cta" onClick={redoVowels}>
              Try again
            </button>
          </div>
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
