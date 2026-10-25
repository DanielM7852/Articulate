import { useEffect, useMemo, useState } from 'react';
import { DbConnection } from '../module_bindings';
import { IdentityForm } from '../classroom/IdentityForm';
import { parseSettings, type LessonSettings } from '@lesson-rules';
import { loadSession, wsUri, type DevSession } from '../classroom/session';
import {
  activityName,
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

export function Dashboard() {
  const [session, setSession] = useState<DevSession | null>(() => {
    const saved = loadSession();
    return saved?.role === 'teacher' ? saved : null;
  });
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [draft, setDraft] = useState<LessonSettings>(EMPTY);
  const [status, setStatus] = useState('Connecting');
  const [error, setError] = useState<string | null>(null);
  const [lastScope, setLastScope] = useState<'learner' | 'classroom'>('learner');
  const [conn, setConn] = useState<DbConnection | null>(null);
  const [attempt, setAttempt] = useState(0);

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
          setRows([...next.db.classroomBoard.iter()] as BoardRow[]);
        }).subscribe(['SELECT * FROM classroom_board']);
        const refresh = () => setRows([...next.db.classroomBoard.iter()] as BoardRow[]);
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
    setSelected(row.profileId);
    setError(null);
    try {
      setDraft(row.settingsJson ? parseSettings(row.settingsJson) : EMPTY);
    } catch {
      setDraft(EMPTY);
    }
  }

  const changes = changedSettings(currentSettings, draft);
  const same = changes.length === 0;

  async function save(scope: 'learner' | 'classroom') {
    if (!conn || !session || same) return;
    setLastScope(scope);
    if (status !== 'Connected') {
      setError('The dashboard is disconnected. Your edits are still here.');
      return;
    }
    setError(null);
    const expected = scope === 'learner' ? learner?.overrideRevision ?? 0 : learner?.classroomRevision ?? rows[0]?.classroomRevision ?? 0;
    try {
      await conn.reducers.saveLesson({
        commandId: crypto.randomUUID(),
        scope,
        targetProfile: scope === 'learner' ? selected ?? '' : '',
        classroomId: session.classroomId,
        expectedRevision: expected,
        settingsJson: JSON.stringify(draft),
        expiresInMinutes: 0,
      });
    } catch (exc) {
      const text = exc instanceof Error ? exc.message.toLowerCase() : '';
      if (text.includes('conflict')) setError('Someone else saved a newer lesson. Review it, then send your edits again.');
      else if (text.includes('not a teacher') || text.includes('permission')) setError('This identity cannot change lessons for this classroom.');
      else setError('The lesson was not saved. Your edits are still here.');
    }
  }

  if (!session) {
    return (
      <main className="teach">
        <IdentityForm role="teacher" onReady={setSession} />
      </main>
    );
  }

  return (
    <main className="teach">
      <header className="teach-top">
        <p className="eyebrow">Classroom {session.classroomId}</p>
        <h1 className="title-serif">Practice together</h1>
        <p className="lede">{personName(session.name)} is teaching this classroom. A development name is not an account.</p>
        <p className="small">{connectionCopy(status, ready)}</p>
        {status === 'Disconnected' && (
          <button type="button" className="btn btn--sm" onClick={() => { setReady(false); setAttempt((value) => value + 1); }}>
            Try connecting again
          </button>
        )}
      </header>
      <div className="teach-layout">
        <section className="teach-board" aria-label="Learners">
          {!ready && status !== 'Disconnected' && <p className="teach-empty">Loading the classroom.</p>}
          {ready && rows.length === 0 && <p className="teach-empty">No learners have joined {session.classroomId} yet.</p>}
          {status === 'Disconnected' && rows.length === 0 && <p className="teach-empty">The classroom list is unavailable until the connection returns.</p>}
          {rows.map((row) => (
            <button
              key={row.profileId}
              type="button"
              className={row.profileId === selected ? 'is-selected' : ''}
              aria-pressed={row.profileId === selected}
              onClick={() => choose(row)}
            >
              <span className="teach-row__name">{personName(row.displayName)}</span>
              <span className="teach-row__exercise">{exerciseName(row.exercise)}</span>
              <span className="teach-row__meta">{activityName(row.presence)} · {freshness(row)}</span>
              <Outcome row={row} />
              <span className={`teach-pill teach-pill--${deliveryTone(row)}`}>{deliveryLabel(row)}</span>
              {row.helpRequested && <span className="teach-row__meta">Asked for help{row.helpNote ? `: ${row.helpNote}` : ''}</span>}
              {row.needsAttention && <span className="teach-row__meta">Same measured result {row.repeatCount} times</span>}
              {row.syntheticRepeat >= 3 && <span className="teach-row__meta">Synthetic example, repeated {row.syntheticRepeat}. Not real progress.</span>}
            </button>
          ))}
        </section>
        <section className="teach-detail" aria-label="Learner">
          {!learner && <p className="teach-empty">Select a learner to see their practice and prepare the next lesson.</p>}
          {learner && (
            <>
              <p className="eyebrow">Selected learner</p>
              <h2 className="title-serif">{personName(learner.displayName)}</h2>
              <p className="body ink">Current exercise: {exerciseName(learner.exercise)}</p>
              <p className="small">{activityName(learner.presence)}. {deliveryLabel(learner)}.</p>
              {learner.visible && learner.lessonRevision > 0 && <p className="small">Last change: {plainChange(learner.visible)}</p>}
              <h3 className="teach-h">Recent practice</h3>
              {attempts.length === 0 && <p className="small">No attempts yet.</p>}
              <ul className="teach-attempts">
                {attempts.map((item) => (
                  <li key={item.attemptId} className={item.kind === 'capture' ? 'is-capture' : item.synthetic ? 'is-synthetic' : ''}>
                    <p className="strong ink">{item.kind === 'capture' ? 'Recording needs another try' : item.synthetic ? 'Synthetic example' : item.provenance === 'provisional' ? 'Waiting for a verified result' : 'Measured practice'}</p>
                    <p>{findingName(item.finding)}</p>
                    <p>Exercise {exerciseName(item.exercise)}. Cue {cueName(item.cueId)}.</p>
                    <p>Reference {item.referenceVersion || 'unknown'}. Analysis {item.analysisVersion || 'unknown'}. {clockLabel(item.createdAt)}.</p>
                    <Measurements json={item.measurementsJson} />
                    <p>Word verification is not available, so this does not say a word was mispronounced.</p>
                  </li>
                ))}
              </ul>
              <section className="teach-next" aria-labelledby="next-lesson">
                <h3 id="next-lesson" className="teach-h">Next lesson</h3>
                <Editor draft={draft} setDraft={setDraft} />
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
                <div className="teach-actions">
                  <button type="button" className="btn btn--primary" disabled={same || !selected} onClick={() => void save('learner')}>
                    Send lesson to {personName(learner.displayName)}
                  </button>
                  <button type="button" className="btn" disabled={same} onClick={() => void save('classroom')}>
                    Assign to class
                  </button>
                </div>
                <p className="fine">Send lesson reaches only {personName(learner.displayName)}. Assign to class reaches everyone in {session.classroomId}.</p>
                {error && (
                  <p role="alert" className="teach-alert">
                    {error}{' '}
                    <button type="button" className="text-link" onClick={() => void save(lastScope)}>Try again</button>
                  </p>
                )}
              </section>
              <details className="teach-details">
                <summary>Lesson details</summary>
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
        Hear it again
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
