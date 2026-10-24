import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowRight, CheckCircle2, Mic, Play, TriangleAlert, Volume2, X } from 'lucide-react';
import { Segmented } from './Onboarding';
import type { CoachResponse } from '../services/coach';
import type { Attempt } from '../state/types';

/**
 * Post-recording result: a compact floating sheet, not a full-width slab, so the
 * graph and the mouth guide stay visible behind it.
 *
 * One clear path: the coach's next action picks a single primary button (try
 * again, or move on to trying without cues) and the other choice sits beside it
 * as plain text. The sheet can be dismissed with the close button, Escape, or by
 * dragging it down. The drag tracks the pointer 1:1, rubber-bands upward, and
 * uses release velocity to decide whether to dismiss or settle back.
 */
const FEELINGS = [
  { id: 'too-hard', label: 'Too hard' },
  { id: 'okay', label: 'Okay' },
  { id: 'ready', label: 'Ready for more' },
] as const;

type Feeling = NonNullable<Attempt['feeling']>;

/** Where a flick would come to rest, in px (exponential deceleration). */
const project = (velocity: number, rate = 0.998) => ((velocity / 1000) * rate) / (1 - rate);
/** Progressive resistance past a boundary. */
const rubberband = (over: number, dim: number, c = 0.55) => (over * dim * c) / (dim + c * Math.abs(over));
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const currentY = (el: HTMLElement) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;

export function ResultSheet({
  attempt,
  coach,
  leaving,
  feeling,
  onFeeling,
  onReplay,
  onReadAloud,
  onTryAgain,
  onOnMyOwn,
  onNextSound,
  onDismiss,
  mode = 'guided',
  compare = null,
  retryLabel,
}: {
  attempt: Attempt;
  coach: CoachResponse | null;
  /** The parent closed the sheet, for example by starting a new recording. */
  leaving: boolean;
  feeling: Attempt['feeling'];
  onFeeling: (id: Feeling) => void;
  onReplay?: () => void;
  onReadAloud: () => void;
  onTryAgain: () => void;
  /** Guided mode: move on to an attempt without task-specific cues. */
  onOnMyOwn?: () => void;
  /** Independent mode: continue with the next sound, cues back on. */
  onNextSound?: () => void;
  /** Close the sheet and return to the studio. */
  onDismiss: () => void;
  /** Independent attempts are reported next to the guided best, never merged with it. */
  mode?: 'guided' | 'independent';
  /** Best guided voiced seconds for this sound, shown beside an independent result. */
  compare?: number | null;
  /** Overrides the retry button text for hands-free sessions that have no Record button. */
  retryLabel?: string;
}) {
  const usable = attempt.quality === 'usable';
  const independent = mode === 'independent';
  const ref = useRef<HTMLElement>(null);
  const gone = useRef(false);
  const drag = useRef<{ start: number; base: number; hist: { y: number; t: number }[] } | null>(null);

  /* ---------- Next step ---------- */
  const action = feeling === 'ready' ? 'reduce-assistance' : feeling === 'too-hard' ? 'simplify' : coach?.nextAction;
  const advance = !independent && usable && (action === 'reduce-assistance' || action === 'next-context') && !!onOnMyOwn;
  const primary = advance
    ? { label: 'Try on my own', icon: <ArrowRight size={18} aria-hidden="true" />, run: onOnMyOwn! }
    : { label: retryLabel ?? (usable ? 'Try again' : 'Record again'), icon: <Mic size={18} aria-hidden="true" />, run: onTryAgain };
  const secondary = !usable
    ? null
    : independent
      ? onNextSound && { label: 'Next sound', run: onNextSound }
      : advance
        ? { label: 'Practice once more', run: onTryAgain }
        : onOnMyOwn && { label: 'Try on my own', run: onOnMyOwn };
  const title = usable ? (independent ? 'Got it, on your own' : 'Got it') : 'Let’s try that capture again';
  const sub = usable
    ? independent
      ? 'No cues this time. Describes the sound only, not a score.'
      : 'Describes the sound only, not a pronunciation score.'
    : 'That’s a capture issue, not a mistake.';

  /* ---------- Motion ---------- */
  const offscreen = () => (ref.current?.offsetHeight ?? 400) + 32;

  /** Slide out along the entry path, starting from wherever the sheet is now. */
  const exit = useCallback((then?: () => void, durationMs = 240) => {
    const el = ref.current;
    if (!el || gone.current) return;
    gone.current = true;
    const y = currentY(el);
    el.style.animation = 'none';
    el.style.transition = 'none';
    el.style.transform = `translateY(${y}px)`;
    void el.offsetHeight; // commit the start position before transitioning
    const reduced = reducedMotion();
    if (reduced) {
      el.style.transition = 'opacity 160ms ease';
      el.style.opacity = '0';
    } else {
      el.style.transition = `transform ${durationMs}ms cubic-bezier(0.32, 0, 0.67, 0)`;
      el.style.transform = `translateY(${offscreen()}px)`;
    }
    if (then) setTimeout(then, reduced ? 160 : durationMs);
  }, []);

  const dismiss = useCallback(() => exit(onDismiss), [exit, onDismiss]);

  useEffect(() => {
    if (leaving) exit();
  }, [leaving, exit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !gone.current) dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismiss]);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el || gone.current || e.button !== 0 || (e.target as Element).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Start from the on-screen position so grabbing mid-entrance never jumps.
    const base = currentY(el);
    el.style.animation = 'none';
    el.style.transition = 'none';
    el.style.transform = `translateY(${base}px)`;
    drag.current = { start: e.clientY, base, hist: [{ y: e.clientY, t: e.timeStamp }] };
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el) return;
    const raw = d.base + e.clientY - d.start;
    const y = raw >= 0 ? raw : rubberband(raw, el.offsetHeight);
    el.style.transform = `translateY(${y}px)`;
    d.hist = [...d.hist.filter((p) => e.timeStamp - p.t < 100), { y: e.clientY, t: e.timeStamp }];
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    const el = ref.current;
    drag.current = null;
    if (!d || !el) return;
    const first = d.hist[0];
    const dt = e.timeStamp - first.t;
    const velocity = dt > 0 ? ((e.clientY - first.y) / dt) * 1000 : 0;
    const y = Math.max(0, d.base + e.clientY - d.start);
    if (y + project(velocity) > el.offsetHeight * 0.45) {
      // Carry the flick's speed into the exit.
      const remaining = offscreen() - y;
      const ms = velocity > 0 ? (remaining / velocity) * 1600 : 280;
      exit(onDismiss, Math.round(Math.min(320, Math.max(160, ms))));
    } else {
      el.style.transition = 'transform 420ms var(--ease-drawer)';
      el.style.transform = 'translateY(0px)';
    }
  }

  const metrics = [
    { value: attempt.usableVoicedSec, label: independent ? 'of voice, on your own' : 'of voice' },
    attempt.timeInTargetSec != null ? { value: attempt.timeInTargetSec, label: 'in target' } : null,
    attempt.longestHoldSec != null ? { value: attempt.longestHoldSec, label: 'longest hold' } : null,
    independent && compare != null ? { value: compare, label: 'best with cues' } : null,
  ].filter((m): m is { value: number; label: string } => m !== null);

  return (
    <section
      ref={ref}
      className={`lp-sheet ${usable ? 'lp-sheet--ok' : 'lp-sheet--warn'}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby="lp-sheet-title"
      aria-busy={!coach}
    >
      <div
        className="lp-sheet-grab"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span className="lp-sheet-handle" aria-hidden="true" />
        <div className="lp-sheet-head">
          <span className="lp-sheet-icon" aria-hidden="true">
            {usable ? <CheckCircle2 size={20} /> : <TriangleAlert size={19} />}
          </span>
          <div className="grow">
            <h2 className="lp-sheet-title" id="lp-sheet-title">
              {title}
            </h2>
            <p className="lp-sheet-sub">{sub}</p>
          </div>
          <button
            type="button"
            className="lp-round"
            aria-label="Read feedback aloud"
            title="Read feedback aloud"
            onClick={onReadAloud}
            disabled={!coach}
          >
            <Volume2 size={17} aria-hidden="true" />
          </button>
          <button type="button" className="lp-round" aria-label="Close and keep practicing" title="Close" onClick={dismiss}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="lp-sheet-body">
        {usable && (
          <ul className="lp-metrics" aria-label="What was measured">
            {metrics.map((m) => (
              <li key={m.label} className="lp-metric">
                <strong>{m.value.toFixed(1)} s</strong> {m.label}
              </li>
            ))}
          </ul>
        )}

        <div className="lp-coach" aria-live="polite">
          {coach ? (
            <>
              <p className="lp-observation">{coach.observation}</p>
              <div className="lp-cue">
                <p className="lp-cue-label">Next try</p>
                <p>{coach.nextCue}</p>
              </div>
            </>
          ) : (
            <div className="lp-skeleton" role="status" aria-label="Reading your attempt">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>

        {usable && (
          <div className="lp-feel">
            <span className="lp-feel-label">How did that feel?</span>
            <Segmented label="How did that feel?" options={[...FEELINGS]} value={feeling} onChange={onFeeling} />
          </div>
        )}
      </div>

      <div className="lp-sheet-actions">
        <button type="button" className="ob-text-btn lp-replay" onClick={onReplay} disabled={!onReplay}>
          <Play size={16} aria-hidden="true" /> Replay mine
        </button>
        <div className="lp-sheet-path">
          {secondary && (
            <button type="button" className="ob-text-btn" onClick={secondary.run} disabled={!coach}>
              {secondary.label}
            </button>
          )}
          <button type="button" className="ob-cta lp-sheet-cta" onClick={primary.run} disabled={!coach}>
            {primary.icon}
            {primary.label}
          </button>
        </div>
      </div>
    </section>
  );
}
