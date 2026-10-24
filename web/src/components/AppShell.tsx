import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Volume2, VolumeX } from 'lucide-react';
import { useAppState } from '../state/AppState';
import { BrandMark } from './ui';

/**
 * Shared page frame: navigation with persistent access controls and a footer.
 * Captions and audio are real toggles here (not static badges) so the learner
 * controls them from any screen.
 */
export function AppShell({
  context,
  footerNote = 'Your pace. Your choice.',
  inLesson,
  children,
}: {
  context: string;
  footerNote?: string;
  inLesson?: boolean;
  children: ReactNode;
}) {
  const { captions, setCaptions, audio, setAudio } = useAppState();
  const navigate = useNavigate();

  return (
    <div className="app-shell">
      <a href="#main" className="sr-only">
        Skip to content
      </a>
      <header className="nav">
        <Link to="/" className="brand" aria-label="Articulate home">
          <BrandMark />
          <span className="brand-word">articulate</span>
          <span className="brand-divider" aria-hidden="true" />
          <span className="brand-context">{context}</span>
        </Link>
        <div className="nav-controls">
          <button
            type="button"
            className={`badge ${captions ? '' : 'badge--neutral'}`}
            aria-pressed={captions}
            onClick={() => setCaptions(!captions)}
          >
            CC&nbsp; Captions {captions ? 'on' : 'off'}
          </button>
          <button type="button" className="btn btn--sm" aria-pressed={audio} onClick={() => setAudio(!audio)}>
            {audio ? <Volume2 size={17} aria-hidden="true" /> : <VolumeX size={17} aria-hidden="true" />}
            Audio {audio ? 'on' : 'off'}
          </button>
          {inLesson ? (
            <button type="button" className="text-link" onClick={() => navigate('/summary')}>
              Pause / finish
            </button>
          ) : (
            <a className="text-link" href="#help">
              Get help
            </a>
          )}
        </div>
      </header>
      <main id="main" className="app-main">
        {children}
      </main>
      <footer className="footer">
        <span>© 2026 Articulate</span>
        <span>{footerNote}</span>
        <a className="text-link" href="#privacy" style={{ fontSize: 12 }}>
          Privacy &amp; accessibility
        </a>
      </footer>
    </div>
  );
}
