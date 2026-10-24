import { useEffect, useRef, useState } from 'react';
import type { MouthCueId, MouthDemo, MouthView } from '@mouth-demo/src/mouth-demo.js';
import { acquireGuide, releaseGuide } from '../guide/guide';
import type { SoundId } from '../state/types';

/**
 * The 3D guide: the mouth-demo workstream's hologram face, mounted inside React.
 * The face itself is a session singleton (see guide.ts), so mounting this
 * component on a new screen just moves it there. Screens draw their own captions
 * and controls around it, turn the head toward the learner (`look`), move the
 * camera closer (`zoom`) and can freeze it (`paused`).
 */
export type { MouthCueId, MouthView };

const CUE_FOR_SOUND: Record<SoundId, MouthCueId> = {
  i: 'spread-lips',
  u: 'round-lips',
  a: 'open-jaw',
};

export const cueForSound = (sound: SoundId) => CUE_FOR_SOUND[sound];

export type Look = { x: number; y: number };
type LoadState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

export function MouthReference({
  cue,
  view = 'front',
  slow = false,
  look = null,
  zoom = 1,
  paused = false,
  onReady,
  onError,
}: {
  /** Mouth shape to loop; null rests the face. */
  cue: MouthCueId | null;
  view?: MouthView;
  slow?: boolean;
  /** Where the learner is, -1 to 1 on each axis; null lets the head rest. */
  look?: Look | null;
  zoom?: number;
  /** Freeze the face and its choreography. */
  paused?: boolean;
  onReady?: () => void;
  /** The 3D guide could not load; the screen should carry on without it. */
  onError?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const demoRef = useRef<MouthDemo | null>(null);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    acquireGuide(host)
      .then((demo) => {
        if (cancelled) return;
        demoRef.current = demo;
        setState({ kind: 'ready' });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        console.error('[guide] could not load:', err);
        setState({ kind: 'error', message });
      });
    return () => {
      cancelled = true;
      demoRef.current = null;
      releaseGuide(host);
    };
  }, []);

  const ready = state.kind === 'ready';
  useEffect(() => {
    if (ready) onReady?.();
    if (state.kind === 'error') onError?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind]);

  // Props apply once the demo is here and again whenever they change.
  useEffect(() => {
    if (!ready) return;
    if (cue) demoRef.current?.showCue(cue);
    else demoRef.current?.stop();
  }, [cue, ready]);
  useEffect(() => {
    if (ready) void demoRef.current?.setView(view);
  }, [view, ready]);
  useEffect(() => {
    if (ready) demoRef.current?.setSpeed(slow ? 0.5 : 1);
  }, [slow, ready]);
  useEffect(() => {
    if (ready) demoRef.current?.lookAt(look);
  }, [look, ready]);
  useEffect(() => {
    if (ready) demoRef.current?.setZoom(zoom);
  }, [zoom, ready]);
  useEffect(() => {
    if (!ready) return;
    if (paused) demoRef.current?.pause();
    else demoRef.current?.resume();
  }, [paused, ready]);

  return (
    <div className="mr" data-state={state.kind}>
      <div className="mr-host" ref={hostRef} aria-hidden="true" />
      <div className="mr-cover" role="status" aria-live="polite">
        {state.kind === 'error' ? (
          <>
            <p className="ob-label">The guide couldn’t load</p>
            <p className="ob-fine">{state.message}</p>
            <p className="ob-fine">Try reloading the page. The written cues still apply.</p>
          </>
        ) : (
          <>
            <span className="mr-spinner" aria-hidden="true" />
            <p className="ob-fine">{state.kind === 'loading' ? 'Loading your guide…' : ''}</p>
          </>
        )}
      </div>
    </div>
  );
}
