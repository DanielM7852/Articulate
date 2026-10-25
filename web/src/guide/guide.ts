import type { MouthDemo } from '@mouth-demo/src/mouth-demo.js';
import avatarUrl from '@mouth-demo/public/avatars/brunette.glb?url';
import posterUrl from '../assets/landing/sculptural-voice.png';
import { attachDemo, noteDecision, reportChange, setGuideShown } from './quality';

/** detect-gpu's benchmark tables, copied into public/ by scripts/copy-detect-gpu.mjs (no CDN at runtime). */
const BENCHMARKS_URL = new URL(`${import.meta.env.BASE_URL}detect-gpu/benchmarks`, window.location.href).href.replace(/\/$/, '');

/**
 * One guide for the whole session.
 *
 * The 3D face (three.js, a 4.7 MB avatar, a WebGL context) is created once and
 * handed from screen to screen by moving its mount node, instead of being torn
 * down and rebuilt on every route change. That makes the intro → tutorial →
 * practice handoffs instant, and avoids piling up WebGL contexts, which is the
 * usual reason a second load fails on real hardware. While no screen holds it,
 * the render loop is paused.
 */
let mount: HTMLDivElement | null = null;
let loading: Promise<MouthDemo> | null = null;
let holder: HTMLElement | null = null;

function node() {
  if (!mount) {
    mount = document.createElement('div');
    mount.className = 'guide-mount';
  }
  return mount;
}

export interface AcquireOptions {
  /**
   * This screen opens on an empty stage and calls assemble() itself. The first load starts dispersed;
   * a guide that is already assembled dissolves away. Without it, a dispersed guide assembles again,
   * so every other screen finds the head in place.
   */
  startDispersed?: boolean;
}

/** Show the guide inside `host`. Resolves with the live demo; rejects if it cannot load. */
export function acquireGuide(host: HTMLElement, { startDispersed = false }: AcquireOptions = {}): Promise<MouthDemo> {
  const el = node();
  host.append(el);
  holder = host;
  setGuideShown(true);
  if (!loading) {
    // The quality tier is decided first (once per tab session: `?quality=`, then the learner's stored
    // choice, then the hardware); 'simple' builds no 3D at all. A pinned choice turns off automatic steps.
    loading = Promise.all([import('@mouth-demo/src/quality.js'), import('@mouth-demo/src/mouth-demo.js')])
      .then(async ([q, m]) => {
        const decision = await q.detectTier({ benchmarksURL: BENCHMARKS_URL });
        noteDecision(decision);
        // The particle head is the default look; `?style=hologram` on the page URL compares the painted lattice.
        const demo = await m.createMouthDemo(el, {
          avatarUrl,
          controls: false,
          style: 'particles',
          startDispersed,
          quality: decision.tier,
          adaptive: decision.source !== 'user',
          qualityReason: decision.reason,
          posterUrl,
          onQualityChange: reportChange,
        });
        attachDemo(demo);
        return demo;
      })
      .catch((err: unknown) => {
        loading = null; // allow a retry on the next screen
        el.replaceChildren();
        throw err;
      });
  }
  return loading.then((demo) => {
    if (holder === host) {
      demo.resume();
      const away = demo.assembly === 'dispersed' || demo.assembly === 'dispersing';
      if (startDispersed && !away) void demo.disperse();
      else if (!startDispersed && away) void demo.assemble();
    }
    return demo;
  });
}

/** `host` no longer shows the guide. The demo stays alive, paused, for the next screen. */
export function releaseGuide(host: HTMLElement) {
  if (holder !== host) return;
  holder = null;
  setGuideShown(false);
  mount?.remove();
  loading?.then((demo) => {
    if (holder === null) demo.pause();
  }).catch(() => undefined);
}
