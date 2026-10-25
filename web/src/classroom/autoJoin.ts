import { loadLearnerName, loadSession, saveSession, type DevSession } from './session';
import { announceLearner } from '../telemetry/client';

/**
 * Silent classroom provisioning. Every learner who starts the app gets a virtual learner, a device-stable
 * development identity in the default classroom, so the teacher console sees them without anyone logging in or
 * joining. A virtual learner is a device, not a person: the name is display only and grants nothing.
 *
 * Fire-and-forget: it never blocks Begin and never shows an error. If the backend is unreachable it tries once
 * more after 10 s, then gives up quietly for this page load. An existing session (explicit or silent) is kept.
 */

const DEVICE_KEY = 'articulate.deviceId';
const DEVICE = /^[a-z0-9]{4}$/;
const NAME = /^[a-z0-9-]{1,24}$/;
const RETRY_MS = 10_000;
const FALLBACK_CLASSROOM = 'room-1';

let device: string | null = null;
let inflight: Promise<DevSession | null> | null = null;
let gaveUp = false;

/** 4 base36 characters, persisted per browser, so two devices with one typed name do not share a profile. */
export function deviceSuffix(): string {
  if (device) return device;
  try {
    const saved = localStorage.getItem(DEVICE_KEY);
    if (saved && DEVICE.test(saved)) {
      device = saved;
      return device;
    }
  } catch {
    /* storage blocked: this page load only */
  }
  const bytes = new Uint8Array(4);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  device = Array.from(bytes, (b) => (b % 36).toString(36)).join('');
  try {
    localStorage.setItem(DEVICE_KEY, device);
  } catch {
    /* in-memory only */
  }
  return device;
}

/** What the learner typed, as a classroom name part: lowercase, [a-z0-9-], at most 24 characters. */
export function learnerSlug(typed: string): string {
  return typed
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, 24)
    .replace(/-+$/, '');
}

/** `lea-k3f9` for a typed name, `learner-k3f9` without one. The base is cut so the whole name stays within 24. */
export function virtualLearnerName(typed: string, suffix: string = deviceSuffix()): string {
  const base = learnerSlug(typed).slice(0, 24 - suffix.length - 1).replace(/-+$/, '');
  return `${base || 'learner'}-${suffix}`;
}

export function defaultClassroom(): string {
  const raw = String(import.meta.env.VITE_CLASSROOM_DEFAULT ?? '').trim().toLowerCase();
  return NAME.test(raw) ? raw : FALLBACK_CLASSROOM;
}

type Outcome = { kind: 'ok'; session: DevSession } | { kind: 'unreachable' } | { kind: 'refused' };

async function request(name: string, classroom: string): Promise<Outcome> {
  try {
    const response = await fetch('/v1/dev/classroom/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'learner', name, classroom }),
    });
    // 404: the development classroom is off on this host; 4xx: the request itself was refused. A retry will not help.
    if (!response.ok) return response.status >= 500 ? { kind: 'unreachable' } : { kind: 'refused' };
    const body = (await response.json()) as DevSession;
    if (!body?.token || !body.profileId || !body.database || !body.uri) return { kind: 'refused' };
    return {
      kind: 'ok',
      session: { ...body, role: 'learner', name, label: body.label || 'development identity', auto: true },
    };
  } catch {
    return { kind: 'unreachable' };
  }
}

async function provision(typed: string): Promise<DevSession | null> {
  const name = virtualLearnerName(typed);
  const classroom = defaultClassroom();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, RETRY_MS));
    const existing = loadSession();
    if (existing) return existing; // joined explicitly in the meantime
    const outcome = await request(name, classroom);
    if (outcome.kind === 'ok') {
      const already = loadSession();
      if (already) return already;
      try {
        saveSession(outcome.session);
      } catch {
        return null; // no session storage: the app runs without the classroom
      }
      window.dispatchEvent(new Event('articulate-classroom-session'));
      announceLearner();
      return outcome.session;
    }
    if (outcome.kind === 'refused') break;
  }
  gaveUp = true;
  return null;
}

/**
 * Mints a virtual learner for this device unless a session already exists. Resolves to the session, or null when
 * the classroom is not available; never rejects. `name` is what the learner typed (empty or omitted: the stored name).
 */
export function ensureVirtualLearner(name?: string): Promise<DevSession | null> {
  try {
    const existing = loadSession();
    if (existing) return Promise.resolve(existing);
    if (inflight) return inflight;
    if (gaveUp) return Promise.resolve(null);
    inflight = provision(name ?? loadLearnerName())
      .catch(() => null)
      .finally(() => {
        inflight = null;
      });
    return inflight;
  } catch {
    return Promise.resolve(null);
  }
}

/**
 * App start: covers a returning learner who reloads past the landing page without a session. The landing page
 * itself waits for Begin, so the name typed there is used. The live console and recap pages are not learners.
 */
export function startVirtualLearner(): void {
  try {
    if (/teach\.html$/i.test(window.location.pathname)) return;
    const hash = window.location.hash;
    if (hash === '' || hash === '#' || hash === '#/') return;
    if (/^#\/?(dashboard|recap)/.test(hash)) return;
  } catch {
    return;
  }
  void ensureVirtualLearner();
}
