import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./styles.css";

import { createScene } from "./scene.js";
import { createViews } from "./views.js";
import { computeMouthAnchor } from "./mouth-anchor.js";
import { createHighlight } from "./highlight.js";
import { createHologram } from "./hologram.js";
import { createParticles } from "./particles.js";
import { createPointCloud } from "./pointcloud.js";
import { createTalkingHeadDriver } from "./drivers/talkinghead.js";
import { createThreeDriver } from "./drivers/three.js";
import { CUES } from "./cues.js";
import { createTimeline, easeInOutCubic } from "./timeline.js";
import { createCutaway, BLEND_POSES } from "./cutaway.js";
import { createLipSync } from "./lipsync.js";

const DEFAULT_AVATAR = "/avatars/brunette.glb";
const TH_TIMEOUT_MS = 10000;
const SWING_MS = 1200;
// Looking at the learner: the eyes do most of the work and the head follows a little,
// the way a person tracks someone close by. Radians (head) and blend-shape weight (eyes)
// at full deflection; `ease` is the per-frame lerp toward the target.
const LOOK = { yaw: 0.14, pitch: 0.09, ease: 0.07 };
// `rest` is a slight downward cast (the model's neutral pose has eyesLookDown 0.1); without
// it the eyes sit noticeably high whenever the look target is level.
const GAZE = { yaw: 0.8, pitch: 0.4, rest: -0.12 };
const GAZE_SHAPES = ["eyeLookOutLeft", "eyeLookInLeft", "eyeLookOutRight", "eyeLookInRight", "eyesLookUp", "eyesLookDown"];
const NOTE = "Mouth demonstrations are illustrative and would be reviewed by speech therapists before real use.";
// Start picture from an image (setStartShapeFromImage): the image is read at most maxPx wide; its pixels darker
// than `threshold` (luminance after compositing over `paper`) become samples on a jittered grid `spacing` CSS px
// apart, each with its tone (`black` is the luminance that counts as fully dark). The particle head then spreads
// all its dots over the samples, darker ones carrying more.
const SHAPE_IMG = { maxPx: 512, spacing: 1.6, threshold: 0.55, black: 0.08, paper: [250, 249, 246] };
const DRIVERS = ["auto", "talkinghead", "three"];
const STYLES = ["hologram", "particles", "porcelain", "hybrid", "solid"];

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
    startDispersed: options.startDispersed === true,
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
  const S = { w: 0, vis: 0, show: 0, ab: 0, mk: 0 }; // w: face toward cue target, vis: highlight, show: cutaway opacity, ab: pose A to B progress, mk: contact marker strength
  let view = "front";
  let cueId = null;
  let cue = null;
  let driven = null; // cue whose shapes are currently overriding the face
  let driver = null;
  let scene = null;
  let hologram = null;
  let particles = null;
  let cloud = null;
  let highlight = null;
  let views = null;
  let cutaway = null;
  let style = opts.style;
  let look = null; // { x, y } in [-1, 1], +x = viewer's right, +y = up; null releases the head
  const lookNow = { x: 0, y: 0 };
  let headRest = null;
  let gazing = false; // eye shapes are being driven by the look target

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
    views.setAnchor(driver.headBone, anchor.headLocal, { sideShift: anchor.sideShift, headDepth: anchor.headDepth, headHeight: anchor.headHeight });
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
    particles.setVisible(style === "hologram" || style === "particles");
    disposers.push(() => particles.dispose());

    // The particle head: a sibling of the hologram style, sampled from the same meshes.
    cloud = createPointCloud({
      renderer: scene.renderer, scene: scene.scene, camera: scene.camera, canvas: scene.canvas,
      root: driver.root, anchor, reducedMotion: mq.matches, startDispersed: opts.startDispersed,
    });
    disposers.push(() => cloud.dispose());
    if (style === "particles") cloud.setActive(true);
    if (params.debug) window.__mouthDemo = { scene, driver, anchor, highlight, views, hologram, particles };

    const onMotion = (e) => {
      views.setReducedMotion(e.matches);
      hologram.setReducedMotion(e.matches);
      particles.setReducedMotion(e.matches);
      cloud.setReducedMotion(e.matches);
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
  const BLEND_KEY = Object.fromEntries(Object.entries(BLEND_POSES).map(([k, pose]) => [pose, k]));
  // Every blend shape a cue writes: shapes, plus thenShapes for two-pose cues that move the face too.
  const shapeNameCache = new WeakMap();
  const cueShapeNames = (c) => {
    let names = shapeNameCache.get(c);
    if (!names) {
      names = [...new Set([...Object.keys(c.shapes), ...Object.keys(c.thenShapes ?? {})])];
      shapeNameCache.set(c, names);
    }
    return names;
  };
  const showTarget = () => (view === "side" ? 1 : 0);

  const emit = (phase) => {
    container.dispatchEvent(new CustomEvent("cue:phase", { bubbles: true, detail: { cueId, phase } }));
  };

  const paint = (c) => {
    if (c) {
      driven = c;
      if (c.thenShapes) {
        // two-pose cue: the face glides from shapes to thenShapes together with the cutaway (S.ab)
        for (const name of cueShapeNames(c)) {
          const v = (c.shapes[name] ?? 0) * (1 - S.ab) + (c.thenShapes[name] ?? 0) * S.ab;
          driver.setShape(name, v * S.w);
        }
      } else {
        for (const [name, value] of Object.entries(c.shapes)) driver.setShape(name, value * S.w);
      }
      if (view === "side" || S.show > 0) {
        if (c.then) {
          // two-pose cue: neutral -> A, then A -> B, through the weighted blend
          cutaway.setBlend({ [BLEND_KEY[c.cutawayPose]]: (1 - S.ab) * S.w, [BLEND_KEY[c.then]]: S.ab * S.w });
        } else {
          cutaway.setPose("neutral", c.cutawayPose, S.w);
        }
        if (c.marker) cutaway.setMarker(c.marker, S.mk);
      }
    }
    highlight.setVisibility(S.vis);
    cutaway.show(S.show);
  };

  const release = (c) => {
    if (!c) return;
    driver.releaseShapes(cueShapeNames(c));
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
    tween("in", 600, { w: 1, vis: 1, show: showTarget() }, c, { onStart: () => { S.ab = 0; hologram.triggerRipple(); } }),
    tween("hold", 2000, null, c, { onStart: pulseOn, onEnd: pulseOff }),
    tween("out", 600, { w: 0, vis: 0 }, c),
    tween("rest", 1500, null, c),
  ];

  // Marker and label for the side view. The marker shows only while pose A is held.
  const markOff = () => {
    S.mk = 0;
    cutaway.setMarker(null, 0);
  };
  const markOn = (c) => {
    S.mk = c.marker ? 1 : 0;
    cutaway.setMarker(c.marker ?? null, S.mk);
  };
  const labelA = (c) => c.labels?.[0] ?? c.label ?? null;
  const labelB = (c) => c.labels?.[1] ?? c.label ?? null;
  const sideStart = (c) => {
    S.ab = 0;
    markOff();
    cutaway.setCueLabel(labelA(c));
  };

  // Single pose: in 600 + hold 2500 (3100 ms active). Two poses: in 500, hold A 1000, glide 600, hold B 600 (2700 ms active).
  const sideLoop = (c) => {
    const onHold = () => { pulseOn(); cutaway.setHighlight(1); markOn(c); };
    const tail = [
      tween("relax", 600, { w: 0, vis: 0 }, c, { onStart: () => { cutaway.setHighlight(0); markOff(); } }),
      tween("rest", 1500, null, c),
    ];
    if (c.then) {
      return [
        tween("in", 500, { w: 1, vis: 1, show: 1 }, c, { onStart: () => sideStart(c) }),
        tween("hold", 1000, null, c, { onStart: onHold }),
        tween("glide", 600, { ab: 1, mk: 0 }, c, { onStart: () => cutaway.setCueLabel(labelB(c)) }),
        tween("hold2", 600, null, c, { onEnd: pulseOff }),
        ...tail,
      ];
    }
    return [
      tween("in", 600, { w: 1, vis: 1, show: 1 }, c, { onStart: () => sideStart(c) }),
      tween("hold", 2500, null, c, { onStart: onHold, onEnd: () => { pulseOff(); markOff(); } }),
      ...tail,
    ];
  };

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
    markOff();
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

  // Lip sync. A cue owns the mouth: while a cue is chosen (cue) or its shapes are still visibly easing
  // out (driven, S.w above 0.02), speech keeps its clock and events but writes no shapes, then eases in
  // from rest. In the last sliver of an ease-out lip sync writes after paint() in the frame, so it wins.
  const cueOwnsFace = () => cue !== null || (driven !== null && S.w > 0.02);
  const emitSpeech = (type) => container.dispatchEvent(new CustomEvent(type, { bubbles: true }));
  const lipsync = createLipSync({ driver, isBlocked: cueOwnsFace, emit: emitSpeech });
  disposers.push(() => lipsync.dispose());

  // Start picture: an image's dark pixels, laid out in a box on the canvas, become the dots' starting shape.
  const shapeImages = new Map(); // src -> Promise<{ w, h, data }>
  let shapeToken = 0;
  const loadShapeImage = (src) => {
    let p = shapeImages.get(src);
    if (!p) {
      p = new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`start shape image did not load: ${src}`));
        img.src = src;
      }).then((img) => {
        const iw = img.naturalWidth || img.width;
        const ih = img.naturalHeight || img.height;
        const w = Math.max(1, Math.min(SHAPE_IMG.maxPx, iw));
        const h = Math.max(1, Math.round((w * ih) / iw));
        const cv = document.createElement("canvas");
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        return { w, h, data: ctx.getImageData(0, 0, w, h).data };
      });
      p.catch(() => shapeImages.delete(src));
      shapeImages.set(src, p);
    }
    return p;
  };

  const shapeFromImage = async ({ src, box, fit = "fill", spacing = SHAPE_IMG.spacing, threshold = SHAPE_IMG.threshold } = {}) => {
    if (disposed || !src || !box) return false;
    const token = ++shapeToken;
    let img;
    try {
      img = await loadShapeImage(src);
    } catch (err) {
      console.warn("[mouth-demo]", err?.message ?? err);
      return false;
    }
    if (disposed || token !== shapeToken) return false; // a newer call (resize) wins
    const hw = host.clientWidth;
    const hh = host.clientHeight;
    const bw = +box.width;
    const bh = +box.height;
    if (!(hw > 0 && hh > 0 && bw > 0 && bh > 0)) return false;
    // where the image lands inside the box (like CSS object-fit, centred)
    let kx = bw / img.w;
    let ky = bh / img.h;
    if (fit === "cover") kx = ky = Math.max(kx, ky);
    else if (fit === "contain") kx = ky = Math.min(kx, ky);
    const ox = (bw - img.w * kx) / 2;
    const oy = (bh - img.h * ky) / 2;
    // the picture lies on the plane through the orbit target, facing the camera, in camera space
    const cam = scene.camera;
    cam.updateMatrixWorld();
    const m = cam.matrixWorldInverse.elements;
    const t = scene.controls.target;
    const d = Math.max(0.05, -(m[2] * t.x + m[6] * t.y + m[10] * t.z + m[14]));
    const tanH = Math.tan(((cam.fov || 30) * Math.PI) / 360);
    const aspect = hw / hh;
    const mPerPx = (2 * d * tanH) / hh;
    const step = Math.max(1, +spacing || SHAPE_IMG.spacing);
    const T = Math.min(0.99, Math.max(0.01, +threshold || SHAPE_IMG.threshold));
    const [pr, pg, pb] = SHAPE_IMG.paper;
    const paperLum = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
    const data = img.data;
    const pts = [];
    const tone = [];
    for (let y = 0; y < bh; y += step) {
      for (let x = 0; x < bw; x += step) {
        const px = x + Math.random() * step;
        const py = y + Math.random() * step;
        if (px >= bw || py >= bh) continue;
        const ix = Math.floor((px - ox) / kx);
        const iy = Math.floor((py - oy) / ky);
        if (ix < 0 || iy < 0 || ix >= img.w || iy >= img.h) continue;
        const i = (iy * img.w + ix) * 4;
        const a = data[i + 3] / 255;
        const lum = (a * (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) + (1 - a) * paperLum) / 255;
        if (lum >= T) continue;
        const v = Math.min(1, (T - lum) / Math.max(0.05, T - SHAPE_IMG.black));
        const nx = ((box.x + px) / hw) * 2 - 1;
        const ny = 1 - ((box.y + py) / hh) * 2;
        pts.push(nx * tanH * aspect * d, ny * tanH * d, -d);
        tone.push(v);
      }
    }
    if (!pts.length) return false;
    return cloud.setStartShape({
      points: new Float32Array(pts),
      shade: new Float32Array(tone),
      jitter: step * mPerPx,
      area: (pts.length / 3) * (step * mPerPx) ** 2,
    });
  };

  // Stage backdrop: the gradient, washed toward a flat colour (eased in the frame loop).
  const backdrop = { color: null, amount: 0, target: 0, rate: 0 };
  const stepBackdrop = (dt) => {
    if (backdrop.amount === backdrop.target) return;
    const d = dt * backdrop.rate;
    backdrop.amount = backdrop.target > backdrop.amount
      ? Math.min(backdrop.target, backdrop.amount + d)
      : Math.max(backdrop.target, backdrop.amount - d);
    scene.setBackdrop(backdrop.color, backdrop.amount);
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
      cutaway.setCueLabel(null);
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
      // `view` changes before the swing starts, so a stop() in between can leave the camera behind: check both.
      if (next === view && views.view === next) return Promise.resolve(true);
      view = next;
      root.dataset.view = next;
      syncButtons();
      const dir = next === "side" ? 1 : -1;
      const pre = prefix(cue);
      let finished;
      const done = new Promise((resolve) => { finished = resolve; });
      const hooks = swingHooks(dir, {
        onStart: () => {
          if (next === "side") { if (cue) sideStart(cue); } else { cutaway.setCueLabel(null); markOff(); }
        },
        onEnd: () => finished(true),
      });
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
      cutaway.setCueLabel(null);
      // A swing that was queued but never started (stop() replaced it) still has to happen.
      const hooks = views.view !== view ? swingHooks(view === "side" ? 1 : -1) : {};
      run([tween("reset", 300, { w: 0, vis: 0, show: showTarget() }, d, hooks)]);
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

    // Freeze everything (face, camera, effects, choreography clock) without losing state.
    pause() {
      if (!disposed) scene.stopLoop();
    },

    resume() {
      if (!disposed) scene.startLoop(frame);
    },

    setStyle(next) {
      if (!STYLES.includes(next)) return;
      style = next;
      root.dataset.style = next;
      if (next === "particles") {
        hologram.setStyle("solid"); // restores the meshes; the cloud then hides them behind its depth prepass
        cloud.setActive(true);
      } else {
        cloud.setActive(false);
        hologram.setStyle(next);
      }
      scene.setSolidLighting(next === "solid");
      particles.setVisible(next === "hologram" || next === "particles");
      renderDebug();
    },

    speak(opts = {}) {
      return lipsync.speak(opts);
    },

    // Intro / outro for the particle head: dots fly in and build the face, or dissolve away.
    // Other styles are not animated; the call settles the state and resolves at once.
    assemble(o) {
      return cloud.assemble(o);
    },

    disperse(o) {
      return cloud.disperse(o);
    },

    // Particles style: while dispersed the dots draw this picture, and assemble() morphs it into the head.
    // shape: { points (camera-space xyz), shade?, jitter?, area?, dotRadius? } or null for the default fly-in.
    setStartShape(shape) {
      if (!shape) shapeToken++; // drop an image still loading
      return cloud.setStartShape(shape ?? null);
    },

    // The same, from an image laid out in `box` (CSS px relative to the canvas host).
    setStartShapeFromImage(o) {
      return shapeFromImage(o);
    },

    // Wash the stage backdrop toward a flat colour (null returns to the gradient).
    setBackdrop(color, o = {}) {
      if (disposed) return;
      if (color) backdrop.color = color;
      backdrop.target = color ? 1 : 0;
      const dur = Math.max(0, +o.durationMs || 0);
      if (dur > 0) {
        backdrop.rate = 1 / dur;
      } else if (backdrop.amount !== backdrop.target) {
        backdrop.amount = backdrop.target;
        scene.setBackdrop(backdrop.color, backdrop.amount);
      }
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
    get speaking() { return lipsync.speaking; },
    get assembly() { return cloud.assembly; },
    get assembled() { return cloud.assembly === "assembled"; },
    get hasStartShape() { return cloud.hasStartShape; },
  };

  if (params.debug) {
    // DevTools: __mouthDemo.disperse() / .assemble() / .assembly; the public object is __mouthDemo.demo
    Object.assign(window.__mouthDemo, {
      demo,
      cloud,
      assemble: (o) => demo.assemble(o),
      disperse: (o) => demo.disperse(o),
    });
    Object.defineProperty(window.__mouthDemo, "assembly", { get: () => demo.assembly, configurable: true });
  }

  // Ready
  scene.setSolidLighting(style === "solid");
  hologram.materialize(SWING_MS);
  loading.remove();
  syncButtons();
  renderDebug();

  // One frame of the demo; also the resume target for pause()/resume().
  function frame(dt) {
    if (pendingSize) {
      scene.setSize(pendingSize.w, pendingSize.h);
      hologram.setSize(pendingSize.w, pendingSize.h);
      pendingSize = null;
    }
    const step = Math.min(dt, 100);
    const scaled = step * timeline.speed;
    stepBackdrop(step);
    timeline.update(step);
    lipsync.update(step);
    // The side diagram follows the lip sync whenever no cue owns the face; otherwise paint()'s setPose
    // (run earlier this frame by timeline.update) holds it. With no speech the pose is all zero (neutral).
    if (!cueOwnsFace() && (view === "side" || S.show > 0)) cutaway.setBlend(lipsync.pose());
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
      // Eyes: ARKit look shapes. A positive yaw is the viewer's right, which is the avatar's
      // left eye looking out and the right eye looking in.
      const ey = lookNow.x * GAZE.yaw;
      const ex = lookNow.y * GAZE.pitch + GAZE.rest;
      driver.setShape("eyeLookOutLeft", Math.max(0, ey));
      driver.setShape("eyeLookInRight", Math.max(0, ey));
      driver.setShape("eyeLookInLeft", Math.max(0, -ey));
      driver.setShape("eyeLookOutRight", Math.max(0, -ey));
      driver.setShape("eyesLookUp", Math.max(0, ex));
      driver.setShape("eyesLookDown", Math.max(0, -ex));
      gazing = true;
    } else if (gazing) {
      gazing = false;
      driver.releaseShapes(GAZE_SHAPES);
    }
    views.update(scaled);
    highlight.update(scaled);
    hologram.setHold(highlight.pulseValue);
    cloud.setHold(highlight.pulseValue);
    hologram.update(scaled);
    cloud.update(step);
    particles.update(scaled);
    hologram.render();
  }
  scene.startLoop(frame);

  setTimeout(() => {
    if (!disposed) container.dispatchEvent(new CustomEvent("demo:ready", { bubbles: true, detail: { driver: driver.name } }));
  }, 0);

  return demo;
}
