import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/global.css';
import Dashboard from '../screens/Dashboard';

/**
 * live.html: the information-flow graph on its own, for a wall display or an iPad.
 * No console, no learner presence (the telemetry client skips this page). Query or hash
 * params: `demo` replays sample traffic, `learner=<profile id>` limits the perception
 * cards to one learner, `attempt=<id>` limits the per-attempt cards. The screen is kept
 * awake while the page is visible, and the pointer hides after a few idle seconds.
 */
function params(): URLSearchParams {
  const hashQuery = window.location.hash.split('?')[1] ?? '';
  const merged = new URLSearchParams(window.location.search);
  for (const [k, v] of new URLSearchParams(hashQuery)) merged.set(k, v);
  return merged;
}

function useWakeLock() {
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const request = async () => {
      try {
        if (document.visibilityState !== 'visible') return;
        lock = (await navigator.wakeLock?.request('screen')) ?? null;
      } catch {
        lock = null; // not available (older iPadOS, low power mode); the display settings decide
      }
    };
    void request();
    document.addEventListener('visibilitychange', request);
    return () => {
      document.removeEventListener('visibilitychange', request);
      void lock?.release();
    };
  }, []);
}

function useIdleCursor(ms = 4000) {
  useEffect(() => {
    let timer = 0;
    const show = () => {
      document.body.style.cursor = '';
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        document.body.style.cursor = 'none';
      }, ms);
    };
    show();
    window.addEventListener('pointermove', show);
    return () => {
      window.removeEventListener('pointermove', show);
      window.clearTimeout(timer);
      document.body.style.cursor = '';
    };
  }, [ms]);
}

/** The graph reads `demo` from the hash only; carry query flags into the hash once so `live.html?demo=1` works. */
function hoistQueryIntoHash(): void {
  const q = new URLSearchParams(window.location.search);
  if (![...q.keys()].length) return;
  const hashQuery = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  for (const [k, v] of q) if (!hashQuery.has(k)) hashQuery.set(k, v);
  window.history.replaceState(null, '', `${window.location.pathname}#/?${hashQuery.toString()}`);
}

function Show() {
  useWakeLock();
  useIdleCursor();
  const p = params();
  return <Dashboard learner={p.get('learner') ?? ''} attempt={p.get('attempt') ?? ''} />;
}

hoistQueryIntoHash();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Show />
  </StrictMode>,
);
