/**
 * What the public telemetry stream knows about each classroom learner, folded by a pure reducer so it can be
 * tested without React or a connection. liveStatus.ts feeds it from subscribeTelemetry and exposes the hooks.
 *
 * Attribution follows the live graph (screens/Dashboard.tsx): a tab is named by the `pid` on its ui.join or
 * ui.ping, a join or ping without one unmaps it, and a tab with no event for PRESENCE_MS, or one that sent
 * ui.leave, is forgotten. The window is measured in event time, so backfill is attributed with the profile the
 * tab had announced when the event happened. Only booleans and timestamps are kept, never perception payloads.
 */

/** Same as the live graph: a tab with no event for this long is gone. */
export const PRESENCE_MS = 60_000;
/** Same as the live graph: a perception stream with no frame for this long reads as gone. */
export const PERCEPT_MS = 1_500;
/** With no lip frame at all for this long, a tab whose camera is on reads as having lost the face. */
export const FACE_LOST_MS = 5_000;
/** Rows older than this on arrival are backfill: they fill lessons and lastSeen, never live perception. */
export const STALE_MS = 30_000;

const MAX_LESSONS = 64;
const MAX_ATTRIBUTED = 200;

export type LiveEvent = {
  id: string;
  /** ms since epoch, the stream's own time for the row */
  at: number;
  kind: string;
  payload: Record<string, unknown>;
};

export type LessonSeen = {
  revision: number;
  received?: number;
  applied?: number;
  failed?: number;
};

export type SavedSeen = { revision: number; at: number; scope: string };

/** One browser tab, by its anonymous sid. Perception times are arrival times (wall clock), like the graph. */
type Tab = {
  pid: string | null;
  /** latest event time from this tab */
  seen: number;
  left: boolean;
  camera: { on: boolean } | null;
  frameAt: number | null;
  frameOk: boolean;
  okAt: number | null;
  spectrumAt: number | null;
  /** speech-to-text sockets by provider, open or closed */
  stt: Record<string, boolean>;
  phones: boolean | null;
  head: string | null;
};

type Learner = { lastSeen: number; lessons: Map<string, LessonSeen> };

export type LiveState = {
  tabs: Map<string, Tab>;
  learners: Map<string, Learner>;
  /** lesson.saved from the teacher's tab, by command id. It names no learner. */
  saved: Map<string, SavedSeen>;
  /** lesson.* event id -> the profile its tab had announced, for the Activity list */
  attributed: Map<string, string>;
};

export type LearnerLive = {
  /** tabs that announced this profile and sent an event in the last PRESENCE_MS */
  tabs: number;
  camera: 'on' | 'off' | null;
  face: 'tracking' | 'lost' | null;
  mic: 'listening' | 'closed' | null;
  phones: 'connected' | null;
  head: string | null;
  /** latest event time from any tab that announced this profile */
  lastSeen: number;
  lessons: Map<string, LessonSeen>;
};

export function emptyLiveState(): LiveState {
  return { tabs: new Map(), learners: new Map(), saved: new Map(), attributed: new Map() };
}

function freshTab(at: number): Tab {
  return {
    pid: null,
    seen: at,
    left: false,
    camera: null,
    frameAt: null,
    frameOk: false,
    okAt: null,
    spectrumAt: null,
    stt: {},
    phones: null,
    head: null,
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function validPid(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null;
}

function trim<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const first = map.keys().next();
    if (first.done) return;
    map.delete(first.value);
  }
}

/**
 * Folds one event into the state, in place. `now` is the wall clock at arrival. Returns true when something a
 * reader could see changed.
 */
export function reduceLive(state: LiveState, event: LiveEvent, now: number): boolean {
  const p = event.payload ?? {};
  const sid = str(p.sid);
  const kind = event.kind;

  if (kind === 'lesson.saved') {
    const commandId = str(p.commandId);
    if (!commandId) return false;
    const prev = state.saved.get(commandId);
    if (prev && prev.at >= event.at) return false;
    state.saved.set(commandId, { revision: Number(p.revision) || 0, at: event.at, scope: str(p.scope) ?? '' });
    trim(state.saved, MAX_LESSONS);
    return true;
  }
  if (!sid) return false;

  let tab = state.tabs.get(sid);
  // The tab's presence faded before this event (event time): it starts over, unmapped.
  if (tab && (tab.left || event.at - tab.seen > PRESENCE_MS) && event.at >= tab.seen) {
    state.tabs.delete(sid);
    tab = undefined;
  }
  if (!tab) {
    if (kind === 'ui.leave') return false;
    tab = freshTab(event.at);
    state.tabs.set(sid, tab);
  }
  tab.seen = Math.max(tab.seen, event.at);

  if (kind === 'ui.join' || kind === 'ui.ping') {
    tab.pid = validPid(p.pid);
  }
  if (kind === 'ui.leave') tab.left = true;

  const pid = tab.pid;
  if (!pid) return kind === 'ui.join' || kind === 'ui.ping';

  let learner = state.learners.get(pid);
  if (!learner) {
    learner = { lastSeen: 0, lessons: new Map() };
    state.learners.set(pid, learner);
  }
  learner.lastSeen = Math.max(learner.lastSeen, event.at);

  if (kind === 'lesson.received' || kind === 'lesson.applied' || kind === 'lesson.failed') {
    const commandId = str(p.commandId);
    if (!commandId) return true;
    const stage = kind === 'lesson.received' ? 'received' : kind === 'lesson.applied' ? 'applied' : 'failed';
    const entry = learner.lessons.get(commandId) ?? { revision: Number(p.revision) || 0 };
    if (entry[stage] === undefined || event.at < entry[stage]) entry[stage] = event.at;
    learner.lessons.delete(commandId);
    learner.lessons.set(commandId, entry);
    trim(learner.lessons, MAX_LESSONS);
    state.attributed.set(event.id, pid);
    trim(state.attributed, MAX_ATTRIBUTED);
    return true;
  }

  // Backfill never marks a camera, face, or microphone live.
  const live = now - event.at <= STALE_MS;
  if (!live) return true;
  switch (kind) {
    case 'camera.on':
      tab.camera = { on: true };
      break;
    case 'camera.off':
      tab.camera = { on: false };
      tab.frameAt = null;
      tab.okAt = null;
      break;
    case 'lip.frame':
      tab.frameAt = now;
      tab.frameOk = p.ok !== false;
      if (tab.frameOk) tab.okAt = now;
      break;
    case 'audio.spectrum':
      tab.spectrumAt = now;
      break;
    case 'stt.open':
    case 'stt.close':
      tab.stt[str(p.provider) ?? str(p.model) ?? 'default'] = kind === 'stt.open';
      break;
    case 'phones.open':
      tab.phones = true;
      break;
    case 'phones.close':
      tab.phones = false;
      break;
    case 'head.ready':
      tab.head = str(p.driver)?.slice(0, 32) ?? tab.head;
      break;
    case 'ui.leave':
      tab.camera = null;
      tab.frameAt = null;
      tab.okAt = null;
      tab.spectrumAt = null;
      tab.stt = {};
      tab.phones = null;
      break;
  }
  return true;
}

/** Forgets tabs whose presence faded by the wall clock. Learners (lessons, lastSeen) stay. */
export function pruneLive(state: LiveState, now: number): boolean {
  let changed = false;
  for (const [sid, tab] of state.tabs) {
    if (tab.left || now - tab.seen > PRESENCE_MS) {
      state.tabs.delete(sid);
      changed = true;
    }
  }
  return changed;
}

function liveTab(tab: Tab, now: number): boolean {
  return !tab.left && now - tab.seen <= PRESENCE_MS;
}

function faceOf(tab: Tab, now: number): 'tracking' | 'lost' | null {
  if (tab.camera && !tab.camera.on) return null;
  if (tab.frameAt === null) return null;
  if (now - tab.frameAt <= PERCEPT_MS) return tab.okAt !== null && now - tab.okAt <= PERCEPT_MS ? 'tracking' : 'lost';
  // Frames paused: keep the last verdict for a few seconds, then the face reads lost while the camera is on.
  if (now - tab.frameAt <= FACE_LOST_MS) return tab.frameOk ? 'tracking' : 'lost';
  return tab.camera?.on ? 'lost' : null;
}

function micOf(tab: Tab, now: number): 'listening' | 'closed' | null {
  if (tab.spectrumAt !== null && now - tab.spectrumAt <= PERCEPT_MS) return 'listening';
  const stt = Object.values(tab.stt);
  if (stt.some(Boolean)) return 'listening';
  if (tab.spectrumAt !== null || stt.length > 0) return 'closed';
  return null;
}

/** The learner's status at `now`, or null when no tab has ever announced this profile. */
export function learnerLive(state: LiveState, pid: string, now: number): LearnerLive | null {
  const learner = state.learners.get(pid);
  if (!learner) return null;
  const tabs = [...state.tabs.values()].filter((tab) => tab.pid === pid && liveTab(tab, now));
  const pick = <T extends string>(values: (T | null)[], order: T[]): T | null => {
    for (const value of order) if (values.includes(value)) return value;
    return null;
  };
  return {
    tabs: tabs.length,
    camera: pick(tabs.map((tab) => (tab.camera ? (tab.camera.on ? 'on' : 'off') : null)), ['on', 'off']),
    face: pick(tabs.map((tab) => faceOf(tab, now)), ['tracking', 'lost']),
    mic: pick(tabs.map((tab) => micOf(tab, now)), ['listening', 'closed']),
    phones: tabs.some((tab) => tab.phones === true) ? 'connected' : null,
    head: tabs.map((tab) => tab.head).find((head) => head !== null) ?? null,
    lastSeen: learner.lastSeen,
    lessons: new Map(learner.lessons),
  };
}

export type LiveSnapshot = {
  /** wall clock when this snapshot was taken */
  at: number;
  learners: Map<string, LearnerLive>;
  saved: Map<string, SavedSeen>;
  /** lesson.* event id -> profile id */
  attributed: Map<string, string>;
};

export function snapshotLive(state: LiveState, now: number): LiveSnapshot {
  const learners = new Map<string, LearnerLive>();
  for (const pid of state.learners.keys()) {
    const status = learnerLive(state, pid, now);
    if (status) learners.set(pid, status);
  }
  return { at: now, learners, saved: new Map(state.saved), attributed: new Map(state.attributed) };
}

/**
 * The stream's record of one lesson for one learner: by command id when the console knows it, else the latest
 * entry with the same revision. `byRevision` says which.
 */
export function lessonSeen(
  status: LearnerLive | null,
  commandId: string,
  revision: number,
): { seen: LessonSeen; byRevision: boolean } | null {
  if (!status) return null;
  if (commandId) {
    const seen = status.lessons.get(commandId);
    return seen ? { seen, byRevision: false } : null;
  }
  if (revision <= 0) return null;
  let found: LessonSeen | null = null;
  let latest = -Infinity;
  for (const seen of status.lessons.values()) {
    if (seen.revision !== revision) continue;
    const at = Math.max(seen.received ?? -Infinity, seen.applied ?? -Infinity, seen.failed ?? -Infinity);
    if (at > latest) {
      latest = at;
      found = seen;
    }
  }
  return found ? { seen: found, byRevision: true } : null;
}
