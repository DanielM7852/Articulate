import { useState, type FormEvent } from 'react';
import { saveSession, saveLearnerName, loadLearnerName, type DevSession } from './session';
import { ensureVirtualLearner, learnerSlug } from './autoJoin';

const NAME = /^[a-z0-9-]{1,24}$/;

export function IdentityForm({
  role,
  onReady,
  compact = false,
  onBegin,
}: {
  role: 'teacher' | 'learner';
  onReady?: (session: DevSession) => void;
  /** Landing page: an optional name and Begin. A virtual learner is provisioned silently (autoJoin.ts). */
  compact?: boolean;
  onBegin?: () => void;
}) {
  const [name, setName] = useState(compact ? loadLearnerName() : role === 'teacher' ? 'ada' : 'lea');
  const [classroom, setClassroom] = useState('room-1');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
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
      onReady?.(session);
    } catch {
      setError('The backend is not reachable.');
    } finally {
      setBusy(false);
    }
  }

  // Begin always proceeds: the name is optional and only shapes the virtual learner's display name.
  function begin(event: FormEvent) {
    event.preventDefault();
    const slug = learnerSlug(name);
    saveLearnerName(slug);
    void ensureVirtualLearner(slug);
    onBegin?.();
  }

  if (compact) {
    return (
      <form className="classroom-id classroom-id--inline" onSubmit={begin}>
        <label>
          <span className="classroom-id__prompt">
            What should Ava call you? <span className="classroom-id__optional">Optional</span>
          </span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} autoComplete="nickname" />
        </label>
        <button type="submit" className="intro-landing__begin">
          Begin
        </button>
      </form>
    );
  }

  return (
    <form className="classroom-id" onSubmit={submit}>
      <p className="classroom-id__label">Development identity. A name here is not an account.</p>
      <label>
        Name
        <input value={name} onChange={(event) => setName(event.target.value)} pattern="[a-z0-9-]{1,24}" required />
      </label>
      <label>
        Classroom
        <input value={classroom} onChange={(event) => setClassroom(event.target.value)} pattern="[a-z0-9-]{1,24}" required />
      </label>
      <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Opening' : role === 'teacher' ? 'Open dashboard' : 'Join as learner'}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
