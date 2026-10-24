import { useEffect, useRef, useState } from 'react';
import type { MouthCueId, MouthDemo, MouthView } from '@mouth-demo/src/mouth-demo.js';
import avatarUrl from '@mouth-demo/public/avatars/brunette.glb?url';
import type { SoundId } from '../state/types';

/**
 * The 3D guide: the mouth-demo workstream's hologram face mounted inside React.
 * three.js, the avatar and the choreography load on first use. The demo loops a
 * cue silently; screens draw their own captions and controls around it, and can
 * turn the head toward the learner (`look`) and move the camera closer (`zoom`).
 */
export type { MouthCueId, MouthView };

const CUE_FOR_SOUND: Record<SoundId, MouthCueId> = {
  i: 'spread-lips',
  u: 'round-lips',
  a: 'open-jaw',
};

export const cueForSound = (sound: SoundId) => CUE_FOR_SOUND[sound];

export type Look = { x: number; y: number };
type LoadState = 'loading' | 'ready' | 'error';

export function MouthReference({
  cue,
  view = 'front',
  slow = false,
  look = null,
  zoom = 1,
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
  onReady?: () => void;
  /** The 3D guide could not load; the screen should carry on without it. */
  onError?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const demoRef = useRef<MouthDemo | null>(null);
  const [state, setState] = useState<LoadState>('loading');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let demo: MouthDemo | null = null;
    setState('loading');
    import('@mouth-demo/src/mouth-demo.js')
      .then((m) => m.createMouthDemo(host, { avatarUrl, controls: false }))
      .then((d) => {
        if (cancelled) {
          d.dispose();
          return;
        }
        demo = d;
        demoRef.current = d;
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
      demo?.dispose();
      demoRef.current = null;
    };
  }, []);

  const ready = state === 'ready';
  useEffect(() => {
    if (ready) onReady?.();
    if (state === 'error') onError?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Props apply once the demo exists and again whenever they change.
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

  return (
    <div className="mr" data-state={state}>
      <div className="mr-host" ref={hostRef} aria-hidden="true" />
      <div className="mr-cover" role="status" aria-live="polite">
        {state === 'error' ? (
          <>
            <p className="ob-label">The guide couldn’t load</p>
            <p className="ob-fine">This device may not support 3D here. The written cues still apply.</p>
          </>
        ) : (
          <>
            <span className="mr-spinner" aria-hidden="true" />
            <p className="ob-fine">{state === 'loading' ? 'Loading your guide…' : ''}</p>
          </>
        )}
      </div>
    </div>
  );
}
