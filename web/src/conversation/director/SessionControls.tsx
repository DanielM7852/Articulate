import { Mic, Repeat, SkipForward, Square } from 'lucide-react';
import type { ControlKind } from './api';
import type { DirectorState } from './useSessionDirector';
import './director.css';

type InterruptMode = 'auto' | 'headphones' | 'off';
type BargeMode = 'aec' | 'gated' | 'headphones' | 'off';

const toInterrupt = (m: BargeMode): InterruptMode => (m === 'headphones' ? 'headphones' : m === 'off' ? 'off' : 'auto');
const toBarge: Record<InterruptMode, BargeMode> = { auto: 'gated', headphones: 'headphones', off: 'off' };

/** Status chip: text first, never color alone. Polite live region so screen readers hear state changes. */
export function SessionStatus({ state, label }: { state: DirectorState; label: string }) {
  return (
    <span className={`sd-status sd-status--${state}`} role="status" aria-live="polite">
      <span className="sd-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Visible (not only spoken) note that a deeper analysis of the last attempt is running in the background. */
export function InsightBadge() {
  return (
    <span className="sd-insight" role="status" aria-live="polite">
      <span className="sd-insight-dot" aria-hidden="true" />
      Taking a closer look…
    </span>
  );
}

/** Always-visible tap controls for a running session, so nothing depends on voice or hearing. */
export function SessionControls({
  state,
  onControl,
  bargeInMode,
  onBargeInMode,
}: {
  state: DirectorState;
  onControl: (c: ControlKind) => void;
  bargeInMode: BargeMode;
  onBargeInMode: (m: BargeMode) => void;
}) {
  const busy = state === 'starting';
  return (
    <div className="sd-controls" role="group" aria-label="Session controls">
      <button type="button" className="btn btn--sm" onClick={() => onControl('ready')} disabled={busy}>
        <Mic size={16} aria-hidden="true" /> I’m ready
      </button>
      <button type="button" className="btn btn--sm" onClick={() => onControl('show_again')} disabled={busy}>
        <Repeat size={16} aria-hidden="true" /> Show me again
      </button>
      <button type="button" className="btn btn--sm" onClick={() => onControl('skip')} disabled={busy}>
        <SkipForward size={16} aria-hidden="true" /> Skip
      </button>
      <button type="button" className="btn btn--sm sd-end" onClick={() => onControl('end')} disabled={busy}>
        <Square size={14} aria-hidden="true" /> End session
      </button>
      <label className="sd-interrupt">
        <span className="ob-fine">Interrupting</span>
        <select
          value={toInterrupt(bargeInMode)}
          onChange={(e) => onBargeInMode(toBarge[e.target.value as InterruptMode])}
          aria-label="Interrupting"
        >
          <option value="auto">Auto</option>
          <option value="headphones">Headphones</option>
          <option value="off">Off</option>
        </select>
      </label>
    </div>
  );
}
