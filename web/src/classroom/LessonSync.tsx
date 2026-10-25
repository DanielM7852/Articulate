import { useEffect, useState } from 'react';
import { DbConnection } from '../module_bindings';
import { parseSettings, type LessonSettings } from '@lesson-rules';
import { decideLesson, type LessonSnap } from './applyLesson';
import { isCaptureBusy, subscribeCaptureBusy } from './captureGate';
import { IdentityForm } from './IdentityForm';
import { cueName, exerciseName, plainChange, supportName } from './labels';
import {
  loadAppliedRevision,
  loadNoticedRevision,
  loadSession,
  storeAppliedRevision,
  storeNoticedRevision,
  wsUri,
  type DevSession,
} from './session';
import { useAppState } from '../state/AppState';
import './classroom.css';
import type { Assistance } from '../state/types';

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
  const [onQuiz, setOnQuiz] = useState(() => window.location.hash.startsWith('#/quiz') || window.location.hash.startsWith('#/dashboard'));

  useEffect(() => {
    const read = () => setOnQuiz(window.location.hash.startsWith('#/quiz') || window.location.hash.startsWith('#/dashboard'));
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
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
      void conn.reducers.ackLesson({ revision: lesson.revision, phase, commandId: lesson.commandId }).catch(() => {
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
          const take = (row: Parameters<typeof rowToSnap>[0]) => consider(rowToSnap(row), isCaptureBusy());
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

  if (onQuiz) return null;

  if (!session || session.role !== 'learner') {
    return (
      <aside className="classroom-banner">
        <IdentityForm role="learner" onReady={setSession} />
      </aside>
    );
  }

  const practice = exerciseName(lessonTarget ?? plan.sound);
  return (
    <aside className="classroom-banner" aria-live="polite">
      <p className="classroom-id__label">Classroom {session.classroomId}</p>
      {lessonRevision > 0 && (
        <p className="small">Your practice: {practice}. {supportName(plan.assistance)} · {cueName(lessonCue ?? '')} · {lessonRepetitions} {lessonRepetitions === 1 ? 'repetition' : 'repetitions'}</p>
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
