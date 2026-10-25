import { useEffect, useState } from 'react';
import { subscribeTelemetry } from '../telemetry/client';
import { emptyLiveState, pruneLive, reduceLive, snapshotLive, type LearnerLive, type LiveSnapshot } from './liveStatusModel';

export type { LearnerLive, LessonSeen, LiveSnapshot, SavedSeen } from './liveStatusModel';
export { lessonSeen } from './liveStatusModel';

/** A snapshot of the stream's per-learner status, plus the roster's display names. */
export type LiveStatus = LiveSnapshot & { names: Map<string, string> };

/** Readers get a new snapshot at most this often. */
const PUBLISH_MS = 500;
/** Expiry (presence, face, microphone) is re-read this often even when no event arrives. */
const TICK_MS = 1000;

/*
 * One store per console. The telemetry subscription opens with the first reader and closes with the last, so the
 * roster's rows and the live tab share it rather than subscribing per row.
 */
let state = emptyLiveState();
let names = new Map<string, string>();
let view: LiveStatus = { ...snapshotLive(state, Date.now()), names };
const listeners = new Set<() => void>();
let off: (() => void) | null = null;
let tick: ReturnType<typeof setInterval> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastPublish = 0;

function publish(): void {
  timer = null;
  const now = Date.now();
  lastPublish = now;
  pruneLive(state, now);
  view = { ...snapshotLive(state, now), names };
  listeners.forEach((listener) => listener());
}

function schedule(): void {
  if (timer !== null) return;
  timer = setTimeout(publish, Math.max(0, PUBLISH_MS - (Date.now() - lastPublish)));
}

function start(): void {
  if (off) return;
  off = subscribeTelemetry((event) => {
    if (reduceLive(state, event, Date.now())) schedule();
  });
  tick = setInterval(schedule, TICK_MS);
}

function stop(): void {
  off?.();
  off = null;
  if (tick !== null) clearInterval(tick);
  if (timer !== null) clearTimeout(timer);
  tick = null;
  timer = null;
  // A new subscription replays the stream from the start, so the next reader rebuilds from nothing.
  state = emptyLiveState();
  view = { ...snapshotLive(state, Date.now()), names };
}

/** The classroom roster's display names by profile id, so the live tab can name learners. */
export function publishLearnerNames(next: Map<string, string>): void {
  if (next.size === names.size && [...next].every(([id, name]) => names.get(id) === name)) return;
  names = next;
  view = { ...view, names };
  listeners.forEach((listener) => listener());
}

export function useLiveStatus(): LiveStatus {
  const [snapshot, setSnapshot] = useState<LiveStatus>(() => view);
  useEffect(() => {
    const listener = () => setSnapshot(view);
    listeners.add(listener);
    start();
    setSnapshot(view);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) stop();
    };
  }, []);
  return snapshot;
}

/** One learner's status, or null until a tab has announced that profile. */
export function useLiveStatusFor(profileId: string): LearnerLive | null {
  const snapshot = useLiveStatus();
  return profileId ? snapshot.learners.get(profileId) ?? null : null;
}
