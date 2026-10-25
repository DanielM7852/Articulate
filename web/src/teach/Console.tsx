import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import brandMark from '../assets/landing/brand-mark.svg';
import { IdentityForm } from '../classroom/IdentityForm';
import { personName } from '../classroom/labels';
import { loadSession, saveSession, type DevSession } from '../classroom/session';
import { Dashboard } from './Dashboard';
import LiveSystem from './LiveSystem';
import { type RoomStatus } from './consoleModel';
import { readLocation, subscribeLocation, writeLocation, type ConsoleLocation, type ConsoleTab } from './consoleLocation';

/** Matches the pane transition in teach.css. The leaving pane becomes hidden once it has faded out. */
const PANE_EXIT_MS = 240;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

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
  const [reduceMotion, setReduceMotion] = useState(() => window.matchMedia(REDUCED_MOTION).matches);
  // The pane on its way out stays rendered (aria-hidden, inert) until its fade ends, then becomes hidden.
  // Updated during render so the leaving pane is never hidden for a frame before its exit starts.
  const [panes, setPanes] = useState<{ tab: ConsoleTab; leaving: ConsoleTab | null }>(() => ({ tab: readLocation().tab, leaving: null }));
  if (panes.tab !== location.tab) {
    setPanes({ tab: location.tab, leaving: reduceMotion ? null : panes.tab });
  }
  if (location.tab === 'live' && !openedLive) setOpenedLive(true);
  // Pane transitions switch on after the first paint, so the page itself does not fade in on load.
  const [motionReady, setMotionReady] = useState(false);
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setMotionReady(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  useEffect(() => subscribeLocation(setLocation), []);
  useEffect(() => {
    if (!window.location.hash) writeLocation(readLocation(), 'replace');
  }, []);
  useEffect(() => {
    if (!panes.leaving) return;
    // Every switch replaces this timer, so rapid clicks always settle on one visible pane.
    const id = window.setTimeout(() => setPanes((current) => ({ ...current, leaving: null })), PANE_EXIT_MS);
    return () => window.clearTimeout(id);
  }, [panes]);
  useEffect(() => {
    const media = window.matchMedia(REDUCED_MOTION);
    const apply = () => setReduceMotion(media.matches);
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);
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
  const roomState = room.state === 'Disconnected' ? 'offline' : session && room.ready ? 'live' : 'idle';
  const paneState = (tab: ConsoleTab): PaneState => (tab === location.tab ? 'in' : tab === panes.leaving ? 'out' : 'gone');
  const liveState = paneState('live');

  return (
    <div
      className={`console${detailOnly ? ' console--detail' : ''}${rosterOnly ? ' console--roster' : ''}`}
      data-tab={location.tab}
      data-motion={motionReady ? '' : undefined}
      data-live-shown={openedLive && liveState !== 'gone' ? '' : undefined}
    >
      <header className="console-bar">
        <div className="console-bar__main">
          <div className="console-brand">
            <img src={brandMark} alt="" width={24} height={26} />
            <p className="console-brand__name">Articulate</p>
            <p className="console-brand__label">Teaching console</p>
          </div>
          <ConsoleTabs active={location.tab} reduceMotion={reduceMotion} onSelect={(tab) => go({ tab })} />
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
        </div>
        <div className="console-bar__meta">
          <p className="console-status" data-state={roomState}>{roomLine}</p>
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
        </div>
      </header>
      <div className="console-stage">
        <Pane className="console-main console-main--classroom" state={paneState('classroom')}>
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
            <main className="teach teach--signin">
              <IdentityForm role="teacher" onReady={(next) => { setSession(next); setClassroomDraft(next.classroomId); }} />
            </main>
          )}
        </Pane>
        {openedLive && (
          <Pane className="console-main console-main--live" state={liveState}>
            <LiveSystem
              hidden={liveState === 'gone'}
              paused={paused}
              demo={location.demo}
              location={location}
              onPause={() => setPaused((value) => !value)}
              onBack={() => go({ tab: 'classroom' })}
              onDemo={() => go({ demo: !location.demo })}
            />
          </Pane>
        )}
      </div>
    </div>
  );
}

type PaneState = 'in' | 'out' | 'gone';

/**
 * One console tab. 'in' is the shown pane. 'out' is a pane fading out while the next one fades in:
 * aria-hidden and inert, so it is neither read nor focusable. 'gone' is hidden.
 */
function Pane({ className, state, children }: { className: string; state: PaneState; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.inert = state !== 'in';
  }, [state]);
  return (
    <div ref={ref} className={className} data-pane={state} hidden={state === 'gone'} aria-hidden={state === 'out' ? true : undefined}>
      {children}
    </div>
  );
}

const TABS: { tab: ConsoleTab; label: string }[] = [
  { tab: 'classroom', label: 'Classroom' },
  { tab: 'live', label: 'Live system' },
];

/** Section tabs with one rule that slides under the active tab. */
function ConsoleTabs({ active, reduceMotion, onSelect }: { active: ConsoleTab; reduceMotion: boolean; onSelect: (tab: ConsoleTab) => void }) {
  const navRef = useRef<HTMLElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const placed = useRef<{ x: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const bar = barRef.current;
    if (!nav || !bar) return;
    const place = (animate: boolean) => {
      const button = nav.querySelector<HTMLButtonElement>(`button[data-tab="${active}"]`);
      if (!button) return;
      const x = button.offsetLeft;
      const width = button.offsetWidth;
      const last = placed.current;
      if (last && last.x === x && last.width === width) return;
      // Transform only: the bar is 1px wide and scaled to the tab, so the move stays on the compositor.
      // A CSS transition retargets from wherever the bar is, so a second click mid-slide turns it around.
      bar.style.transition = animate && last && !reduceMotion ? '' : 'none';
      bar.style.transform = `translateX(${x}px) scaleX(${width})`;
      bar.dataset.placed = '';
      placed.current = { x, width };
    };
    place(true);
    // Web fonts and wrapping change the tab widths. Follow them without animating.
    const observer = new ResizeObserver(() => place(false));
    nav.querySelectorAll('button').forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [active, reduceMotion]);

  return (
    <nav ref={navRef} className="console-tabs" aria-label="Console sections">
      {TABS.map(({ tab, label }) => (
        <button key={tab} type="button" data-tab={tab} aria-current={active === tab ? 'page' : undefined} onClick={() => onSelect(tab)}>
          {label}
        </button>
      ))}
      <span ref={barRef} className="console-tabs__bar" aria-hidden="true" />
    </nav>
  );
}

function stamp(at: number | null, now: number): string {
  if (at == null) return 'No classroom update yet.';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return 'Updated just now.';
  return `Last updated ${seconds}s ago.`;
}
