import { useState, type FormEvent } from 'react';
import { saveSession, type DevSession } from './session';

export function IdentityForm({
  role,
  onReady,
}: {
  role: 'teacher' | 'learner';
  onReady: (session: DevSession) => void;
}) {
  const [name, setName] = useState(role === 'teacher' ? 'ada' : 'lea');
  const [classroom, setClassroom] = useState('room-1');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
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
      onReady(session);
    } catch {
      setError('The backend is not reachable.');
    } finally {
      setBusy(false);
    }
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
