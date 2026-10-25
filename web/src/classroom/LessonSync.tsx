import { useEffect, useState } from 'react';
import { DbConnection } from '../module_bindings';
import { parseSettings, type LessonSettings } from '@lesson-rules';
import { decideLesson, type LessonSnap } from './applyLesson';
import { isCaptureBusy, subscribeCaptureBusy } from './captureGate';
import { clockLabel, cueName, exerciseName, plainChange, supportName } from './labels';
import {
  loadAppliedRevision,
  loadNoticedRevision,
  loadSession,
  storeAppliedRevision,
  storeNoticedRevision,
  storeTeacherLesson,
  wsUri,
  type DevSession,
} from './session';
import { emit } from '../telemetry/client';
import { useAppState } from '../state/AppState';
import './classroom.css';
import type { Assistance } from '../state/types';

function landingHash(hash: string) {
  return hash === '' || hash === '#' || hash === '#/';
}

let shownNotice: { profileId: string; revision: number; text: string } | null = null;

/**
 * Subscribes to this learner's effective lesson. Receipt is acknowledged
 * immediately. Application waits until capture is idle, then the visible
 * plan changes, then application is acknowledged. Snapshots are not spoken.
 */
export function LessonSync() {
  const { applyTeacherLesson, lessonTarget, lessonCue, lessonRepetitions, lessonRevision, plan } = useAppState();
  const [session, setSession] = useState<DevSession | null>(() => loadSession());
  const [notice, setNotice] = useState<string | null>(() => {
    const saved = loadSession();
    return saved && shownNotice?.profileId === saved.profileId ? shownNotice.text : null;
  });
  const [pending, setPending] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [meta, setMeta] = useState<LessonMeta | null>(null);
  const [onQuiz, setOnQuiz] = useState(() => window.location.hash.startsWith('#/quiz') || window.location.hash.startsWith('#/dashboard'));
  const [onLanding, setOnLanding] = useState(() => landingHash(window.location.hash));

  useEffect(() => {
    const read = () => {
      const hash = window.location.hash;
      setOnQuiz(hash.startsWith('#/quiz') || hash.startsWith('#/dashboard'));
      setOnLanding(landingHash(hash));
    };
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  useEffect(() => {
    const sync = () => setSession(loadSession());
    window.addEventListener('articulate-classroom-session', sync);
    return () => window.removeEventListener('articulate-classroom-session', sync);
  }, []);

  useEffect(() => {
    if (!session || session.role !== 'learner') return;
    let closed = false;
    let conn: DbConnection | null = null;
    let applied = loadAppliedRevision(session.profileId);
    let queued: LessonSnap | null = null;
    const acked = new Set<string>();

    const ack = (lesson: LessonSnap, phase: 'received' | 'applied' | 'failed') => {
      const key = `${lesson.revision}:${phase}:${lesson.commandId}`;
      if (acked.has(key) || !conn) return;
      acked.add(key);
      void conn.reducers.ackLesson({ revision: lesson.revision, phase, commandId: lesson.commandId }).then(() => {
        const kind = phase === 'received' ? 'lesson.received' : phase === 'applied' ? 'lesson.applied' : 'lesson.failed';
        const label = phase === 'received' ? 'Lesson received' : phase === 'applied' ? 'Lesson applied' : 'Lesson failed';
        emit('ui', 'db', kind, label, { commandId: lesson.commandId, revision: lesson.revision });
      }, () => {
        acked.delete(key);
      });
    };

    const apply = (lesson: LessonSnap) => {
      let settings: LessonSettings;
      try {
        settings = parseSettings(lesson.settingsJson);
      } catch {
        ack(lesson, 'failed');
        setNotice('A lesson update arrived, but its settings were not usable.');
        return;
      }
      const sound = settings.target === 'i' || settings.target === 'u' || settings.target === 'a' ? settings.target : null;
      applyTeacherLesson({
        instruction: `Lesson updated by your teacher. ${lesson.visible}`,
        revision: lesson.revision,
        target: settings.target,
        assistance: settings.assistance as Assistance,
        sound,
        cue: settings.cueId,
        repetitions: settings.repetitions,
        note: settings.note,
        reference: settings.referenceReplay,
      });
      applied = lesson.revision;
      storeAppliedRevision(session.profileId, lesson.revision, lesson.commandId);
      if (loadNoticedRevision(session.profileId) !== lesson.revision) {
        const text = `Your teacher updated your next practice. ${plainChange(lesson.visible)}`;
        shownNotice = { profileId: session.profileId, revision: lesson.revision, text };
        storeNoticedRevision(session.profileId, lesson.revision);
        setNotice(text);
      }
      setPending(null);
      ack(lesson, 'applied');
    };

    const consider = (lesson: LessonSnap, captureBusy: boolean) => {
      if (lesson.revision > 0 && lesson.commandId) ack(lesson, 'received');
      const decision = decideLesson({ appliedRevision: applied, incoming: lesson, recording: captureBusy });
      if (decision.kind === 'pending') {
        queued = decision.lesson;
        setPending('Will start after this recording.');
        return;
      }
      queued = null;
      if (decision.kind === 'apply') apply(decision.lesson);
      else if (decision.kind === 'same' && lesson.revision > 0) {
        try {
          const settings = parseSettings(lesson.settingsJson);
          const sound = settings.target === 'i' || settings.target === 'u' || settings.target === 'a' ? settings.target : null;
          applyTeacherLesson({
            instruction: '',
            revision: lesson.revision,
            target: settings.target,
            assistance: settings.assistance as Assistance,
            sound,
            cue: settings.cueId,
            repetitions: settings.repetitions,
            note: settings.note,
            reference: settings.referenceReplay,
          });
        } catch {
          setLink('The latest lesson could not be read on this device.');
        }
      }
    };

    const connect = () => {
      conn = DbConnection.builder()
        .withUri(wsUri(session.uri))
        .withDatabaseName(session.database)
        .withToken(session.token)
        .onConnect((connection) => {
          if (closed) return;
          conn = connection;
          const take = (row: Parameters<typeof rowToSnap>[0] & LessonMeta) => {
            setMeta(rowMeta(row));
            // A teacher-assigned lesson (override or classroom) moves a silent learner into the classroom flow.
            storeTeacherLesson(session.profileId, row.revision > 0 && row.source !== 'default');
            consider(rowToSnap(row), isCaptureBusy());
          };
          connection.db.myClassroomLesson.onInsert((_ctx, row) => take(row));
          connection.db.myClassroomLesson.onUpdate((_ctx, _old, row) => take(row));
          connection.subscriptionBuilder().onApplied((ctx) => {
            for (const row of ctx.db.myClassroomLesson.iter()) take(row);
          }).subscribe(['SELECT * FROM my_classroom_lesson']);
          void connection.reducers.setPresence({ presence: 'idle', exercise: 'unknown' });
        })
        .onConnectError(() => {
          if (!closed) setLink('Classroom connection is offline.');
        })
        .onDisconnect(() => {
          if (!closed) setLink('Classroom connection is offline.');
        })
        .build();
    };
    connect();

    const stop = subscribeCaptureBusy(() => {
      if (!isCaptureBusy() && queued) consider(queued, false);
    });
    const onAttempt = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        attemptId?: string;
        exercise?: string;
        usable?: boolean;
        finding?: string;
      } | undefined;
      if (!detail?.attemptId || !conn) return;
      void conn.reducers.reportProvisional({
        attemptId: detail.attemptId,
        exercise: detail.exercise || 'unknown',
        usable: Boolean(detail.usable),
        finding: detail.finding || 'none',
        referenceVersion: 'client',
        measurementsJson: '{}',
      });
    };
    const beat = window.setInterval(() => {
      if (conn) void conn.reducers.setPresence({ presence: isCaptureBusy() ? 'recording' : 'idle', exercise: 'unknown' });
    }, 5000);
    const onHelp = () => {
      if (conn) void conn.reducers.requestHelp({ message: 'I would like help with this exercise.' });
      setLink('Help request sent to your teacher.');
    };
    window.addEventListener('articulate-practice-attempt', onAttempt);
    window.addEventListener('articulate-help', onHelp);
    return () => {
      closed = true;
      stop();
      window.clearInterval(beat);
      window.removeEventListener('articulate-practice-attempt', onAttempt);
      window.removeEventListener('articulate-help', onHelp);
      conn?.disconnect();
    };
  }, [session, applyTeacherLesson]);

  // The landing page has its own Begin and provisions a virtual learner silently, so this banner stays off that screen.
  if (onQuiz || onLanding) return null;

  // 2026-10-25: learners no longer join anything by hand. Without a session (backend down, or the virtual
  // learner still being minted) the banner stays off instead of showing a join form.
  // if (!session || session.role !== 'learner') {
  //   return (
  //     <aside className="classroom-banner">
  //       <IdentityForm role="learner" onReady={setSession} />
  //     </aside>
  //   );
  // }
  if (!session || session.role !== 'learner') return null;

  const practice = exerciseName(lessonTarget ?? plan.sound);
  return (
    <aside className="classroom-banner" aria-live="polite">
      <p className="classroom-id__label">{meta?.classroomName || `Classroom ${session.classroomId}`}</p>
      {meta?.teacherName && <p className="small">Teacher {meta.teacherName}</p>}
      {meta && meta.savedAt !== 0n && <p className="small">Saved {clockLabel(meta.savedAt)}</p>}
      {meta && meta.receivedAt !== 0n && <p className="small">Received {clockLabel(meta.receivedAt)}</p>}
      {meta && meta.appliedAt !== 0n && <p className="small">Applied {clockLabel(meta.appliedAt)}</p>}
      {lessonRevision > 0 && (
        <p className="small">Your practice: {practice}. {supportName(plan.assistance)} Â· {cueName(lessonCue ?? '')} Â· {lessonRepetitions} {lessonRepetitions === 1 ? 'repetition' : 'repetitions'}</p>
      )}
      {pending && <p className="classroom-banner__pending">{pending}</p>}
      {notice && <p className="classroom-banner__notice">{notice}</p>}
      {link && <p className="small">{link}</p>}
      <button type="button" className="text-link" onClick={() => window.dispatchEvent(new Event('articulate-help'))}>
        Ask the teacher for help
      </button>
    </aside>
  );
}

type LessonMeta = {
  teacherName: string;
  classroomName: string;
  savedAt: bigint;
  receivedAt: bigint;
  appliedAt: bigint;
};

function rowMeta(row: LessonMeta): LessonMeta {
  return {
    teacherName: row.teacherName || '',
    classroomName: row.classroomName || '',
    savedAt: row.savedAt || 0n,
    receivedAt: row.receivedAt || 0n,
    appliedAt: row.appliedAt || 0n,
  };
}

function rowToSnap(row: {
  revision: number;
  commandId: string;
  source: string;
  visible: string;
  settingsJson: string;
  ackPhase: string;
}): LessonSnap {
  return {
    revision: row.revision,
    commandId: row.commandId,
    source: row.source,
    visible: row.visible,
    settingsJson: row.settingsJson,
    ackPhase: row.ackPhase,
  };
}
