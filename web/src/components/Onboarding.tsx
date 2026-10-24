import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronLeft, Volume2, VolumeX, X } from 'lucide-react';
import { useAppState } from '../state/AppState';

/**
 * Onboarding frame, Duolingo-style: one question per screen, locked to the viewport.
 * Top bar (back, progress, access toggles), a centered stage, and a fixed action bar,
 * so the learner never scrolls to find Continue.
 *
 * Step order: guide intro (0), quiz 1-3, tutorial (4).
 */
export const ONBOARDING_STEPS = 4;

type Direction = 'forward' | 'back';
type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => unknown };

/**
 * Run a state change as a directional page transition. The old stage is snapshotted
 * and slides out (View Transitions API); the new stage's children stagger in from the
 * same side, so the motion reverses on Back. Browsers without the API just swap.
 */
export function stepTransition(update: () => void, dir: Direction = 'forward') {
  document.documentElement.dataset.obDir = dir;
  const doc = document as ViewTransitionDocument;
  if (!doc.startViewTransition) return update();
  doc.startViewTransition(() => flushSync(update));
}

/** navigate() wrapped in a directional step transition. */
export function useStepNav() {
  const navigate = useNavigate();
  return useCallback((to: string, dir: Direction = 'forward') => stepTransition(() => navigate(to), dir), [navigate]);
}

/* Each screen mounts its own frame; remembering the last value per flow lets the bar grow from where it was. */
const lastProgress = new Map<string, number>();

function Progress({ step, total, label }: { step: number; total: number; label: string }) {
  const value = step / total;
  const [shown, setShown] = useState(() => lastProgress.get(label) ?? 0);
  useEffect(() => {
    lastProgress.set(label, value);
    const raf = requestAnimationFrame(() => setShown(value));
    return () => cancelAnimationFrame(raf);
  }, [label, value]);

  return (
    <div
      className="ob-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={step}
    >
      <span className="ob-progress-fill" style={{ clipPath: `inset(0 ${(1 - shown) * 100}% 0 0 round 99px)` }} />
    </div>
  );
}

interface Action {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon?: ReactNode;
}

export function OnboardingFrame({
  step,
  total = ONBOARDING_STEPS,
  progressLabel = 'Onboarding progress',
  stageKey = String(step),
  onBack,
  onClose,
  primary,
  secondary,
  footer,
  caption,
  overlay,
  width,
  className = '',
  progress = true,
  children,
}: {
  step: number;
  total?: number;
  progressLabel?: string;
  /** Changes whenever the stage content changes, so the entrance replays. */
  stageKey?: string;
  onBack?: () => void;
  /** Shows a close (✕) button in place of Back. */
  onClose?: { label: string; onClick: () => void };
  primary?: Action;
  secondary?: Action;
  /** Replaces the primary/secondary action bar contents. */
  footer?: ReactNode;
  /** The guide's caption, rendered between the stage and the action bar. */
  caption?: ReactNode;
  /** Rendered over the action bar, e.g. a result sheet. */
  overlay?: ReactNode;
  /** Column width in px; 640 by default. */
  width?: number;
  className?: string;
  /** false hides the progress bar (the intro, before the learner has started). */
  progress?: boolean;
  children: ReactNode;
}) {
  const { captions, setCaptions, audio, setAudio } = useAppState();
  const stageRef = useRef<HTMLDivElement>(null);

  // Move focus to the new question so screen readers announce it.
  useEffect(() => {
    stageRef.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
  }, [stageKey]);

  return (
    <div className="ob" style={width ? ({ '--ob-width': `${width}px` } as CSSProperties) : undefined}>
      <a href="#ob-stage" className="sr-only">
        Skip to content
      </a>
      <header className="ob-bar">
        {onClose ? (
          <button type="button" className="ob-icon-btn" aria-label={onClose.label} title={onClose.label} onClick={onClose.onClick}>
            <X size={22} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="ob-icon-btn"
            aria-label="Back"
            onClick={onBack}
            style={onBack ? undefined : { visibility: 'hidden' }}
          >
            <ChevronLeft size={22} aria-hidden="true" />
          </button>
        )}
        {progress ? <Progress step={step} total={total} label={progressLabel} /> : <span className="grow" aria-hidden="true" />}
        <div className="ob-access">
          <button
            type="button"
            className="ob-pill"
            aria-pressed={captions}
            aria-label={`Captions ${captions ? 'on' : 'off'}`}
            title={`Captions ${captions ? 'on' : 'off'}`}
            onClick={() => setCaptions(!captions)}
          >
            CC
          </button>
          <button
            type="button"
            className="ob-pill"
            aria-pressed={audio}
            aria-label={`Audio ${audio ? 'on' : 'off'}`}
            title={`Audio ${audio ? 'on' : 'off'}`}
            onClick={() => setAudio(!audio)}
          >
            {audio ? <Volume2 size={17} aria-hidden="true" /> : <VolumeX size={17} aria-hidden="true" />}
          </button>
        </div>
      </header>

      <main id="ob-stage" className="ob-stage" ref={stageRef}>
        <div key={stageKey} className={['ob-content', className].filter(Boolean).join(' ')}>
          {children}
        </div>
      </main>

      {caption && <div className="ob-caption">{caption}</div>}

      <footer className="ob-actions">
        <div className="ob-actions-inner">
          {footer ?? (
            <>
              {secondary ? (
                <button type="button" className="ob-text-btn" onClick={secondary.onClick} disabled={secondary.disabled}>
                  {secondary.label}
                </button>
              ) : (
                <span />
              )}
              {primary && (
                <button type="button" className="ob-cta" onClick={primary.onClick} disabled={primary.disabled}>
                  {primary.label}
                  {primary.icon}
                </button>
              )}
            </>
          )}
        </div>
      </footer>
      {overlay}
    </div>
  );
}

/** Question heading + one-line hint. */
export function StepHeading({ title, hint, eyebrow }: { title: ReactNode; hint?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="ob-heading">
      {eyebrow && <p className="ob-eyebrow">{eyebrow}</p>}
      <h1 className="ob-title" tabIndex={-1}>
        {title}
      </h1>
      {hint && <p className="ob-hint">{hint}</p>}
    </div>
  );
}

/** Tappable answer card. Radio by default; checkbox when `multi`. */
export function OptionCard({
  title,
  description,
  icon,
  checked,
  multi,
  onToggle,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  checked: boolean;
  multi?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role={multi ? 'checkbox' : 'radio'}
      aria-checked={checked}
      className="ob-option"
      onClick={onToggle}
    >
      {icon && (
        <span className="ob-option-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="ob-option-copy">
        <span className="ob-option-title">{title}</span>
        {description && <span className="ob-option-desc">{description}</span>}
      </span>
      <span className={`ob-check ${multi ? 'ob-check--square' : ''}`} aria-hidden="true">
        <Check size={13} strokeWidth={3.2} />
      </span>
    </button>
  );
}

/** iOS-style segmented control with a sliding thumb. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  className = '',
}: {
  label: string;
  options: { id: T; label: ReactNode }[];
  /** Undefined means nothing chosen yet; the thumb stays hidden. */
  value: T | undefined;
  onChange: (id: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  const index = options.findIndex((o) => o.id === value);
  return (
    <div
      className={`ob-segmented ${className}`}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        className="ob-segmented-thumb"
        aria-hidden="true"
        style={{
          width: `calc((100% - 8px) / ${options.length})`,
          transform: `translateX(${Math.max(0, index) * 100}%)`,
          opacity: index < 0 ? 0 : 1,
        }}
      />
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          disabled={disabled && o.id !== value}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="ob-switch" onClick={() => onChange(!checked)}>
      <span className="ob-switch-thumb" />
    </button>
  );
}
