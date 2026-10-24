import { useEffect, useRef, useState } from 'react';
import type { MouthCueId, MouthDemo, MouthView } from '@mouth-demo/src/mouth-demo.js';
import avatarUrl from '@mouth-demo/public/avatars/brunette.glb?url';
import type { SoundId } from '../state/types';

/**
 * The rotatable 3D mouth reference: the mouth-demo workstream's hologram face,
 * mounted inside a React tile. three.js, the avatar and the choreography load on
 * first use so onboarding never pays for them. The demo loops the cue silently;
 * the practice screen draws its own overlays and controls around it.
 */
export type { MouthView };

const CUE_FOR_SOUND: Record<SoundId, MouthCueId> = {
  i: 'spread-lips',
  u: 'round-lips',
  a: 'open-jaw',
};

type LoadState = 'loading' | 'ready' | 'error';

export function MouthReference({ sound, view, slow }: { sound: SoundId; view: MouthView; slow: boolean }) {
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

  // Props apply once the demo exists and again whenever they change.
  useEffect(() => {
    if (state === 'ready') demoRef.current?.showCue(CUE_FOR_SOUND[sound]);
  }, [sound, state]);
  useEffect(() => {
    if (state === 'ready') void demoRef.current?.setView(view);
  }, [view, state]);
  useEffect(() => {
    if (state === 'ready') demoRef.current?.setSpeed(slow ? 0.5 : 1);
  }, [slow, state]);

  return (
    <div className="mr" data-state={state}>
      <div className="mr-host" ref={hostRef} aria-hidden="true" />
      <div className="mr-cover" role="status" aria-live="polite">
        {state === 'error' ? (
          <>
            <p className="ob-label">The mouth guide couldn’t load</p>
            <p className="ob-fine">This device may not support 3D here. The written cue still applies.</p>
          </>
        ) : (
          <>
            <span className="mr-spinner" aria-hidden="true" />
            <p className="ob-fine">{state === 'loading' ? 'Loading the mouth guide…' : ''}</p>
          </>
        )}
      </div>
    </div>
  );
}
