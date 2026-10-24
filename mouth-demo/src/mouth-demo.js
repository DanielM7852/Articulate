import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./styles.css";

import { createScene } from "./scene.js";
import { createViews } from "./views.js";
import { computeMouthAnchor } from "./mouth-anchor.js";
import { createHighlight } from "./highlight.js";
import { createHologram } from "./hologram.js";
import { createParticles } from "./particles.js";
import { createTalkingHeadDriver } from "./drivers/talkinghead.js";
import { createThreeDriver } from "./drivers/three.js";
import { CUES } from "./cues.js";
import { createTimeline, easeInOutCubic } from "./timeline.js";
import { createCutaway } from "./cutaway.js";

const DEFAULT_AVATAR = "/avatars/brunette.glb";
const TH_TIMEOUT_MS = 10000;
const SWING_MS = 1200;
const LOOK = { yaw: 0.45, pitch: 0.28, ease: 0.08 }; // radians at full deflection, per-frame lerp
const NOTE = "Mouth demonstrations are illustrative and would be reviewed by speech therapists before real use.";
const DRIVERS = ["auto", "talkinghead", "three"];
const STYLES = ["hologram", "porcelain", "hybrid", "solid"];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function readParams() {
  const q = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  const pick = (key, allowed) => (allowed.includes(q.get(key)) ? q.get(key) : null);
  return {
    driver: pick("driver", DRIVERS),
    style: pick("style", STYLES),
    debug: q.has("debug"),
    thfail: q.has("thfail"),
  };
}

// "auto" tries TalkingHead (10 s budget) and falls back to the plain three.js driver.
async function selectDriver(mode, { host, scene, camera, url, thfail }) {
  const makeThree = () => createThreeDriver({ scene, url });
  if (mode === "three") return makeThree();

  const ac = new AbortController();
  const attempt = (async () => {
    if (thfail) throw new Error("TalkingHead failure forced by ?thfail");
    return createTalkingHeadDriver({ container: host, scene, camera, url, signal: ac.signal });
  })();

  if (mode === "talkinghead") return attempt;

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TalkingHead did not load within ${TH_TIMEOUT_MS / 1000} s`)), TH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([attempt, timeout]);
  } catch (err) {
    console.warn("[mouth-demo] TalkingHead unavailable, falling back to the three.js driver:", err?.message ?? err);
    ac.abort();
    // A load that resolves after we gave up must not leak into the scene.
    attempt.then((late) => { try { late?.dispose?.(); } catch { /* ignore */ } }, () => {});
    return makeThree();
  } finally {
    clearTimeout(timer);
  }
}

export async function createMouthDemo(container, options = {}) {
  const params = readParams();
  const opts = {
    avatarUrl: options.avatarUrl ?? DEFAULT_AVATAR,
    driver: params.driver ?? (DRIVERS.includes(options.driver) ? options.driver : "auto"),
    style: params.style ?? (STYLES.includes(options.style) ? options.style : "hologram"),
    controls: options.controls !== false,
  };

  // DOM
  const root = el("div", "md-root");
  root.dataset.view = "front";
  root.dataset.style = opts.style;
  const stage = el("div", "md-stage");
  const host = el("div", "md-canvas-host");
  stage.append(host);
  const loading = el("div", "md-loading", "Loading model…");
  loading.setAttribute("role", "status");
  stage.append(loading);
  const caption = el("div", "md-caption");
  caption.setAttribute("aria-live", "polite");
  root.append(stage, caption);

  let btnSlow = null;
  let btnView = null;
  if (opts.controls) {
    const bar = el("div", "md-controls");
    const mk = (label, onClick) => {
      const b = el("button", "md-btn", label);
      b.type = "button";
      b.addEventListener("click", onClick);
      bar.append(b);
      return b;
    };
    mk("Replay", () => demo.replay());
    btnSlow = mk("Slow-mo", () => demo.setSpeed(timeline.speed === 1 ? 0.5 : 1));
    btnSlow.setAttribute("aria-pressed", "false");
    btnView = mk("Side view", () => demo.setView(view === "side" ? "front" : "side"));
    btnView.setAttribute("aria-pressed", "false");
    root.append(bar);
  }
  root.append(el("p", "md-note", "Illustrative demonstration, to be reviewed by speech therapists."));
  let debugEl = null;
  if (params.debug) {
    debugEl = el("div", "md-debug");
    root.append(debugEl);
  }
  container.append(root);

  // Teardown registry (run in reverse creation order)
  const disposers = [];
  let disposed = false;
  const teardown = () => {
    while (disposers.length) {
      try { disposers.pop()(); } catch (err) { console.warn("[mouth-demo] dispose step failed:", err); }
    }
  };

  const timeline = createTimeline();
  const S = { w: 0, vis: 0, show: 0 }; // w: face toward cue target, vis: highlight, show: cutaway opacity
  let view = "front";
  let cueId = null;
  let cue = null;
  let driven = null; // cue whose shapes are currently overriding the face
  let driver = null;
  let scene = null;
  let hologram = null;
  let particles = null;
  let highlight = null;
  let views = null;
  let cutaway = null;
  let style = opts.style;
  let look = null; // { x, y } in [-1, 1], +x = viewer's right, +y = up; null releases the head
  const lookNow = { x: 0, y: 0 };
  let headRest = null;

  const renderDebug = () => {
    if (debugEl) debugEl.textContent = `driver: ${driver?.name ?? "-"} | style: ${style} | ${NOTE}`;
  };

  // Size recorded by the ResizeObserver, applied at the start of the next frame
  // so the drawing buffer is never cleared after that frame has rendered.
  let pendingSize = null;

  try {
    scene = createScene(host);
    disposers.push(() => scene.dispose());
    scene.setSolidLighting(style === "solid");
    cutaway = createCutaway(stage);
    disposers.push(() => cutaway.dispose());

    driver = await selectDriver(opts.driver, {
      host, scene: scene.scene, camera: scene.camera, url: opts.avatarUrl, thfail: params.thfail,
    });
    disposers.push(() => driver.dispose());

    headRest = driver.headBone.rotation.clone();
    const anchor = computeMouthAnchor(driver);
    highlight = createHighlight({ headBone: driver.headBone, camera: scene.camera, anchor });
    if (!highlight.mesh.parent) driver.headBone.add(highlight.mesh);
    disposers.push(() => highlight.dispose());

    views = createViews({ camera: scene.camera, controls: scene.controls, canvas: scene.canvas });
    views.setAnchor(driver.headBone, anchor.headLocal);
    views.snap();
    disposers.push(() => views.dispose());

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    hologram = createHologram({
      renderer: scene.renderer, scene: scene.scene, camera: scene.camera,
      root: driver.root, style, reducedMotion: mq.matches,
    });
    hologram.setMouth(anchor.restCenter, anchor.radius);
    disposers.push(() => hologram.dispose());

    particles = createParticles({ camera: scene.camera, reducedMotion: mq.matches });
    if (!particles.points.parent) scene.scene.add(particles.points);
    particles.setVisible(style === "hologram");
    disposers.push(() => particles.dispose());
    if (params.debug) window.__mouthDemo = { scene, driver, anchor, highlight, views, hologram, particles };

    const onMotion = (e) => {
      views.setReducedMotion(e.matches);
      hologram.setReducedMotion(e.matches);
      particles.setReducedMotion(e.matches);
    };
    views.setReducedMotion(mq.matches);
    mq.addEventListener("change", onMotion);
    disposers.push(() => mq.removeEventListener("change", onMotion));

    const measure = () => {
      const w = Math.floor(host.clientWidth);
      const h = Math.floor(host.clientHeight);
      if (w < 1 || h < 1) return null;
      return { w, h };
    };
    const ro = new ResizeObserver(() => {
      const size = measure();
      if (size) pendingSize = size;
    });
    ro.observe(host);
    disposers.push(() => ro.disconnect());
    const initial = measure();
    if (initial) {
      scene.setSize(initial.w, initial.h);
      hologram.setSize(initial.w, initial.h);
    }
  } catch (err) {
    console.error("[mouth-demo] failed to start:", err);
    loading.textContent = "The mouth demonstration could not load.";
    loading.setAttribute("role", "alert");
    loading.classList.add("md-loading--error");
    teardown();
    throw err;
  }

  // Choreography
  const showTarget = () => (view === "side" ? 1 : 0);

  const emit = (phase) => {
    container.dispatchEvent(new CustomEvent("cue:phase", { bubbles: true, detail: { cueId, phase } }));
  };

  const paint = (c) => {
    if (c) {
      driven = c;
      for (const [name, value] of Object.entries(c.shapes)) driver.setShape(name, value * S.w);
      if (view === "side" || S.show > 0) cutaway.setPose("neutral", c.cutawayPose, S.w);
    }
    highlight.setVisibility(S.vis);
    cutaway.show(S.show);
  };

  const release = (c) => {
    if (!c) return;
    driver.releaseShapes(Object.keys(c.shapes));
    if (driven === c) driven = null;
  };

  // One phase; `to` tweens the named channels from their value at phase start (so interrupts never jump).
  const tween = (name, duration, to, c, hooks = {}) => {
    let from = S;
    return {
      name,
      duration,
      onStart() {
        from = { ...S };
        emit(name);
        hooks.onStart?.();
      },
      onUpdate(t) {
        if (!to) return;
        const e = easeInOutCubic(t);
        for (const k of Object.keys(to)) S[k] = t >= 1 ? to[k] : from[k] + (to[k] - from[k]) * e;
        paint(c);
      },
      onEnd() {
        if (to && to.w === 0) release(c);
        hooks.onEnd?.();
      },
    };
  };

  const pulseOn = () => highlight.setPulse(true);
  const pulseOff = () => highlight.setPulse(false);

  const frontLoop = (c) => [
    tween("in", 600, { w: 1, vis: 1, show: showTarget() }, c, { onStart: () => hologram.triggerRipple() }),
    tween("hold", 2000, null, c, { onStart: pulseOn, onEnd: pulseOff }),
    tween("out", 600, { w: 0, vis: 0 }, c),
    tween("rest", 1500, null, c),
  ];

  const sideLoop = (c) => [
    tween("in", 600, { w: 1, vis: 1, show: 1 }, c),
    tween("hold", 2500, null, c, { onStart: () => { pulseOn(); cutaway.setHighlight(1); }, onEnd: pulseOff }),
    tween("relax", 600, { w: 0, vis: 0 }, c, { onStart: () => cutaway.setHighlight(0) }),
    tween("rest", 1500, null, c),
  ];

  const swingHooks = (dir, extra = {}) => ({
    onStart() {
      views.setView(dir > 0 ? "side" : "front", { durationMs: SWING_MS });
      hologram.setSwing(true);
      particles.setSwing(dir);
      extra.onStart?.();
    },
    onEnd() {
      hologram.setSwing(false);
      particles.setSwing(0);
      extra.onEnd?.();
    },
  });

  // Phases that return the face to neutral before a different cue (or a replay) takes over.
  const prefix = (c, force = false) => {
    const d = driven;
    if (!d) return [];
    if ((d !== c || force) && S.w > 0.02) return [tween("reset", 300, { w: 0, vis: 0, show: showTarget() }, d)];
    if (d !== c) release(d);
    return [];
  };

  const quiet = () => {
    highlight.setPulse(false);
    cutaway.setHighlight(0);
    hologram.setSwing(false);
    particles.setSwing(0);
  };

  const run = (phases, playOpts) => {
    quiet();
    return timeline.play(phases, playOpts);
  };

  const syncButtons = () => {
    if (btnSlow) btnSlow.setAttribute("aria-pressed", String(timeline.speed !== 1));
    if (btnView) {
      btnView.setAttribute("aria-pressed", String(view === "side"));
      btnView.textContent = view === "side" ? "Front view" : "Side view";
    }
    root.style.setProperty("--md-swing-ms", `${SWING_MS / (timeline.speed || 1)}ms`);
  };

  const startCueLoop = (force) => {
    const pre = prefix(cue, force);
    const loop = view === "side" ? sideLoop(cue) : frontLoop(cue);
    run([...pre, ...loop], { loop: true, loopStart: pre.length });
  };

  const demo = {
    driverName: driver.name,

    showCue(id) {
      const next = CUES[id];
      if (!next) {
        console.warn(`[mouth-demo] unknown cue "${id}"`);
        return;
      }
      const pre = prefix(next);
      cueId = id;
      cue = next;
      caption.textContent = next.caption;
      const loop = view === "side" ? sideLoop(next) : frontLoop(next);
      run([...pre, ...loop], { loop: true, loopStart: pre.length });
    },

    replay() {
      if (cue) startCueLoop(true);
    },

    setSpeed(s) {
      if (!(s > 0)) return;
      timeline.speed = s;
      syncButtons();
    },

    setView(next) {
      if (next !== "front" && next !== "side") return Promise.resolve(false);
      if (next === view) return Promise.resolve(true);
      view = next;
      root.dataset.view = next;
      syncButtons();
      const dir = next === "side" ? 1 : -1;
      const pre = prefix(cue);
      let finished;
      const done = new Promise((resolve) => { finished = resolve; });
      const hooks = swingHooks(dir, { onEnd: () => finished(true) });
      let phases;
      let loopStart;
      if (!cue) {
        phases = [...pre, tween("swing", SWING_MS, { show: showTarget() }, null, hooks)];
        run(phases).then(() => finished(false));
        return done;
      }
      if (next === "side") {
        const first = tween("swing", SWING_MS, { w: 1, vis: 1, show: 1 }, cue, hooks);
        const a = sideLoop(cue);
        a.shift();
        const second = sideLoop(cue);
        phases = [...pre, first, ...a, ...second];
        loopStart = pre.length + 4;
      } else {
        const first = tween("swing", SWING_MS, { w: 0, vis: 0, show: 0 }, cue, hooks);
        phases = [...pre, first, ...frontLoop(cue)];
        loopStart = pre.length + 1;
      }
      run(phases, { loop: true, loopStart }).then(() => finished(false));
      return done;
    },

    stop() {
      const d = driven;
      cueId = null;
      cue = null;
      caption.textContent = "";
      run([tween("reset", 300, { w: 0, vis: 0, show: showTarget() }, d)]);
    },

    // Turn the head toward a point in front of the screen (camera or pointer). Eased in the render loop.
    lookAt(target) {
      look = target && Number.isFinite(target.x) && Number.isFinite(target.y)
        ? { x: Math.max(-1, Math.min(1, target.x)), y: Math.max(-1, Math.min(1, target.y)) }
        : null;
    },

    setZoom(z) {
      views.setZoom(z);
    },

    setStyle(next) {
      if (!STYLES.includes(next)) return;
      style = next;
      root.dataset.style = next;
      hologram.setStyle(next);
      scene.setSolidLighting(next === "solid");
      particles.setVisible(next === "hologram");
      renderDebug();
    },

    toggleCalibration() {
      highlight.toggleCalibration();
    },

    handleCalibrationKey(e) {
      return highlight.handleKey(e);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      scene.stopLoop();
      timeline.stop();
      teardown();
      root.remove();
    },

    get style() { return style; },
    get view() { return view; },
    get speed() { return timeline.speed; },
    get cueId() { return cueId; },
  };

  // Ready
  scene.setSolidLighting(style === "solid");
  hologram.materialize(SWING_MS);
  loading.remove();
  syncButtons();
  renderDebug();

  scene.startLoop((dt) => {
    if (pendingSize) {
      scene.setSize(pendingSize.w, pendingSize.h);
      hologram.setSize(pendingSize.w, pendingSize.h);
      pendingSize = null;
    }
    const step = Math.min(dt, 100);
    const scaled = step * timeline.speed;
    timeline.update(step);
    driver.update(step);
    if (look || Math.abs(lookNow.x) > 1e-3 || Math.abs(lookNow.y) > 1e-3) {
      const goal = look ?? { x: 0, y: 0 };
      const k = Math.min(1, LOOK.ease * (step / 16.7));
      lookNow.x += (goal.x - lookNow.x) * k;
      lookNow.y += (goal.y - lookNow.y) * k;
      if (headRest) {
        // Override the driver's head pose for this frame; +y rotation turns toward world +x, the viewer's right.
        driver.headBone.rotation.copy(headRest);
        driver.headBone.rotation.y += lookNow.x * LOOK.yaw;
        driver.headBone.rotation.x -= lookNow.y * LOOK.pitch;
      }
    }
    views.update(scaled);
    highlight.update(scaled);
    hologram.setHold(highlight.pulseValue);
    hologram.update(scaled);
    particles.update(scaled);
    hologram.render();
  });

  setTimeout(() => {
    if (!disposed) container.dispatchEvent(new CustomEvent("demo:ready", { bubbles: true, detail: { driver: driver.name } }));
  }, 0);

  return demo;
}
