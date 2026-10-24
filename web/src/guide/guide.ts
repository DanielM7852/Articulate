import type { MouthDemo } from '@mouth-demo/src/mouth-demo.js';
import avatarUrl from '@mouth-demo/public/avatars/brunette.glb?url';

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

/** Show the guide inside `host`. Resolves with the live demo; rejects if it cannot load. */
export function acquireGuide(host: HTMLElement): Promise<MouthDemo> {
  const el = node();
  host.append(el);
  holder = host;
  if (!loading) {
    loading = import('@mouth-demo/src/mouth-demo.js')
      .then((m) => m.createMouthDemo(el, { avatarUrl, controls: false }))
      .catch((err: unknown) => {
        loading = null; // allow a retry on the next screen
        el.replaceChildren();
        throw err;
      });
  }
  return loading.then((demo) => {
    if (holder === host) demo.resume();
    return demo;
  });
}

/** `host` no longer shows the guide. The demo stays alive, paused, for the next screen. */
export function releaseGuide(host: HTMLElement) {
  if (holder !== host) return;
  holder = null;
  mount?.remove();
  loading?.then((demo) => {
    if (holder === null) demo.pause();
  }).catch(() => undefined);
}
