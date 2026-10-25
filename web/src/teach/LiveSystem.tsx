import { useEffect, useState } from 'react';
import Dashboard from '../screens/Dashboard';
import type { TelemetryEvent } from '../telemetry/client';
import { commandOf, observedStages, publicPayload } from './consoleModel';
import { learnerLabel, readLocation, rememberLearnerLabel, writeLocation, type ConsoleLocation } from './consoleLocation';
import { useLiveStatus, type LiveStatus } from './liveStatus';

type Item = TelemetryEvent & { commandId: string };

const STAGES = [
  ['saved', 'Teacher save accepted', 'lesson.saved'],
  ['received', 'Learner receipt', 'lesson.received'],
  ['applied', 'Learner applied the lesson', 'lesson.applied'],
] as const;

export default function LiveSystem({
  hidden,
  paused,
  demo,
  location,
  onPause,
  onBack,
  onDemo,
}: {
  hidden: boolean;
  paused: boolean;
  demo: boolean;
  location: ConsoleLocation;
  onPause: () => void;
  onBack: () => void;
  onDemo: () => void;
}) {
  const [events, setEvents] = useState<Item[]>([]);
  const [stream, setStream] = useState<{ conn: 'connecting' | 'live' | 'offline'; count: number; lastAt: number | null }>({
    conn: 'connecting',
    count: 0,
    lastAt: null,
  });
  const [scope, setScope] = useState<'system' | 'lesson'>(location.command ? 'lesson' : 'system');
  const live = useLiveStatus();

  useEffect(() => {
    if (location.command) setScope('lesson');
  }, [location.command]);

  useEffect(() => {
    setEvents([]);
  }, [demo]);

  const stages = observedStages(events, location.command);
  const shown = scope === 'lesson' && location.command ? events.filter((event) => event.commandId === location.command) : events;

  return (
    <section className="live-pane" aria-label="Live system">
      <div className="live-toolbar">
        <label className="live-scope">
          <span>Scope</span>
          <select value={scope} onChange={(event) => setScope(event.target.value as 'system' | 'lesson')}>
            <option value="system">All public system traffic</option>
            <option value="lesson">This lesson’s events</option>
          </select>
        </label>
        <p
          className="live-stream"
          data-state={stream.conn}
          title={
            stream.conn === 'connecting'
              ? 'System stream connecting. A count of zero is not a connection.'
              // 2026-10-25: was 'Events do not name a learner.' when no learner was selected.
              : `${location.learner && !demo ? 'The face and equalizer show only this learner’s tab once it has announced its profile. Other events are the whole public stream.' : 'Lesson events name a learner once that learner’s tab has announced its profile.'} Demo replay is sample traffic and does not change lessons, learners, or acknowledgments.`
          }
        >
          {stream.conn === 'live' && `Connected · ${stream.count} events`}
          {stream.conn === 'connecting' && 'Connecting'}
          {stream.conn === 'offline' && (stream.lastAt ? `Disconnected · ${new Date(stream.lastAt).toLocaleTimeString()}` : 'Disconnected')}
        </p>
        <div className="live-actions">
          <button type="button" className="btn btn--sm" aria-pressed={paused} onClick={onPause}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="btn btn--sm" aria-pressed={demo} onClick={onDemo}>
            {demo ? 'Stop demo' : 'Play demo'}
          </button>
          <button type="button" className="btn btn--sm" onClick={() => void document.querySelector('.live-pane')?.requestFullscreen?.()}>
            Full screen
          </button>
        </div>
      </div>
      {/* 2026-10-25: demo status sat in its own warning block over the graph.
      {demo && <p className="live-demo" role="status">Demo replay. These are sample events. They do not change classroom lessons, learners, or acknowledgments.</p>}
      */}
      <div className="live-context">
        <p>
          {learnerLabel(location.learner)}
          {location.revision ? `. Lesson revision ${location.revision}.` : ''}
          {/* 2026-10-25: telemetry events carried no attempt id.
          {location.attempt ? ' An attempt is selected. Telemetry events do not include attempt ids, so this view is not filtered to it.' : ''}
          */}
          {location.attempt ? ' An attempt is selected. The graph’s cards and packets are limited to it. Events without an attempt id still show.' : ''}
        </p>
        <button type="button" className="text-link" onClick={onBack}>Back to classroom</button>
      </div>
      <div className="console-live__stage">
          <Dashboard
            embedded
            hidden={hidden}
            paused={paused}
            demo={demo}
            learner={location.learner}
            attempt={location.attempt}
          onEvent={(event) => {
            const commandId = commandOf(event.payload);
            setEvents((current) => [{ ...event, commandId, payload: publicPayload(event.payload) }, ...current].slice(0, 40));
          }}
          onStream={setStream}
        />
      </div>
      {/* 2026-10-25: the activity list started open and pushed the graph into a short band.
      <details className="live-inspector" open>
      */}
      <details className="live-inspector">
        <summary>Activity</summary>
        <ol className="live-stages">
          {STAGES.map(([key, label]) => (
            <li key={key}>
              <span>{label}</span>
              <span>{location.command && stages[key] ? 'Seen on the system stream' : 'Not observed'}</span>
            </li>
          ))}
          <li>
            <span>Persisted revision</span>
            <span>Not observed on this stream. The classroom tab reads the saved revision from the classroom summary.</span>
          </li>
        </ol>
        <p className="fine">
          {/* 2026-10-25: events named neither a learner nor an attempt.
          {location.learner && !demo
            ? 'The face and the equalizer show only the selected learner’s tab, once that tab has announced its classroom profile. Every other event on the graph is still the whole public system stream, and events do not name an attempt.'
            : 'The graph is the public system stream. Events do not name a learner or an attempt, so lip mesh and the equalizer are not attributed to the selected learner.'}
          {location.attempt ? ' Attempt filtering is not available.' : ''}
          */}
          {location.learner && !demo
            ? 'The face and the equalizer show only the selected learner’s tab, once that tab has announced its classroom profile. Every other event on the graph is still the whole public system stream.'
            : 'The graph is the public system stream. Lip mesh and the equalizer are not attributed to a learner here.'}
          {' Lesson events below name the learner once that learner’s tab has announced its classroom profile.'}
          {location.attempt ? ' The graph is limited to the selected attempt. Events without an attempt id still show.' : ''}
          {' '}
          {scope === 'lesson'
            ? 'Showing events whose command id matches the lesson you followed. Other traffic stays on the graph.'
            : 'Showing public system traffic. A lesson save does not have to pass through a model.'}
        </p>
        {shown.length === 0 && <p>No listed events yet. High-rate lip and audio frames stay on the graph and out of this list.</p>}
        <ul className="live-events">
          {shown.map((event) => (
            <li key={event.id}>
              <p>
                <time dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleTimeString()}</time>
                {' '}{event.label}
              </p>
              <EventLearner event={event} live={live} />
              <p className="fine">{event.source} to {event.target} · {event.kind}{event.id.startsWith('demo-') ? ' · demo' : ''}</p>
              <details>
                <summary>Payload</summary>
                <pre>{JSON.stringify(event.payload, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

/** For a lesson event whose tab announced a classroom profile: the learner, as a link to that learner and lesson. */
function EventLearner({ event, live }: { event: Item; live: LiveStatus }) {
  if (!event.kind.startsWith('lesson.')) return null;
  const pid = live.attributed.get(event.id);
  if (!pid) return null;
  const remembered = learnerLabel(pid);
  const name = live.names.get(pid) ?? (remembered !== 'Selected learner' ? remembered : `Profile ${pid.slice(0, 8)}`);
  const revision = typeof event.payload.revision === 'number' ? String(event.payload.revision) : '';
  return (
    <p className="live-learner">
      <button
        type="button"
        className="text-link"
        onClick={() => {
          rememberLearnerLabel(pid, name);
          writeLocation({ ...readLocation(), learner: pid, attempt: '', revision, command: event.commandId });
        }}
      >
        {name}
      </button>
      {revision ? <span> · revision {revision}</span> : null}
    </p>
  );
}
