import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { AssemblyOptions, MouthCueId, MouthDemo, MouthView, SpeakOptions, SpeechHandle } from '@mouth-demo/src/mouth-demo.js';
import { acquireGuide, releaseGuide } from '../guide/guide';
import type { SoundId } from '../state/types';

/**
 * The 3D guide: the mouth-demo workstream's hologram face, mounted inside React.
 * The face itself is a session singleton (see guide.ts), so mounting this
 * component on a new screen just moves it there. Screens draw their own captions
 * and controls around it, turn the head toward the learner (`look`), move the
 * camera closer (`zoom`) and can freeze it (`paused`). A ref exposes the demo's
 * imperative surface (cues, view, lip-synced `speak`) for session-driven screens.
 */
export type { MouthCueId, MouthView };

export const CUE_FOR_SOUND: Record<SoundId, MouthCueId> = {
  i: 'spread-lips',
  u: 'round-lips',
  a: 'open-jaw',
};

export const cueForSound = (sound: SoundId) => CUE_FOR_SOUND[sound];

export type Look = { x: number; y: number };
type LoadState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

export interface MouthReferenceHandle {
  readonly ready: boolean;
  setView(v: MouthView): Promise<void>;
  showCue(id: MouthCueId): void;
  stop(): void;
  /** Lip-synced speech on the guide; null until the guide is ready. */
  speak(opts: SpeakOptions): SpeechHandle | null;
  /** Build the particle head from the stage. Resolves true when assembled, false if interrupted or not ready. */
  assemble(opts?: AssemblyOptions): Promise<boolean>;
  /** Dissolve the particle head. Resolves true when gone, false if interrupted or not ready. */
  disperse(opts?: AssemblyOptions): Promise<boolean>;
  /**
   * While dispersed, draw the particle head's dots as this image, laid out in `rect` (viewport px, e.g. an
   * element's getBoundingClientRect()); assemble() then morphs it into the head. Resolves true when the
   * picture is on stage, false if the guide is not ready or not the particle style.
   */
  setStartShapeFromImage(opts: { src: string; rect: DOMRectReadOnly; fit?: 'fill' | 'cover' | 'contain' }): Promise<boolean>;
  /** Back to the default fly-in (after a morph in progress). The guide also does this when it leaves the screen. */
  clearStartShape(): void;
  /** Wash the stage toward a flat CSS colour; null returns to the default gradient. Reset when it leaves the screen. */
  setBackdrop(color: string | null, opts?: { durationMs?: number }): void;
}

export interface MouthReferenceProps {
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
  /** Open on an empty stage (only the ambient particles); the screen calls assemble() through the ref. */
  startDispersed?: boolean;
}

export const MouthReference = forwardRef<MouthReferenceHandle, MouthReferenceProps>(function MouthReference(
  { cue, view = 'front', slow = false, look = null, zoom = 1, paused = false, onReady, onError, startDispersed = false },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const demoRef = useRef<MouthDemo | null>(null);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useImperativeHandle(
    ref,
    () => ({
      get ready() {
        return demoRef.current !== null;
      },
      async setView(v) {
        await demoRef.current?.setView(v);
      },
      showCue(id) {
        demoRef.current?.showCue(id);
      },
      stop() {
        demoRef.current?.stop();
      },
      speak(opts) {
        return demoRef.current?.speak(opts) ?? null;
      },
      assemble(opts) {
        return demoRef.current?.assemble(opts) ?? Promise.resolve(false);
      },
      disperse(opts) {
        return demoRef.current?.disperse(opts) ?? Promise.resolve(false);
      },
      setStartShapeFromImage({ src, rect, fit }) {
        const demo = demoRef.current;
        const host = hostRef.current;
        if (!demo || !host) return Promise.resolve(false);
        // the box is relative to the demo's canvas host
        const origin = (host.querySelector('.md-canvas-host') ?? host).getBoundingClientRect();
        const box = { x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height };
        return demo.setStartShapeFromImage({ src, box, fit });
      },
      clearStartShape() {
        demoRef.current?.setStartShape(null);
      },
      setBackdrop(color, opts) {
        demoRef.current?.setBackdrop(color, opts);
      },
    }),
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    acquireGuide(host, { startDispersed })
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
      // a screen's start picture and backdrop do not follow the guide to the next screen
      demoRef.current?.setStartShape(null);
      demoRef.current?.setBackdrop(null);
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
});
