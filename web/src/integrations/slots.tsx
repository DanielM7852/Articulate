/**
 * Integration slots for the two pieces built by other teammates.
 *
 *   1. VowelSpace   - the live F1/F2 cursor graph (measurement + graph owner)
 *   2. ReferenceModel - the rotatable 3D mouth reference (visual owner)
 *
 * Replace the placeholder body of each component with the real one; the props
 * below are the contract the rest of the UI already passes. Nothing else in the
 * app needs to change.
 */
import type { SoundId } from '../state/types';
import type { GraphMode, RefView } from '../components/practice';
import { Activity, Box } from 'lucide-react';

export interface VowelSpaceProps {
  /** Which vowel target region to draw. */
  sound: SoundId;
  /**
   * preview: show target region + idle cursor, not recording
   * live:    recording; plot valid frames, fade cursor on silence/invalid capture
   * review:  show the last attempt's trace
   * hidden:  independent attempt; draw nothing task-specific
   */
  mode: GraphMode;
  /** Microphone stream from the page's capture (null until the learner grants access). */
  stream: MediaStream | null;
}

export function VowelSpace({ mode }: VowelSpaceProps) {
  if (mode === 'hidden') {
    return (
      <div className="slot" style={{ height: 270 }}>
        <p className="small">Cursor, target, and hold ring are hidden for this attempt.</p>
      </div>
    );
  }
  return (
    <div className="slot" style={{ height: 270 }} data-slot="vowel-space">
      <Activity size={22} aria-hidden="true" color="var(--color-navy)" />
      <p className="small ink strong">F1 / F2 vowel space</p>
      <p className="fine" style={{ maxWidth: 340 }}>
        Graph component mounts here (src/integrations/slots.tsx). F2 decreases left to right, F1 increases top to
        bottom. Mode: {mode}.
      </p>
    </div>
  );
}

export interface ReferenceModelProps {
  sound: SoundId;
  view: RefView;
}

export function ReferenceModel({ sound, view }: ReferenceModelProps) {
  return (
    <div className="slot" style={{ height: '100%', borderRadius: 6 }} data-slot="reference-model">
      <Box size={22} aria-hidden="true" color="var(--color-navy)" />
      <p className="small ink strong">3D mouth reference</p>
      <p className="fine" style={{ maxWidth: 320 }}>
        Three.js model mounts here (src/integrations/slots.tsx). Pose: /{sound}/ · view: {view}.
      </p>
    </div>
  );
}
