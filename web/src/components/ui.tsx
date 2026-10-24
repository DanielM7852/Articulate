import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Check } from 'lucide-react';

export function BrandMark({ size = 29 }: { size?: number }) {
  return (
    <svg width={Math.round(size * 0.93)} height={size} viewBox="0 0 30 32" aria-hidden="true">
      <path fill="#203e68" d="M11.6 0h6.8L30 32h-7l-2.4-7H9.4L7 32H0L11.6 0Zm7.2 19.4L15 8.2l-3.8 11.2h7.6Z" />
    </svg>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary';
  size?: 'md' | 'sm' | 'block';
  icon?: ReactNode;
};

export function Button({ variant = 'secondary', size = 'md', icon, className = '', children, ...rest }: ButtonProps) {
  const cls = ['btn', variant === 'primary' && 'btn--primary', size === 'sm' && 'btn--sm', size === 'block' && 'btn--block', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={cls} {...rest}>
      {icon}
      {children}
    </button>
  );
}

/** A segmented single-choice button (pace, comfort, self report). */
export function ChoiceButton({ selected, children, onClick }: { selected: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="btn btn--sm btn--choice" aria-pressed={selected} onClick={onClick}>
      {children}
      {selected && <Check size={14} aria-hidden="true" />}
    </button>
  );
}

export function Badge({
  tone = 'info',
  live,
  children,
}: {
  tone?: 'info' | 'neutral' | 'success' | 'warn';
  live?: boolean;
  children: ReactNode;
}) {
  const cls = ['badge', tone !== 'info' && `badge--${tone}`, live && 'badge--live'].filter(Boolean).join(' ');
  return <span className={cls}>{children}</span>;
}

export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`eyebrow ${className}`}>{children}</p>;
}

/** Caption row shown next to every spoken or audio element. */
export function Caption({ children }: { children: ReactNode }) {
  return (
    <div className="captions-strip" role="note">
      <Badge>CC</Badge>
      <p className="fine grow">{children}</p>
    </div>
  );
}
