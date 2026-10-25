import { useCallback, useEffect, useState } from 'react';
import brandMark from '../assets/landing/brand-mark.svg';
import { IdentityForm } from '../classroom/IdentityForm';
import { personName } from '../classroom/labels';
import { loadSession, saveSession, type DevSession } from '../classroom/session';
import { Dashboard } from './Dashboard';
import LiveSystem from './LiveSystem';
import School from './School';
import { type RoomStatus } from './consoleModel';
import { readLocation, subscribeLocation, writeLocation, type ConsoleLocation } from './consoleLocation';

export function Console() {
  const [location, setLocation] = useState<ConsoleLocation>(() => readLocation());
  const [session, setSession] = useState<DevSession | null>(() => {
    const saved = loadSession();
    return saved?.role === 'teacher' ? saved : null;
  });
  const [room, setRoom] = useState<RoomStatus>({ state: 'Connecting', ready: false, updatedAt: null });
  const [classroomDraft, setClassroomDraft] = useState(session?.classroomId ?? 'room-1');
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [openedLive, setOpenedLive] = useState(() => readLocation().tab === 'live');
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 800px)').matches);
  const [showRoster, setShowRoster] = useState(() => !readLocation().learner);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => subscribeLocation(setLocation), []);
  useEffect(() => {
    if (!window.location.hash) writeLocation(readLocation(), 'replace');
  }, []);
  useEffect(() => {
    if (location.tab === 'live') setOpenedLive(true);
  }, [location.tab]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 800px)');
    const apply = () => setNarrow(media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);

  const onStatus = useCallback((next: RoomStatus) => setRoom(next), []);

  function go(partial: Partial<ConsoleLocation>, mode: 'push' | 'replace' = 'push') {
    writeLocation({ ...readLocation(), ...partial }, mode);
  }

  async function switchClassroom() {
    if (!session) return;
    const classroom = classroomDraft.trim().toLowerCase();
    if (!/^[a-z0-9-]{1,24}$/.test(classroom)) {
      setSwitchError('Use a short classroom name of letters, numbers, and dashes.');
      return;
    }
    setSwitchError(null);
    try {
      const response = await fetch('/v1/dev/classroom/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'teacher', name: session.name, classroom }),
      });
      if (!response.ok) {
        setSwitchError('That classroom could not be opened.');
        return;
      }
      const body = (await response.json()) as DevSession;
      const next = { ...body, role: 'teacher' as const, name: session.name, label: body.label || 'development identity' };
      saveSession(next);
      setSession(next);
      go({ learner: '', attempt: '', revision: '', command: '' });
    } catch {
      setSwitchError('The classroom service is not reachable.');
    }
  }

  const detailOnly = narrow && !showRoster && Boolean(location.learner);
  const rosterOnly = narrow && (showRoster || !location.learner);
  const roomLine = room.state === 'Disconnected'
    ? `Classroom disconnected. ${stamp(room.updatedAt, now)}`
    : !session
      ? 'Classroom is not open.'
      : !room.ready
        ? 'Classroom is loading.'
        : `Classroom connected. ${stamp(room.updatedAt, now)}`;

  return (
    <div className={`console${detailOnly ? ' console--detail' : ''}${rosterOnly ? ' console--roster' : ''}`}>
      <header className="console-bar">
        <div className="console-brand">
          <img src={brandMark} alt="" width={24} height={26} />
          <div>
            <p className="console-brand__name">Articulate</p>
            <p className="console-brand__label">Teaching console</p>
          </div>
        </div>
        <nav className="console-tabs" aria-label="Console sections">
          <button type="button" aria-current={location.tab === 'classroom' ? 'page' : undefined} onClick={() => go({ tab: 'classroom' })}>
            Classroom
          </button>
          <button type="button" aria-current={location.tab === 'school' ? 'page' : undefined} onClick={() => go({ tab: 'school' })}>
            School
          </button>
          <button type="button" aria-current={location.tab === 'live' ? 'page' : undefined} onClick={() => go({ tab: 'live' })}>
            Live system
          </button>
        </nav>
        <form className="console-room" onSubmit={(event) => { event.preventDefault(); void switchClassroom(); }}>
          <label>
            Classroom
            <input
              value={classroomDraft}
              onChange={(event) => setClassroomDraft(event.target.value)}
              pattern="[a-z0-9-]{1,24}"
              disabled={!session}
            />
          </label>
          <button type="submit" className="btn btn--sm" disabled={!session}>Open</button>
        </form>
        <div className="console-identity">
          <p>{session ? `${personName(session.name)} · Teacher` : 'Not signed in'}</p>
          <p className="fine">{session ? 'Development identity. This name is not an account.' : 'A teacher sign-in opens the classroom. It does not grant the system stream.'}</p>
        </div>
        <p className="console-status">{roomLine}</p>
        <div className="console-mode">
          {/* 2026-10-25: stacked "Leave demo replay" plus a second copy on the graph.
          <span className="console-mode__label">{location.demo ? 'Demo replay' : 'Live'}</span>
          <button type="button" className="btn btn--sm" aria-pressed={location.demo} onClick={() => go({ demo: !location.demo })}>
            {location.demo ? 'Leave demo replay' : 'Play demo replay'}
          </button>
          <p className="fine">Demo replay is sample system traffic. It does not change lessons, learners, or acknowledgments.</p>
          */}
          <span className="console-mode__label">{location.demo ? 'Demo' : 'Live'}</span>
          <button
            type="button"
            className="btn btn--sm"
            aria-pressed={location.demo}
            onClick={() => go({ demo: !location.demo })}
          >
            {location.demo ? 'Stop demo' : 'Play demo'}
          </button>
          <p className="fine">Sample traffic. It does not change lessons, learners, or acknowledgments.</p>
        </div>
        {switchError && <p role="alert" className="teach-alert">{switchError}</p>}
      </header>
      <div className="console-main" hidden={location.tab !== 'classroom'}>
        {session ? (
          <Dashboard
            session={session}
            location={location}
            narrowDetail={detailOnly}
            onBackToRoster={() => setShowRoster(true)}
            onSelectLearner={(learner) => {
              setShowRoster(false);
              go({ learner, attempt: '' });
            }}
            onSelectAttempt={(attempt) => go({ attempt })}
            onFollow={(command, revision) => go({ tab: 'live', command, revision })}
            onStatus={onStatus}
          />
        ) : (
          <main className="teach">
            <IdentityForm role="teacher" onReady={(next) => { setSession(next); setClassroomDraft(next.classroomId); }} />
          </main>
        )}
      </div>
      <div className="console-main console-main--school" hidden={location.tab !== 'school'}>
        <School />
      </div>
      {openedLive && (
        <div className="console-main console-main--live" hidden={location.tab !== 'live'}>
          <LiveSystem
            hidden={location.tab !== 'live'}
            paused={paused}
            demo={location.demo}
            location={location}
            onPause={() => setPaused((value) => !value)}
            onBack={() => go({ tab: 'classroom' })}
            onDemo={() => go({ demo: !location.demo })}
          />
        </div>
      )}
    </div>
  );
}

function stamp(at: number | null, now: number): string {
  if (at == null) return 'No classroom update yet.';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return 'Updated just now.';
  return `Last updated ${seconds}s ago.`;
}
