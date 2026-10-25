import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronLeft, Gauge, Volume2, VolumeX, X } from 'lucide-react';
import { useAppState } from '../state/AppState';
import { setQualitySetting, useQuality, type QualitySetting } from '../guide/quality';

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
  bar = 'full',
  actions = true,
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
  /**
   * full: back, progress and access toggles in their own row.
   * float: no row; only the toggles, floating over the stage's top-right corner.
   * none: nothing; the screen places `AccessToggles` itself.
   */
  bar?: 'full' | 'float' | 'none';
  /** false removes the action bar; the screen floats its own buttons over the stage. */
  actions?: boolean;
  children: ReactNode;
}) {
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
      {bar !== 'none' && (
      <header className={`ob-bar ${bar === 'float' ? 'ob-bar--float' : ''}`}>
        {bar === 'float' ? null : onClose ? (
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
        {bar === 'float' ? null : progress ? (
          <Progress step={step} total={total} label={progressLabel} />
        ) : (
          <span className="grow" aria-hidden="true" />
        )}
        <AccessToggles />
      </header>
      )}

      <main id="ob-stage" className="ob-stage" ref={stageRef}>
        <div key={stageKey} className={['ob-content', className].filter(Boolean).join(' ')}>
          {children}
        </div>
      </main>

      {caption && <div className="ob-caption">{caption}</div>}

      {actions && (
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
      )}
      {overlay}
    </div>
  );
}

/** Captions and audio toggles. Every screen keeps them within reach. */
export function AccessToggles() {
  const { captions, setCaptions, audio, setAudio } = useAppState();
  return (
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
      <QualityToggle />
    </div>
  );
}

const QUALITY_OPTIONS: { id: QualitySetting; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'Matches this device' },
  { id: 'full', label: 'Full', hint: 'The full 3D guide' },
  { id: 'light', label: 'Light', hint: 'Fewer dots, smoother' },
  { id: 'simple', label: 'Simple view', hint: 'A picture and the mouth diagram' },
];
const TIER_LABEL = { full: 'Full', light: 'Light', simple: 'Simple' } as const;

/**
 * How the guide is drawn: Auto (the device decides and steps down if it struggles) or a pinned tier.
 * Shown only while a screen shows the guide. The choice is stored and applied at once. The menu is portalled
 * to <body> and placed under the pill, so the screens' stacked stages never cover it.
 */
function QualityToggle() {
  const { setting, tier, guideShown } = useQuality();
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = at !== null;
  const close = useCallback(() => setAt(null), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      close();
      btn.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    // focus the chosen option so the menu is usable from the keyboard
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  if (!guideShown) return null;
  const shown = setting === 'auto' ? (tier ? `Auto · ${TIER_LABEL[tier]}` : 'Auto') : TIER_LABEL[setting];
  const toggle = () => {
    if (open) return close();
    const r = btn.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  };
  const choose = (id: QualitySetting) => {
    setQualitySetting(id);
    close();
    btn.current?.focus();
  };
  return (
    <div className="ob-quality">
      <button
        ref={btn}
        type="button"
        className="ob-pill ob-quality-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Display quality: ${shown}`}
        title={`Display quality: ${shown}`}
        onClick={toggle}
      >
        <Gauge size={16} aria-hidden="true" />
        {setting !== 'auto' && <span className="ob-quality-tag">{TIER_LABEL[setting]}</span>}
      </button>
      {at && createPortal(
        <div ref={menu} className="ob-quality-menu" role="menu" aria-label="Display quality" style={{ top: at.top, right: at.right }}>
          {QUALITY_OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              role="menuitemradio"
              aria-checked={setting === o.id}
              className="ob-quality-item"
              onClick={() => choose(o.id)}
            >
              <span className="ob-quality-copy">
                <span className="ob-quality-label">
                  {o.label}
                  {o.id === 'auto' && tier ? <span className="ob-quality-now"> · now {TIER_LABEL[tier].toLowerCase()}</span> : null}
                </span>
                <span className="ob-quality-hint">{o.hint}</span>
              </span>
              <Check size={15} strokeWidth={2.6} aria-hidden="true" className="ob-quality-check" />
            </button>
          ))}
        </div>,
        document.body,
      )}
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
