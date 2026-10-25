export type DevSession = {
  token: string;
  profileId: string;
  classroomId: string;
  role: 'teacher' | 'learner';
  database: string;
  uri: string;
  name: string;
  label: string;
  /** Minted silently for this device (autoJoin.ts), not an explicit class join. */
  auto?: boolean;
};

const KEY = 'articulate.classroom.session';
const NAME_KEY = 'articulate.learnerName';
const NAME = /^[a-z0-9-]{1,24}$/;

export function loadLearnerName(): string {
  try {
    const value = localStorage.getItem(NAME_KEY) ?? '';
    return NAME.test(value) ? value : '';
  } catch {
    return '';
  }
}

export function saveLearnerName(name: string): void {
  try {
    if (name) localStorage.setItem(NAME_KEY, name);
    else localStorage.removeItem(NAME_KEY);
  } catch {
    /* storage blocked: the name is display only */
  }
}

export function loadSession(): DevSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as DevSession;
    if (!value.token || !value.profileId || !value.database || !value.uri) return null;
    return value;
  } catch {
    return null;
  }
}

export function saveSession(session: DevSession): void {
  sessionStorage.setItem(KEY, JSON.stringify(session));
}

export function clearSession(): void {
  sessionStorage.removeItem(KEY);
}

function assignedKey(profileId: string): string {
  return `articulate.classroom.assigned.${profileId}`;
}

/** LessonSync records whether this profile's current lesson came from a teacher (not the default plan). */
export function storeTeacherLesson(profileId: string, assigned: boolean): void {
  try {
    if (assigned) localStorage.setItem(assignedKey(profileId), '1');
    else localStorage.removeItem(assignedKey(profileId));
  } catch {
    /* storage blocked */
  }
}

export function hasTeacherLesson(profileId: string): boolean {
  try {
    return localStorage.getItem(assignedKey(profileId)) === '1';
  } catch {
    return false;
  }
}

/**
 * The classroom flow (teacher greeting, straight to practice, no survey) is for an explicit class join, or for a
 * silently provisioned learner whose teacher has actually assigned a lesson. Otherwise onboarding is unchanged.
 */
export function classroomFlow(session: DevSession | null = loadSession()): boolean {
  if (!session || session.role !== 'learner') return false;
  return !session.auto || hasTeacherLesson(session.profileId);
}

export function wsUri(uri: string): string {
  if (uri.startsWith('https://')) return `wss://${uri.slice('https://'.length)}`;
  if (uri.startsWith('http://')) return `ws://${uri.slice('http://'.length)}`;
  return uri;
}

export function appliedKey(profileId: string): string {
  return `articulate.classroom.applied.${profileId}`;
}

export function loadAppliedRevision(profileId: string): number {
  try {
    const raw = localStorage.getItem(appliedKey(profileId));
    if (!raw) return 0;
    const value = JSON.parse(raw) as { revision?: number };
    return typeof value.revision === 'number' ? value.revision : 0;
  } catch {
    return 0;
  }
}

export function storeAppliedRevision(profileId: string, revision: number, commandId: string): void {
  localStorage.setItem(appliedKey(profileId), JSON.stringify({ revision, commandId }));
}

function noticeKey(profileId: string): string {
  return `articulate.classroom.notice.${profileId}`;
}

export function loadNoticedRevision(profileId: string): number {
  try {
    const raw = localStorage.getItem(noticeKey(profileId));
    const value = raw ? Number(raw) : 0;
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function storeNoticedRevision(profileId: string, revision: number): void {
  localStorage.setItem(noticeKey(profileId), String(revision));
}
