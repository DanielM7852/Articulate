export type DevSession = {
  token: string;
  profileId: string;
  classroomId: string;
  role: 'teacher' | 'learner';
  database: string;
  uri: string;
  name: string;
  label: string;
};

const KEY = 'articulate.classroom.session';

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
