import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, LogIn, Sparkle } from 'lucide-react';
import { BrandMark, Button } from '../components/ui';
import { useAppState } from '../state/AppState';
import { SOUNDS, SOUND_ORDER } from '../state/types';

/**
 * Sign in. Demo auth only: no credentials leave the browser.
 * Returning learners go straight to practice (per the flow map); "Sign up" starts onboarding.
 */
export default function SignIn() {
  const navigate = useNavigate();
  const { signIn } = useAppState();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    signIn(email.split('@')[0] || 'Learner', true);
    navigate('/practice');
  }

  return (
    <div className="signin">
      <div className="signin-auth">
        <div className="brand">
          <BrandMark size={32} />
          <span className="brand-word" style={{ fontSize: 25 }}>
            articulate
          </span>
        </div>

        <form className="signin-form stack gap-32" onSubmit={submit} aria-labelledby="signin-title">
          <div className="stack gap-14">
            <h1 id="signin-title" className="serif" style={{ fontSize: 40, lineHeight: 1.25 }}>
              Welcome back.
            </h1>
            <p className="body">Pick up your speech practice where you left off.</p>
          </div>

          <div className="stack gap-24">
            <Button
              size="block"
              icon={<LogIn size={18} aria-hidden="true" />}
              onClick={() => {
                signIn('Learner', true);
                navigate('/practice');
              }}
              style={{ fontWeight: 500, fontSize: 14 }}
            >
              Log in with Google
            </Button>

            <div className="row" style={{ gap: 16 }}>
              <hr className="rule grow" />
              <span className="fine">or continue with email</span>
              <hr className="rule grow" />
            </div>

            <div className="stack gap-20">
              <label className="field">
                <span className="field-label">Email address</span>
                <input
                  className="input"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="row row--between">
                  <span className="field-label">Password</span>
                  <a className="text-link" href="#forgot">
                    Forgot password?
                  </a>
                </span>
                <span className="input-wrap">
                  <input
                    className="input"
                    type={show ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    className="input-icon"
                    aria-label={show ? 'Hide password' : 'Show password'}
                    onClick={() => setShow(!show)}
                  >
                    {show ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </span>
              </label>
            </div>

            <button type="submit" className="btn btn--primary btn--block">
              Sign in
            </button>
          </div>

          <p className="small" style={{ fontSize: 14, textAlign: 'center' }}>
            New to Articulate?{' '}
            <button type="button" className="text-link underline" style={{ fontSize: 14 }} onClick={() => navigate('/welcome')}>
              Sign up
            </button>
          </p>
        </form>

        <div className="row row--between fine" style={{ width: '100%' }}>
          <span>© 2026 Articulate</span>
          <span className="row" style={{ gap: 20 }}>
            <a className="text-link muted" href="#privacy" style={{ fontSize: 12 }}>
              Privacy
            </a>
            <a className="text-link muted" href="#help" style={{ fontSize: 12 }}>
              Get help
            </a>
          </span>
        </div>
      </div>

      <aside className="signin-story panel-navy" aria-label="About Articulate">
        <div className="row" style={{ gap: 10 }}>
          <span style={{ width: 22, height: 1, background: 'var(--color-navy-mist)' }} aria-hidden="true" />
          <p className="eyebrow" style={{ color: 'var(--color-ivory)' }}>
            Visual speech practice
          </p>
        </div>

        <div className="stack gap-28">
          <div className="stack gap-22">
            <p className="serif" style={{ fontSize: 46, lineHeight: 1.22 }}>
              See your voice.
              <br />
              Practice at your pace.
            </p>
            <p className="on-navy-muted" style={{ maxWidth: 440, lineHeight: 1.7 }}>
              For deaf and hard-of-hearing people who choose to practice spoken communication. Every instruction is
              visual and captioned; sound is always optional.
            </p>
          </div>

          <div className="vowel-triangle" aria-hidden="true">
            {SOUND_ORDER.map((id) => (
              <div key={id} className={`vowel-node vowel-node--${id}`}>
                <span className="serif">{SOUNDS[id].ipa}</span>
                <span>
                  {SOUNDS[id].spelled} · {SOUNDS[id].example}
                </span>
              </div>
            ))}
            <svg className="vowel-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
              <polygon points="14,18 86,18 50,86" fill="none" stroke="rgba(203,215,230,0.45)" strokeDasharray="1.5 1.5" strokeWidth="0.4" />
            </svg>
          </div>
        </div>

        <div className="row row--between" style={{ borderTop: '1px solid var(--color-rule-on-navy)', paddingTop: 24 }}>
          <p className="on-navy-muted fine" style={{ color: 'var(--color-navy-mist)' }}>
            Your sound, made visible. Your choices, always.
          </p>
          <Sparkle size={22} aria-hidden="true" color="var(--color-ivory)" />
        </div>
      </aside>
    </div>
  );
}
