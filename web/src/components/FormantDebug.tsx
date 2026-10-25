import { useEffect, useState } from 'react';
import type { VoiceFrames } from '../audio/useVoiceFrames';
import type { VoiceFrame } from '../game/types';
import { ghostPullReference } from '../game/ghost/models';
import { TARGETS } from '../vowel/targets';
import { anchorDistance } from '../vowel/pull';
import '../styles/formant-debug.css';

/** Display refresh in ms: frames arrive every 25 ms, far faster than a readout can be read. */
const REFRESH_MS = 100;

const enabled = () => {
  try {
    return new URLSearchParams(location.search).has('debug');
  } catch {
    return false;
  }
};

const hz = (v: number | undefined) => (v === undefined ? '-' : Math.round(v).toString());

const ANCHOR_ROWS = ['i', 'u', 'a', 'eh', 'ae'] as const;
type AnchorRow = (typeof ANCHOR_ROWS)[number];

/** The stored voice as far as this readout needs it (see StoredVoice in VoiceCheck). */
interface DebugVoice {
  factor: number;
  vowels?: Partial<Record<AnchorRow, { f1: number; f2: number; n?: number }>>;
}

/** Distance from the factor-sized reference to an anchor, in the radii the pull uses (ghost for i/eh/ae, vowel graph for u/a). */
function radii(id: AnchorRow, a: { f1: number; f2: number }, scale: number): string {
  const sized = (r: { f1: number; f2: number }) => ({ f1: r.f1 * scale, f2: r.f2 * scale });
  if (id === 'u' || id === 'a') {
    const t = TARGETS[id];
    return anchorDistance(sized(t), a, t.rf1, t.rf2).toFixed(2);
  }
  const g = ghostPullReference(id);
  return anchorDistance(sized(g.ref), a, g.r).toFixed(2);
}

/**
 * Calibration readout, shown only with `?debug` in the URL: live raw formants, the stored voice factor and
 * the per-vowel anchors. Pass `frames` for the full frame, or just `point` where only the tracker's latest
 * F1/F2 exist. Never opens a microphone of its own.
 */
export function FormantDebug({
  frames,
  point,
  voice,
}: {
  frames?: VoiceFrames;
  point?: { f1: number; f2: number } | null;
  voice?: DebugVoice | null;
}) {
  const on = enabled();
  const [frame, setFrame] = useState<VoiceFrame | null>(null);
  const [bursts, setBursts] = useState(0);

  useEffect(() => {
    if (!on || !frames) return;
    let last = 0;
    let count = 0;
    return frames.subscribe((f) => {
      if (f.burst) count++;
      if (f.timestampMs - last < REFRESH_MS) return;
      last = f.timestampMs;
      setFrame(f);
      setBursts(count);
    });
  }, [on, frames]);

  if (!on) return null;
  const f1 = frame ? frame.f1 : point?.f1;
  const f2 = frame ? frame.f2 : point?.f2;
  const db = frame && frame.rms > 0 ? (20 * Math.log10(frame.rms)).toFixed(1) : '-inf';
  const scale = voice ? Math.exp(voice.factor) : 1;
  return (
    <aside className="fd" aria-label="Formant debug readout">
      <div>
        F1 {hz(f1)} · F2 {hz(f2)} · F3 {hz(frame?.f3)} Hz
      </div>
      {frame && (
        <div>
          per {frame.periodicity.toFixed(2)} · rms {db} dBFS · {frame.voiced ? 'voiced' : 'unvoiced'}
          {frame.clipped ? ' · CLIPPED' : ''} · bursts {bursts}
        </div>
      )}
      <div>
        {voice
          ? `factor ${voice.factor.toFixed(3)} (x${scale.toFixed(3)}, ${Math.round((scale - 1) * 100)}%)`
          : 'no stored voice'}
      </div>
      {ANCHOR_ROWS.map((id) => {
        const a = voice?.vowels?.[id];
        return (
          <div key={id}>
            {id}: {a ? `${hz(a.f1)} / ${hz(a.f2)}${a.n !== undefined ? ` (n=${a.n})` : ''}` : 'no anchor'}
            {a && ` · ${radii(id, a, scale)} radii from reference`}
          </div>
        );
      })}
    </aside>
  );
}
