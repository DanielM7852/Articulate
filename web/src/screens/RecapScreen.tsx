import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Mail } from 'lucide-react';
import {
  RecapHttpError, emailRecap, getRecap, rememberRecapEmail, rememberedRecapEmail,
  type Recap, type RecapEmailStatus, type RecapStatus, type RecapTrend,
} from '../live/recap';
import { learnerProfileId } from '../state/learnerId';
import '../styles/recap.css';

const POLL_MS = 2000;
const GIVE_UP_MS = 3 * 60 * 1000;
const PROGRESS_LINES = ["Looking at today's practice…", 'Finding ideas you can use today…'];

const TREND_TEXT: Record<RecapTrend, string> = {
  improving: 'Getting better',
  same: 'About the same',
  new: 'New today',
  harder: 'Harder than before',
};

type View =
  | { kind: 'loading' }
  | { kind: 'status'; status: RecapStatus }
  | { kind: 'gone' }
  | { kind: 'error'; message: string }
  | { kind: 'slow' };

function emailMessage(status: RecapEmailStatus, to: string | null): string | null {
  switch (status) {
    case 'queued': return "We'll email it when it's ready.";
    case 'sent': return `Sent to ${to ?? 'your address'}.`;
    case 'failed': return "The email didn't go through. Check the address and try again.";
    case 'not_configured': return "Email isn't set up yet.";
    default: return null;
  }
}

function EmailBox({ status, onUpdate, recapId }: { status: RecapStatus; onUpdate: (s: RecapStatus) => void; recapId: string }) {
  const [email, setEmail] = useState(() => status.emailTo ?? rememberedRecapEmail());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const message = emailMessage(status.emailStatus, status.emailTo);
  const showForm = !message || changing;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      rememberRecapEmail(address);
      onUpdate(await emailRecap(recapId, learnerProfileId(), address));
      setChanging(false);
    } catch (err) {
      setError(err instanceof RecapHttpError && err.status === 422
        ? "That doesn't look like an email address. Check it and try again."
        : "Couldn't send that request. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="recap-email" aria-labelledby="recap-email-h">
      <h2 id="recap-email-h" className="recap-h2">Email me this</h2>
      {message && (
        <p className="recap-email__status" role="status">{message}</p>
      )}
      {showForm ? (
        <form onSubmit={submit} className="recap-email__form">
          <label htmlFor="recap-email-input" className="recap-email__label">Email address</label>
          <div className="recap-email__row">
            <input
              id="recap-email-input" type="email" autoComplete="email" required
              value={email} onChange={(e) => setEmail(e.target.value)}
              aria-describedby={error ? 'recap-email-err' : undefined}
            />
            <button type="submit" className="btn btn--primary" disabled={busy}>
              <Mail size={16} aria-hidden="true" /> {busy ? 'Sending…' : 'Email me this'}
            </button>
          </div>
          {error && <p id="recap-email-err" className="recap-error" role="alert">{error}</p>}
        </form>
      ) : (
        <button type="button" className="btn btn--sm" onClick={() => setChanging(true)}>Send to a different address</button>
      )}
    </section>
  );
}

function RecapBody({ recap, headingRef }: { recap: Recap; headingRef: RefObject<HTMLHeadingElement> }) {
  return (
    <>
      <header className="recap-head">
        <p className="recap-eyebrow">Your recap</p>
        <h1 className="recap-title" tabIndex={-1} ref={headingRef}>{recap.headline}</h1>
        <p className="recap-lede">{recap.summary}</p>
      </header>

      {recap.wins.length > 0 && (
        <section aria-labelledby="recap-wins-h">
          <h2 id="recap-wins-h" className="recap-h2">What went well</h2>
          <ul className="recap-list">
            {recap.wins.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </section>
      )}

      {recap.focusAreas.length > 0 && (
        <section aria-labelledby="recap-focus-h">
          <h2 id="recap-focus-h" className="recap-h2">What to focus on</h2>
          <ul className="recap-focus">
            {recap.focusAreas.map((f, i) => (
              <li key={i} className="recap-card">
                <div className="recap-focus__top">
                  <h3 className="recap-h3">{f.part}</h3>
                  <span className="recap-trend" data-trend={f.trend}>{TREND_TEXT[f.trend] ?? f.trend}</span>
                </div>
                <p>{f.whatHappened}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recap.habits.length > 0 && (
        <section aria-labelledby="recap-habits-h">
          <h2 id="recap-habits-h" className="recap-h2">Habits for today</h2>
          <ul className="recap-grid">
            {recap.habits.map((h, i) => (
              <li key={i} className="recap-card recap-habit">
                <p className="recap-habit__min">~{h.minutes} min</p>
                <h3 className="recap-h3">{h.title}</h3>
                <dl className="recap-dl">
                  <dt>When</dt><dd>{h.when}</dd>
                  <dt>How</dt><dd>{h.how}</dd>
                </dl>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recap.exercises.length > 0 && (
        <section aria-labelledby="recap-ex-h">
          <h2 id="recap-ex-h" className="recap-h2">Practice exercises</h2>
          <ul className="recap-grid">
            {recap.exercises.map((x, i) => (
              <li key={i} className="recap-card">
                <h3 className="recap-h3">{x.title}</h3>
                <p className="recap-targets">Works on: {x.targets}</p>
                <ol className="recap-steps">
                  {x.steps.map((s, j) => <li key={j}>{s}</li>)}
                </ol>
                <p className="recap-reps"><strong>Reps:</strong> {x.reps}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export default function RecapScreen() {
  const { recapId = '' } = useParams();
  const navigate = useNavigate();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0); // bump to restart polling
  const [resume, setResume] = useState(0); // bump to poll again for a queued email without resetting the view
  const keepView = useRef(false);
  const [line, setLine] = useState(0);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!keepView.current) setView({ kind: 'loading' });
    keepView.current = false;
    let settledOnce = false;

    const tick = async () => {
      try {
        const status = await getRecap(recapId, learnerProfileId(), ctl.signal);
        if (ctl.signal.aborted) return;
        setView({ kind: 'status', status });
        settledOnce = status.status !== 'pending';
        if (status.status !== 'pending' && status.emailStatus !== 'queued') return;
      } catch (err) {
        if (ctl.signal.aborted) return;
        if (err instanceof RecapHttpError && (err.status === 404 || err.status === 403)) {
          setView({ kind: 'gone' });
          return;
        }
        // Network blips while pending are retried until the time limit.
      }
      if (Date.now() - started >= GIVE_UP_MS) {
        if (settledOnce) return; // the recap is shown; only the email update stops arriving
        setView({ kind: 'slow' });
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => { ctl.abort(); clearTimeout(timer); };
  }, [recapId, attempt, resume]);

  const pending = view.kind === 'loading' || (view.kind === 'status' && view.status.status === 'pending');
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => setLine((n) => (n + 1) % PROGRESS_LINES.length), 4000);
    return () => clearInterval(id);
  }, [pending]);

  const settled = !pending;
  useEffect(() => {
    if (settled) headingRef.current?.focus();
  }, [settled, view.kind]);

  const home = useCallback(() => navigate('/'), [navigate]);
  const homeButton = (
    <button type="button" className="btn" onClick={home}><ArrowLeft size={16} aria-hidden="true" /> Home</button>
  );

  let content;
  if (pending) {
    content = (
      <div className="recap-state" role="status" aria-live="polite">
        <span className="recap-spinner" aria-hidden="true" />
        <h1 className="recap-title">Writing your recap</h1>
        <p className="recap-lede">{PROGRESS_LINES[line]}</p>
      </div>
    );
  } else if (view.kind === 'gone') {
    content = (
      <div className="recap-state">
        <h1 className="recap-title" tabIndex={-1} ref={headingRef}>This recap isn't available</h1>
        <p className="recap-lede">It may have expired. Finish a word lesson to get a new one.</p>
        {homeButton}
      </div>
    );
  } else if (view.kind === 'slow') {
    content = (
      <div className="recap-state">
        <h1 className="recap-title" tabIndex={-1} ref={headingRef}>Taking longer than expected</h1>
        <p className="recap-lede">Your recap is still not ready. You can check again.</p>
        <div className="btn-row">
          <button type="button" className="btn btn--primary" onClick={() => setAttempt((n) => n + 1)}>Check again</button>
          {homeButton}
        </div>
      </div>
    );
  } else if (view.kind === 'status' && view.status.status === 'empty') {
    content = (
      <div className="recap-state">
        <h1 className="recap-title" tabIndex={-1} ref={headingRef}>Nothing to recap yet</h1>
        <p className="recap-lede">There were no scored tries in this session. Practise a word and the recap will appear here.</p>
        {homeButton}
      </div>
    );
  } else if (view.kind === 'status' && (view.status.status === 'failed' || !view.status.recap)) {
    content = (
      <div className="recap-state">
        <h1 className="recap-title" tabIndex={-1} ref={headingRef}>We couldn't write your recap</h1>
        <p className="recap-lede">Something went wrong on our side. Try another lesson, or come back later.</p>
        {homeButton}
      </div>
    );
  } else if (view.kind === 'status' && view.status.recap) {
    const status = view.status;
    content = (
      <>
        <RecapBody recap={status.recap!} headingRef={headingRef} />
        <EmailBox
          status={status}
          recapId={recapId}
          onUpdate={(next) => {
            setView({ kind: 'status', status: { ...next, recap: next.recap ?? status.recap } });
            if (next.emailStatus === 'queued') {
              keepView.current = true;
              setResume((n) => n + 1);
            }
          }}
        />
        <div className="recap-foot">{homeButton}</div>
      </>
    );
  } else {
    content = null;
  }

  return <main className="recap">{content}</main>;
}
