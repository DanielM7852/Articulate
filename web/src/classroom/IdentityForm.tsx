import { useState, type FormEvent } from 'react';
import { saveSession, saveLearnerName, loadLearnerName, type DevSession } from './session';

const NAME = /^[a-z0-9-]{1,24}$/;

export function IdentityForm({
  role,
  onReady,
  compact = false,
  onBegin,
}: {
  role: 'teacher' | 'learner';
  onReady: (session: DevSession) => void;
  /** Landing page: name alone begins, name plus classroom joins the class. */
  compact?: boolean;
  onBegin?: () => void;
}) {
  const [name, setName] = useState(compact ? loadLearnerName() : role === 'teacher' ? 'ada' : 'lea');
  const [classroom, setClassroom] = useState(compact ? '' : 'room-1');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (compact && !classroom.trim()) {
      setError('Enter a classroom to join a class.');
      return;
    }
    if (!NAME.test(name)) {
      setError('Use a short name made of letters, numbers, or hyphens.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/v1/dev/classroom/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, name, classroom }),
      });
      if (!response.ok) {
        setError('This development identity could not be opened. Start the local classroom database and the backend.');
        return;
      }
      const body = (await response.json()) as DevSession;
      const session = { ...body, role, name, label: body.label || 'development identity' };
      saveSession(session);
      window.dispatchEvent(new Event('articulate-classroom-session'));
      onReady(session);
    } catch {
      setError('The backend is not reachable.');
    } finally {
      setBusy(false);
    }
  }

  function beginWithName() {
    if (!NAME.test(name)) {
      setError('Use a short name made of letters, numbers, or hyphens.');
      return;
    }
    saveLearnerName(name);
    onBegin?.();
  }

  return (
    <form className={compact ? 'classroom-id classroom-id--inline' : 'classroom-id'} onSubmit={submit}>
      <p className="classroom-id__label">Development identity. A name here is not an account.</p>
      <label>
        Name
        <input value={name} onChange={(event) => setName(event.target.value)} pattern="[a-z0-9-]{1,24}" required />
      </label>
      <label>
        Classroom
        <input
          value={classroom}
          onChange={(event) => setClassroom(event.target.value)}
          pattern="[a-z0-9-]{1,24}"
          required={!compact}
        />
      </label>
      {compact && (
        <button type="button" className="intro-landing__begin" onClick={beginWithName}>
          Begin
        </button>
      )}
      <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Opening' : role === 'teacher' ? 'Open dashboard' : compact ? 'Join class' : 'Join as learner'}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
