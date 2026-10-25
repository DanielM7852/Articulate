import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { DbConnection } from '../module_bindings';
import { parseSettings, type LessonSettings } from '@lesson-rules';
import { wsUri, type DevSession } from '../classroom/session';
import {
  changedSettings,
  clockLabel,
  cueName,
  exerciseName,
  findingName,
  formatName,
  learnerInstruction,
  personName,
  plainChange,
  supportName,
} from '../classroom/labels';
import { emit } from '../telemetry/client';
import { classReach, presenceWord, type RoomStatus } from './consoleModel';
import { readLocation, recallCommand, rememberCommand, rememberLearnerLabel, writeLocation, type ConsoleLocation } from './consoleLocation';

type BoardRow = {
  profileId: string;
  displayName: string;
  classroomId: string;
  presence: string;
  presenceAt: bigint;
  exercise: string;
  lessonRevision: number;
  lessonSource: string;
  overrideRevision: number;
  classroomRevision: number;
  visible: string;
  settingsJson: string;
  ackPhase: string;
  usable: number;
  unusable: number;
  lastFinding: string;
  lastKind: string;
  lastProvenance: string;
  lastAt: bigint;
  repeatCount: number;
  needsAttention: boolean;
  syntheticRepeat: number;
  helpRequested: boolean;
  helpNote: string;
};

type AttemptRow = {
  attemptId: string;
  exercise: string;
  usable: boolean;
  finding: string;
  kind: string;
  provenance: string;
  referenceVersion: string;
  analysisVersion: string;
  cueId: string;
  measurementsJson: string;
  synthetic: boolean;
  createdAt: bigint;
};

const EMPTY: LessonSettings = {
  target: 'i',
  context: 'sound',
  cueId: 'spread-lips',
  assistance: 'cue-target',
  referenceReplay: false,
  repetitions: 1,
  note: '',
};

export function Dashboard({
  session,
  location,
  narrowDetail,
  onBackToRoster,
  onSelectLearner,
  onSelectAttempt,
  onFollow,
  onStatus,
}: {
  session: DevSession;
  location: ConsoleLocation;
  narrowDetail: boolean;
  onBackToRoster: () => void;
  onSelectLearner: (learner: string) => void;
  onSelectAttempt: (attempt: string) => void;
  onFollow: (command: string, revision: string) => void;
  onStatus: (status: RoomStatus) => void;
}) {
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [ready, setReady] = useState(false);
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [draft, setDraft] = useState<LessonSettings>(EMPTY);
  const [status, setStatus] = useState('Connecting');
  const [error, setError] = useState<string | null>(null);
  const [lastScope, setLastScope] = useState<'learner' | 'classroom'>('learner');
  const [conn, setConn] = useState<DbConnection | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [learnerName, setLearnerName] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const selected = location.learner || null;

  useEffect(() => {
    if (!session) return;
    let closed = false;
    const connection = DbConnection.builder()
      .withUri(wsUri(session.uri))
      .withDatabaseName(session.database)
      .withToken(session.token)
      .onConnect((next) => {
        if (closed) return;
        setConn(next);
        setStatus('Connected');
        next.subscriptionBuilder().onApplied(() => {
          setReady(true);
          setUpdatedAt(Date.now());
          setRows([...next.db.classroomBoard.iter()] as BoardRow[]);
        }).subscribe(['SELECT * FROM classroom_board']);
        const refresh = () => {
          setUpdatedAt(Date.now());
          setRows([...next.db.classroomBoard.iter()] as BoardRow[]);
        };
        next.db.classroomBoard.onInsert(refresh);
        next.db.classroomBoard.onUpdate(refresh);
        next.db.classroomBoard.onDelete(refresh);
      })
      .onConnectError(() => {
        if (!closed) setStatus('Disconnected');
      })
      .onDisconnect(() => {
        if (!closed) setStatus('Disconnected');
      })
      .build();
    return () => {
      closed = true;
      connection.disconnect();
    };
  }, [session, attempt]);

  useEffect(() => {
    if (!conn || !selected) return;
    const handle = conn.subscriptionBuilder().onApplied(() => {
      setAttempts([...conn.db.learnerAttemptCards.iter()] as AttemptRow[]);
    }).subscribe([`SELECT * FROM learner_attempt_cards WHERE profile_id = '${selected}'`]);
    const refresh = () => setAttempts([...conn.db.learnerAttemptCards.iter()] as AttemptRow[]);
    conn.db.learnerAttemptCards.onInsert(refresh);
    conn.db.learnerAttemptCards.onUpdate(refresh);
    return () => {
      handle.unsubscribe();
    };
  }, [conn, selected]);

  const learner = rows.find((row) => row.profileId === selected) ?? null;
  const loadedId = useRef<string | null>(null);
  useEffect(() => {
    if (!selected || loadedId.current === selected) return;
    const row = rows.find((item) => item.profileId === selected);
    if (!row) return;
    loadedId.current = selected;
    try {
      setDraft(row.settingsJson ? parseSettings(row.settingsJson) : EMPTY);
    } catch {
      setDraft(EMPTY);
    }
  }, [rows, selected]);
  const currentSettings = useMemo(() => {
    if (!learner?.settingsJson) return null;
    try {
      return parseSettings(learner.settingsJson);
    } catch {
      return null;
    }
  }, [learner]);

  function choose(row: BoardRow) {
    if (row.profileId === selected) return;
    loadedId.current = row.profileId;
    onSelectLearner(row.profileId);
    rememberLearnerLabel(row.profileId, `${personName(row.displayName)} · ${exerciseName(row.exercise)}`);
    setError(null);
    try {
      setDraft(row.settingsJson ? parseSettings(row.settingsJson) : EMPTY);
    } catch {
      setDraft(EMPTY);
    }
  }

  const baseline = currentSettings ?? EMPTY;
  const changes = changedSettings(baseline, draft).filter((change) => change.before !== change.after);
  const same = changes.length === 0;

  async function addLearner(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    const name = learnerName.trim().toLowerCase();
    if (!/^[a-z0-9-]{1,24}$/.test(name)) {
      setAddError('Use a short name made of letters, numbers, and dashes.');
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      const response = await fetch('/v1/dev/classroom/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'learner', name, classroom: session.classroomId }),
      });
      if (!response.ok) {
        setAddError('That learner could not be added.');
        return;
      }
      const body = (await response.json()) as { profileId?: string };
      setLearnerName('');
      if (body.profileId) onSelectLearner(body.profileId);
    } catch {
      setAddError('The classroom service is not reachable.');
    } finally {
      setAdding(false);
    }
  }

  async function save(scope: 'learner' | 'classroom') {
    if (!conn || !session || same) return;
    setLastScope(scope);
    if (status !== 'Connected') {
      setError('The dashboard is disconnected. Your edits are still here.');
      return;
    }
    setError(null);
    const expected = scope === 'learner' ? learner?.overrideRevision ?? 0 : learner?.classroomRevision ?? rows[0]?.classroomRevision ?? 0;
    const commandId = crypto.randomUUID();
    const revision = expected + 1;
    try {
      await conn.reducers.saveLesson({
        commandId,
        scope,
        targetProfile: scope === 'learner' ? selected ?? '' : '',
        classroomId: session.classroomId,
        expectedRevision: expected,
        settingsJson: JSON.stringify(draft),
        expiresInMinutes: 0,
      });
      const key = scope === 'learner' ? selected ?? '' : `class:${session.classroomId}`;
      rememberCommand(key, revision, commandId);
      const current = readLocation();
      writeLocation({ ...current, command: commandId, revision: String(revision) }, 'replace');
      emit('ui', 'db', 'lesson.saved', 'Lesson saved', { commandId, revision, scope });
    } catch (exc) {
      const text = exc instanceof Error ? exc.message.toLowerCase() : '';
      if (text.includes('conflict')) setError('Someone else saved a newer lesson. Review it, then send your edits again.');
      else if (text.includes('not a teacher') || text.includes('permission')) setError('This identity cannot change lessons for this classroom.');
      else setError('The lesson was not saved. Your edits are still here.');
    }
  }

  const reach = classReach(rows);
  const visibleRows = rows.filter((row) => personName(row.displayName).toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    onStatus({ state: status, ready, updatedAt });
  }, [status, ready, updatedAt, onStatus]);

  useEffect(() => {
    if (!learner) return;
    rememberLearnerLabel(learner.profileId, `${personName(learner.displayName)} · ${exerciseName(learner.exercise)}`);
  }, [learner]);

  return (
    <main className="teach">
      <section className="teach-summary" aria-label="Classroom summary">
        <h1 className="title-serif">{session.classroomId}</h1>
        <p>{rows.length} {rows.length === 1 ? 'learner' : 'learners'}</p>
        <p>{rows.filter((row) => row.presence === 'recording').length} recording</p>
        <p>{rows.filter((row) => row.presence === 'analyzing').length} analyzing</p>
        <p>{rows.filter((row) => row.helpRequested).length} asked for help</p>
        <p className="small">{connectionCopy(status, ready)}</p>
        {status === 'Disconnected' && (
          <button type="button" className="btn btn--sm" onClick={() => { setReady(false); setAttempt((value) => value + 1); }}>
            Try connecting again
          </button>
        )}
      </section>
      <div className="teach-layout">
        <section className="teach-board" aria-label="Learners">
          <button type="button" className={!selected ? 'is-selected' : ''} aria-pressed={!selected} onClick={() => onSelectLearner('')}>
            <span className="teach-row__name">Whole class</span>
            <span className="teach-row__meta">A class lesson reaches {reach.affected} of {rows.length}. {reach.own} already have their own lesson.</span>
          </button>
          {/* 2026-10-25: find and add shared one card, so a search submitted the add form.
          <form className="teach-add" onSubmit={(event) => void addLearner(event)}>
            <label>
              Find a learner
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name" />
            </label>
            <label>
              Add a learner
              <input
                value={learnerName}
                onChange={(event) => setLearnerName(event.target.value)}
                pattern="[a-z0-9-]{1,24}"
                maxLength={24}
                placeholder="name"
                required
              />
            </label>
            <button type="submit" className="btn btn--primary" disabled={adding || status !== 'Connected'}>
              {adding ? 'Adding' : 'Add learner'}
            </button>
            <p className="fine">Adding someone here is optional. The same name can join from the learner app. A lesson for one person stays ahead of a later class lesson.</p>
            {addError && <p role="alert" className="teach-alert">{addError}</p>}
          </form>
          */}
          <div className="teach-add">
            <label>
              Find a learner
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name" />
            </label>
          </div>
          <form className="teach-add" onSubmit={(event) => void addLearner(event)}>
            <label>
              Add a learner
              <input
                value={learnerName}
                onChange={(event) => setLearnerName(event.target.value)}
                pattern="[a-z0-9-]{1,24}"
                maxLength={24}
                placeholder="name"
                required
              />
            </label>
            <button type="submit" className="btn btn--primary" disabled={adding || status !== 'Connected'}>
              {adding ? 'Adding' : 'Add learner'}
            </button>
            <p className="fine">Adding someone here is optional. The same name can join from the learner app. A lesson for one person stays ahead of a later class lesson.</p>
            {addError && <p role="alert" className="teach-alert">{addError}</p>}
          </form>
          {!ready && status !== 'Disconnected' && <p className="teach-empty">Loading the classroom.</p>}
          {ready && rows.length === 0 && <p className="teach-empty">No learners are in {session.classroomId} yet.</p>}
          {status === 'Disconnected' && rows.length === 0 && <p className="teach-empty">The classroom list is unavailable until the connection returns. {updatedAt ? `Last updated ${new Date(updatedAt).toLocaleTimeString()}.` : 'No classroom update yet.'}</p>}
          {ready && rows.length > 0 && visibleRows.length === 0 && <p className="teach-empty">No learner name matches.</p>}
          {visibleRows.map((row) => (
            <button
              key={row.profileId}
              type="button"
              className={row.profileId === selected ? 'is-selected' : ''}
              aria-pressed={row.profileId === selected}
              onClick={() => choose(row)}
            >
              <span className="teach-row__name">{personName(row.displayName)}</span>
              <span className="teach-row__exercise">{exerciseName(row.exercise)}</span>
              <span className="teach-row__meta">{presenceWord(row.presence)}{row.presence === 'disconnected' ? '' : ` · ${freshness(row)}`}</span>
              <Outcome row={row} />
              <span className={`teach-pill teach-pill--${deliveryTone(row)}`}>{deliveryLabel(row)}</span>
              {row.helpRequested && <span className="teach-row__meta">Asked for help{row.helpNote ? `: ${row.helpNote}` : ''}</span>}
              {row.needsAttention && <span className="teach-row__meta">Same measured result {row.repeatCount} times</span>}
              {row.syntheticRepeat >= 3 && <span className="teach-row__meta">Synthetic example, repeated {row.syntheticRepeat}. Not real progress.</span>}
            </button>
          ))}
        </section>
        <section className="teach-detail" aria-label="Learner">
          {narrowDetail && (
            <button type="button" className="btn btn--sm teach-back" onClick={onBackToRoster}>Back to roster</button>
          )}
          {!learner && (
            <section className="teach-next" aria-labelledby="class-lesson">
              <p className="eyebrow">Whole class</p>
              <h2 id="class-lesson" className="title-serif">Everyone in {session.classroomId}</h2>
              <p className="small">This lesson reaches {reach.affected} {reach.affected === 1 ? 'learner' : 'learners'} who do not already have their own. {reach.own} keep an individual lesson until it expires or is revoked. The before column compares with this editor’s starting point. The saved class lesson is not a separate row on this summary.</p>
              <Editor draft={draft} setDraft={setDraft} />
              <Preview current={null} draft={draft} changes={changes} same={same} />
              <button type="button" className="btn btn--primary" disabled={same || status !== 'Connected'} onClick={() => void save('classroom')}>
                Assign to class
              </button>
              {error && <p role="alert" className="teach-alert">{error} <button type="button" className="text-link" onClick={() => void save(lastScope)}>Try again</button></p>}
            </section>
          )}
          {learner && (
            <>
              <section aria-labelledby="current-practice">
                <p className="eyebrow">Current practice</p>
                <h2 id="current-practice" className="title-serif">{personName(learner.displayName)}</h2>
                <p className="body ink">{exerciseName(learner.exercise)}</p>
                <p className="small">{presenceWord(learner.presence)}. {deliveryLabel(learner)}.</p>
                {learner.visible && learner.lessonRevision > 0 && <p className="small">Last change: {plainChange(learner.visible)}</p>}
                {learner.lessonSource === 'learner' && <p className="fine">This person’s lesson stays ahead of a class assignment.</p>}
              </section>
              <Delivery learner={learner} onFollow={() => {
                const command = recallCommand(learner.profileId, learner.lessonRevision);
                onFollow(command, String(learner.lessonRevision));
              }} />
              <section aria-labelledby="recent-evidence">
                <h3 id="recent-evidence" className="teach-h">Recent evidence</h3>
                {attempts.length === 0 && <p className="small">No attempts yet.</p>}
                <ul className="teach-attempts">
                  {attempts.map((item) => (
                    <li key={item.attemptId} className={item.kind === 'capture' ? 'is-capture' : item.synthetic ? 'is-synthetic' : ''}>
                      <button type="button" className="text-link" aria-pressed={location.attempt === item.attemptId} onClick={() => onSelectAttempt(item.attemptId)}>
                        {location.attempt === item.attemptId ? 'Selected attempt' : 'Select this attempt'}
                      </button>
                      <p className="strong ink">{item.kind === 'capture' ? 'Recording needs another try' : item.synthetic ? 'Synthetic example' : item.provenance === 'provisional' ? 'Waiting for a verified result' : 'Measured practice'}</p>
                      <p>{findingName(item.finding)}</p>
                      <p>Exercise {exerciseName(item.exercise)}. Cue {cueName(item.cueId)}.</p>
                      <p>Reference {item.referenceVersion || 'unknown'}. Analysis {item.analysisVersion || 'unknown'}. {clockLabel(item.createdAt)}.</p>
                      <Measurements json={item.measurementsJson} />
                      <p>Word verification is not available, so this does not say a word was mispronounced.</p>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="teach-next" aria-labelledby="next-lesson">
                <h3 id="next-lesson" className="teach-h">Next lesson</h3>
                <Editor draft={draft} setDraft={setDraft} />
                <Preview current={currentSettings} draft={draft} changes={changes} same={same} />
                <div className="teach-actions">
                  <button type="button" className="btn btn--primary" disabled={same || !selected || status !== 'Connected'} onClick={() => void save('learner')}>
                    Send lesson to {personName(learner.displayName)}
                  </button>
                  <button type="button" className="btn" disabled={same || status !== 'Connected'} onClick={() => void save('classroom')}>
                    Assign to class
                  </button>
                </div>
                <p className="fine">Send lesson reaches only {personName(learner.displayName)}. Assign to class reaches {reach.affected} of {rows.length}. A later class lesson does not replace an individual one.</p>
                {error && (
                  <p role="alert" className="teach-alert">
                    {error}{' '}
                    <button type="button" className="text-link" onClick={() => void save(lastScope)}>Try again</button>
                  </p>
                )}
              </section>
              <details className="teach-details">
                <summary>Diagnostics</summary>
                <p>Database {session.database}. View classroom_board for this list. View learner_attempt_cards for the attempts. The learner screen reads my_classroom_lesson and answers with ack_lesson.</p>
                <p>Revision {learner.lessonRevision}. Source {learner.lessonSource || 'unknown'}. Acknowledgment {learner.ackPhase || 'unknown'}.</p>
                <p>Learner revision {learner.overrideRevision}. Classroom revision {learner.classroomRevision}.</p>
                <p>Profile {learner.profileId}. Last seen {clockLabel(learner.presenceAt)}.</p>
              </details>
              <button
                type="button"
                className="text-link"
                onClick={() => {
                  void fetch('/v1/dev/classroom/synthetic', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ profileId: learner.profileId, finding: 'mouth_more_open' }),
                  });
                }}
              >
                Load a labeled synthetic example
              </button>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function Preview({ draft, changes, same }: { current: LessonSettings | null; draft: LessonSettings; changes: { label: string; before: string; after: string }[]; same: boolean }) {
  return (
    <div className="teach-preview" aria-live="polite">
      <p className="eyebrow">Learner will see</p>
      <p>{learnerInstruction(draft)}</p>
      {same ? (
        <p className="small">This matches the current lesson.</p>
      ) : (
        <ul className="teach-diff">
          {changes.map((change) => (
            <li key={change.label}>
              <span>{change.label}</span>
              <span>From {change.before}</span>
              <span>To {change.after}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Delivery({ learner, onFollow }: { learner: BoardRow; onFollow: () => void }) {
  const steps = spacetimeSteps(learner);
  const during = (learner.presence === 'recording' || learner.presence === 'analyzing') && (learner.ackPhase === 'pending' || learner.ackPhase === 'received');
  return (
    <section className="teach-path" aria-label="Lesson delivery">
      <div className="teach-actions">
        <ol className="teach-steps">
          {steps.map((step) => (
            <li key={step.title} className={`teach-step teach-step--${step.state}`}>
              <span className="teach-step__title">{step.title}</span>
              <span>{step.text}</span>
            </li>
          ))}
        </ol>
        <button type="button" className="btn btn--sm" disabled={learner.lessonRevision <= 0} onClick={onFollow}>Follow this lesson</button>
      </div>
      {during && <p className="small">Applies after this recording.</p>}
    </section>
  );
}

/* 2026-10-24: the long SpacetimeDB explanation moved into Diagnostics. Delivery above uses the same acknowledgment steps.
function SpacetimePath({ learner, database, connected }: { learner: BoardRow; database: string; connected: boolean }) {
  const steps = spacetimeSteps(learner);
  return (
    <section className="teach-path" aria-labelledby="spacetime-path">
      <h3 id="spacetime-path" className="teach-h">Through SpacetimeDB</h3>
      <p className="small">
        {connected
          ? `Connected to ${database}. Send lesson calls the save_lesson reducer. ${personName(learner.displayName)}'s screen is subscribed to my_classroom_lesson and answers with ack_lesson. This panel is the classroom_board row that comes back.`
          : `Disconnected from ${database}. This is the last classroom_board row this screen received.`}
      </p>
      <ol className="teach-steps">
        {steps.map((step) => (
          <li key={step.title} className={`teach-step teach-step--${step.state}`}>
            <span className="teach-step__title">{step.title}</span>
            <span>{step.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
*/

function spacetimeSteps(row: BoardRow): { title: string; text: string; state: 'done' | 'now' | 'waiting' }[] {
  const name = personName(row.displayName);
  const saved = row.lessonRevision > 0;
  const received = row.ackPhase === 'received' || row.ackPhase === 'applied';
  const applied = row.ackPhase === 'applied';
  const failed = row.ackPhase === 'failed';
  const duringTake = row.presence === 'recording' || row.presence === 'analyzing';
  return [
    {
      title: 'Saved',
      state: saved ? 'done' : 'waiting',
      text: saved
        ? `save_lesson stored revision ${row.lessonRevision} for ${name} in ${row.lessonSource === 'classroom' ? 'the class assignment' : 'this learner’s lesson'}.`
        : `No save_lesson is stored for ${name} yet.`,
    },
    {
      title: 'Received',
      state: received ? 'done' : saved ? 'now' : 'waiting',
      text: received
        ? `${name}’s subscription to my_classroom_lesson received revision ${row.lessonRevision}.`
        : saved
          ? `Revision ${row.lessonRevision} is stored. This screen is still waiting for ${name}’s device to receive it.`
          : 'Nothing is waiting to be received.',
    },
    {
      title: 'Applied',
      state: applied ? 'done' : failed ? 'now' : received ? 'now' : 'waiting',
      text: applied
        ? `ack_lesson reported applied for revision ${row.lessonRevision}. That acknowledgment updated this classroom_board row.`
        : failed
          ? `${name}’s device reported that revision ${row.lessonRevision} could not be applied.`
          : duringTake && received
            ? `${name} is ${row.presence === 'recording' ? 'recording' : 'checking a take'}. The lesson stays queued until that ends, then ack_lesson can report applied.`
            : received
              ? `The device has revision ${row.lessonRevision}. ack_lesson has not reported applied.`
              : 'Applied appears here only after ack_lesson says so.',
    },
  ];
}

function Outcome({ row }: { row: BoardRow }) {
  if (row.lastProvenance === 'provisional') return <span>Waiting for a verified result</span>;
  if (row.lastKind === 'capture') return <span className="is-capture">Recording needs another try · {findingName(row.lastFinding)}</span>;
  if (row.lastProvenance === 'synthetic') return <span>Synthetic example · {findingName(row.lastFinding)}</span>;
  if (!row.lastFinding || row.lastFinding === 'unknown' || row.lastFinding === 'none') return <span>No measured result yet</span>;
  return <span>Measured: {findingName(row.lastFinding)} · {clockLabel(row.lastAt)}</span>;
}

function Measurements({ json }: { json: string }) {
  let value: Record<string, unknown> = {};
  try {
    value = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return <p>Measurements: unknown</p>;
  }
  return (
    <>
      <p>Vowel acoustics F1 {show(value.f1Hz)} Hz · F2 {show(value.f2Hz)} Hz. Reference F1 {show(value.referenceF1Hz)} · F2 {show(value.referenceF2Hz)}.</p>
      <p>Intonation F0 {show(value.f0Hz)} Hz. Pitch does not establish vowel correctness or tongue or lip position.</p>
    </>
  );
}

function show(value: unknown): string {
  return typeof value === 'number' ? String(Math.round(value)) : 'unknown';
}

function freshness(row: BoardRow): string {
  if (row.presence === 'disconnected') return 'Disconnected';
  if (row.presence === 'unknown' || row.presenceAt === 0n) return 'Last seen unknown';
  const ageMs = Date.now() - Number(row.presenceAt / 1000n);
  if (!Number.isFinite(ageMs)) return 'Last seen unknown';
  if (ageMs > 20000) return 'Last seen a while ago';
  if (ageMs < 15000) return 'Seen just now';
  return 'Seen recently';
}

function deliveryLabel(row: BoardRow): string {
  if (row.lessonRevision <= 0) return 'No teacher lesson yet';
  if (row.ackPhase === 'failed') return 'The lesson could not be applied';
  if (row.ackPhase === 'applied') return 'Learner is practicing the updated lesson';
  if ((row.presence === 'recording' || row.presence === 'analyzing') && (row.ackPhase === 'received' || row.ackPhase === 'pending')) {
    return 'Will start after this recording';
  }
  if (row.ackPhase === 'received') return 'Received on learner’s device';
  if (row.ackPhase === 'pending' || row.ackPhase === 'none' || !row.ackPhase) return 'Lesson saved';
  return 'Lesson saved';
}

function deliveryTone(row: BoardRow): string {
  if (row.ackPhase === 'applied') return 'on';
  if (row.ackPhase === 'failed') return 'wait';
  if (row.lessonRevision <= 0) return 'none';
  return 'wait';
}

function connectionCopy(status: string, ready: boolean): string {
  if (status === 'Disconnected') return 'Disconnected. Saved lessons stay on the server. Edits on this screen stay until you send them.';
  if (!ready) return 'Loading classroom summaries.';
  return 'Connected. This list updates from classroom summaries.';
}

function Editor({ draft, setDraft }: { draft: LessonSettings; setDraft: (next: LessonSettings) => void }) {
  return (
    <div className="teach-editor">
      <label>Practice sound
        <select value={draft.target} onChange={(event) => setDraft({ ...draft, target: event.target.value as LessonSettings['target'] })}>
          <option value="i">{exerciseName('i')}</option>
          <option value="u">{exerciseName('u')}</option>
          <option value="a">{exerciseName('a')}</option>
          <option value="head">{exerciseName('head')}</option>
        </select>
      </label>
      <label>Practice format
        <select value={draft.context} onChange={(event) => setDraft({ ...draft, context: event.target.value as LessonSettings['context'] })}>
          <option value="sound">{formatName('sound')}</option>
          <option value="word">{formatName('word')}</option>
          <option value="phrase">{formatName('phrase')}</option>
        </select>
      </label>
      <label>Support
        <select value={draft.assistance} onChange={(event) => setDraft({ ...draft, assistance: event.target.value as LessonSettings['assistance'] })}>
          <option value="cue-target">{supportName('cue-target')}</option>
          <option value="target-only">{supportName('target-only')}</option>
          <option value="none">{supportName('none')}</option>
        </select>
      </label>
      <label>Practice cue
        <select value={draft.cueId} onChange={(event) => setDraft({ ...draft, cueId: event.target.value as LessonSettings['cueId'] })}>
          <option value="">No cue</option>
          <option value="spread-lips">{cueName('spread-lips')}</option>
          <option value="round-lips">{cueName('round-lips')}</option>
          <option value="open-jaw">{cueName('open-jaw')}</option>
        </select>
      </label>
      <label className="teach-check">Reference
        <input type="checkbox" checked={draft.referenceReplay} onChange={(event) => setDraft({ ...draft, referenceReplay: event.target.checked })} />
        Sonic reference, compared with the learner
      </label>
      <label>Repetitions
        <input type="number" min={1} max={8} value={draft.repetitions} onChange={(event) => setDraft({ ...draft, repetitions: Number(event.target.value) })} />
      </label>
      <label className="teach-note">Note
        <input value={draft.note} maxLength={160} onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
      </label>
    </div>
  );
}
