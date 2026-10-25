import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./styles.css";

import { createScene, PIXEL_RATIO_CAP } from "./scene.js";
import { createViews } from "./views.js";
import { computeMouthAnchor } from "./mouth-anchor.js";
import { createHighlight } from "./highlight.js";
import { createHologram } from "./hologram.js";
import { createParticles } from "./particles.js";
import { createPointCloud, LIGHT_DOTS } from "./pointcloud.js";
import { createTalkingHeadDriver } from "./drivers/talkinghead.js";
import { createThreeDriver } from "./drivers/three.js";
import { CUES } from "./cues.js";
import { createTimeline, easeInOutCubic } from "./timeline.js";
import { createCutaway } from "./cutaway.js";
import { createLipSync } from "./lipsync.js";
import { TIERS, createFpsMonitor, urlParams } from "./quality.js";

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
// Runtime quality ladder (see quality.js). The frame-rate monitor steps down one rung at a time and back up at
// most one rung after a step down. `dots` is the share of the full tier's dots, `stride` the deformer's frame stride.
const LEVELS = [
  { id: "full", tier: "full", dpr: PIXEL_RATIO_CAP.full, dots: 1, scatter: true, stride: 1 },
  { id: "full-dpr", tier: "full", dpr: PIXEL_RATIO_CAP.light, dots: 1, scatter: true, stride: 1 },
  { id: "full-dots", tier: "full", dpr: PIXEL_RATIO_CAP.light, dots: 0.5, scatter: true, stride: 1 },
  { id: "light", tier: "light", dpr: PIXEL_RATIO_CAP.light, dots: LIGHT_DOTS, scatter: false, stride: 2 },
  { id: "simple", tier: "simple" },
];
const LEVEL_OF = { full: 0, light: 3, simple: 4 };
const SIMPLE = 4;

// Stand-ins while there is no 3D stack (the simple tier, or before it is built): every call is a no-op.
const NOOP = () => {};
const STUB_DRIVER = { name: "none", setShape: NOOP, releaseShapes: NOOP, update: NOOP, dispose: NOOP };
const STUB_HIGHLIGHT = { pulseValue: 0, setVisibility: NOOP, setPulse: NOOP, update: NOOP, toggleCalibration: NOOP, handleKey: () => false };
const STUB_HOLOGRAM = { triggerRipple: NOOP, setSwing: NOOP, setHold: NOOP, update: NOOP, render: NOOP, setStyle: NOOP, setReducedMotion: NOOP, setSize: NOOP };
const STUB_PARTICLES = { setSwing: NOOP, update: NOOP, setVisible: NOOP, setReducedMotion: NOOP, setPixelRatio: NOOP };
const STUB_VIEWS = { setView: NOOP, setZoom: NOOP, update: NOOP, setReducedMotion: NOOP };
// The head's intro / outro settle at once without a point cloud.
function createStubCloud(startDispersed) {
  let state = startDispersed ? "dispersed" : "assembled";
  return {
    active: false,
    buildShare: 1,
    get assembly() { return state; },
    assemble() { state = "assembled"; return Promise.resolve(true); },
    disperse() { state = "dispersed"; return Promise.resolve(true); },
    setStartShape: () => false,
    hasStartShape: false,
    setHold: NOOP, update: NOOP, setActive: NOOP, setReducedMotion: NOOP,
    setDotFraction: NOOP, setScatterEnabled: NOOP, setDeformerStride: NOOP,
  };
}

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
    ...qualityParams(),
  };
}

// `?quality=` and `?fpsdebug[=fps]` also work inside a hash route (`#/lesson?quality=simple`).
function qualityParams() {
  const u = urlParams();
  const quality = TIERS.includes(u.get("quality")) ? u.get("quality") : null;
  const fpsdebug = u.has("fpsdebug");
  const forced = Number.parseFloat(u.get("fpsdebug") ?? "");
  return { quality, fpsdebug, fakeFps: fpsdebug && forced > 0 ? forced : null };
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
    quality: params.quality ?? (TIERS.includes(options.quality) ? options.quality : "full"),
    // false pins the tier: the frame-rate monitor does not step it (a user's explicit choice)
    adaptive: options.adaptive !== false,
    qualityReason: typeof options.qualityReason === "string" ? options.qualityReason : params.quality ? "url" : "initial",
    posterUrl: typeof options.posterUrl === "string" ? options.posterUrl : null,
    onQualityChange: typeof options.onQualityChange === "function" ? options.onQualityChange : null,
  };

  // DOM
  const root = el("div", "md-root");
  root.dataset.view = "front";
  root.dataset.style = opts.style;
  const stage = el("div", "md-stage");
  const host = el("div", "md-canvas-host");
  stage.append(host);
  // Simple tier: a still picture stands in for the 3D head (its src is set the first time it is shown).
  const poster = el("img", "md-poster");
  poster.alt = "";
  poster.setAttribute("aria-hidden", "true");
  poster.decoding = "async";
  host.append(poster);
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
  if (params.debug || params.fpsdebug) {
    debugEl = el("div", "md-debug");
    root.append(debugEl);
  }
  container.append(root);

  // Teardown registry (run in reverse creation order)
  const disposers = [];
  let disposed = false;
  const runAll = (list) => {
    while (list.length) {
      try { list.pop()(); } catch (err) { console.warn("[mouth-demo] dispose step failed:", err); }
    }
  };
  const teardown = () => runAll(disposers);

  const timeline = createTimeline();
  const S = { w: 0, vis: 0, show: 0 }; // w: face toward cue target, vis: highlight, show: cutaway opacity
  let view = "front";
  let cueId = null;
  let cue = null;
  let driven = null; // cue whose shapes are currently overriding the face
  // The 3D stack. Until it is built (and in the simple tier, never) these are the no-op stand-ins above.
  let has3D = false;
  let driver = STUB_DRIVER;
  let scene = null;
  let hologram = STUB_HOLOGRAM;
  let particles = STUB_PARTICLES;
  let cloud = createStubCloud(opts.startDispersed);
  let highlight = STUB_HIGHLIGHT;
  let views = STUB_VIEWS;
  let anchor = null;
  let cutaway = null;
  let style = opts.style;
  let look = null; // { x, y } in [-1, 1], +x = viewer's right, +y = up; null releases the head
  const lookNow = { x: 0, y: 0 };
  let headRest = null;
  let gazing = false; // eye shapes are being driven by the look target
  let zoom = 1;
  let level = LEVEL_OF[opts.quality];
  const disposers3D = [];

  const renderDebug = () => {
    if (!debugEl) return;
    const q = `quality: ${LEVELS[level].id}${monitor ? ` | fps ${monitor.fps.toFixed(1)}` : ""}`;
    debugEl.textContent = params.debug ? `driver: ${driver?.name ?? "-"} | style: ${style} | ${q} | ${NOTE}` : q;
  };

  // Size recorded by the ResizeObserver, applied at the start of the next frame
  // so the drawing buffer is never cleared after that frame has rendered.
  let pendingSize = null;
  let lastSize = null;

  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  const measure = () => {
    const w = Math.floor(host.clientWidth);
    const h = Math.floor(host.clientHeight);
    if (w < 1 || h < 1) return null;
    return { w, h };
  };

  /** Build the 3D stack (renderer, avatar, effects, point cloud) for `tier`. Leaves nothing behind if it fails. */
  async function build3D(tier) {
    const local = [];
    try {
      const sc = createScene(host, { pixelRatioCap: tier === "light" ? PIXEL_RATIO_CAP.light : PIXEL_RATIO_CAP.full });
      local.push(() => sc.dispose());
      sc.setSolidLighting(style === "solid");

      const drv = await selectDriver(opts.driver, {
        host, scene: sc.scene, camera: sc.camera, url: opts.avatarUrl, thfail: params.thfail,
      });
      local.push(() => drv.dispose());
      if (disposed) throw new Error("disposed while loading");

      const rest = drv.headBone.rotation.clone();
      const anc = computeMouthAnchor(drv);
      const hl = createHighlight({ headBone: drv.headBone, camera: sc.camera, anchor: anc });
      if (!hl.mesh.parent) drv.headBone.add(hl.mesh);
      local.push(() => hl.dispose());

      const vw = createViews({ camera: sc.camera, controls: sc.controls, canvas: sc.canvas });
      vw.setAnchor(drv.headBone, anc.headLocal);
      vw.snap();
      local.push(() => vw.dispose());

      const holo = createHologram({
        renderer: sc.renderer, scene: sc.scene, camera: sc.camera,
        root: drv.root, style, reducedMotion: mq.matches,
      });
      holo.setMouth(anc.restCenter, anc.radius);
      local.push(() => holo.dispose());

      const parts = createParticles({ camera: sc.camera, reducedMotion: mq.matches });
      if (!parts.points.parent) sc.scene.add(parts.points);
      parts.setVisible(style === "hologram" || style === "particles");
      parts.setPixelRatio(sc.renderer.getPixelRatio());
      local.push(() => parts.dispose());

      // The particle head: a sibling of the hologram style, sampled from the same meshes.
      const pc = createPointCloud({
        renderer: sc.renderer, scene: sc.scene, camera: sc.camera, canvas: sc.canvas,
        root: drv.root, anchor: anc, reducedMotion: mq.matches,
        startDispersed: cloud.assembly === "dispersed" || cloud.assembly === "dispersing",
        quality: tier === "light" ? "light" : "full",
      });
      // once committed, the current cloud (it may be rebuilt for another tier); before that, this one
      local.push(() => (has3D ? cloud : pc).dispose());

      // commit
      scene = sc;
      driver = drv;
      headRest = rest;
      anchor = anc;
      highlight = hl;
      views = vw;
      hologram = holo;
      particles = parts;
      cloud = pc;
      has3D = true;
      disposers3D.push(...local);
      local.length = 0;

      views.setReducedMotion(mq.matches);
      views.setZoom(zoom);
      if (view === "side") views.setView("side", { animate: false });
      if (style === "particles") cloud.setActive(true);
      scene.setBackdrop(backdrop.color, backdrop.amount);
      const size = lastSize ?? measure();
      if (size) {
        scene.setSize(size.w, size.h);
        hologram.setSize(size.w, size.h);
        lastSize = size;
      }
      scene.setSolidLighting(style === "solid");
      hologram.materialize(SWING_MS);
      if (params.debug) {
        window.__mouthDemo = Object.assign(window.__mouthDemo ?? {}, { scene, driver, anchor, highlight, views, hologram, particles, cloud });
      }
      renderDebug();
    } catch (err) {
      runAll(local);
      throw err;
    }
  }

  /** A new point cloud for `tier` (a light build has too few dots for the full tier). Keeps the assembly state. */
  function rebuildCloud(tier) {
    const away = cloud.assembly === "dispersed" || cloud.assembly === "dispersing";
    cloud.dispose();
    cloud = createPointCloud({
      renderer: scene.renderer, scene: scene.scene, camera: scene.camera, canvas: scene.canvas,
      root: driver.root, anchor, reducedMotion: mq.matches, startDispersed: away,
      quality: tier === "light" ? "light" : "full",
    });
    if (params.debug && window.__mouthDemo) window.__mouthDemo.cloud = cloud;
  }

  let backdrop = null; // defined with the choreography below; build3D only runs after it exists
  let monitor = null;

  try {
    cutaway = createCutaway(stage);
    disposers.push(() => cutaway.dispose());
    disposers.push(() => runAll(disposers3D));

    const onMotion = (e) => {
      views.setReducedMotion(e.matches);
      hologram.setReducedMotion(e.matches);
      particles.setReducedMotion(e.matches);
      cloud.setReducedMotion(e.matches);
    };
    mq.addEventListener("change", onMotion);
    disposers.push(() => mq.removeEventListener("change", onMotion));

    const ro = new ResizeObserver(() => {
      const size = measure();
      if (size) pendingSize = size;
    });
    ro.observe(host);
    disposers.push(() => ro.disconnect());
    lastSize = measure();
  } catch (err) {
    console.error("[mouth-demo] failed to start:", err);
    loading.textContent = "The mouth demonstration could not load.";
    loading.setAttribute("role", "alert");
    loading.classList.add("md-loading--error");
    teardown();
    throw err;
  }

  // Choreography
  // The simple tier has no face, so the 2D cutaway is always on stage and runs the side-view loop (its highlight).
  const diagramOn = () => view === "side" || level === SIMPLE;
  const showTarget = () => (diagramOn() ? 1 : 0);

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
    const loop = diagramOn() ? sideLoop(cue) : frontLoop(cue);
    run([...pre, ...loop], { loop: true, loopStart: pre.length });
  };

  // Lip sync. A cue owns the mouth: while a cue is chosen (cue) or its shapes are still visibly easing
  // out (driven, S.w above 0.02), speech keeps its clock and events but writes no shapes, then eases in
  // from rest. In the last sliver of an ease-out lip sync writes after paint() in the frame, so it wins.
  const cueOwnsFace = () => cue !== null || (driven !== null && S.w > 0.02);
  const emitSpeech = (type) => container.dispatchEvent(new CustomEvent(type, { bubbles: true }));
  // Through a proxy: the driver is a stand-in until the 3D stack is built (lip sync drives the cutaway regardless).
  const driverProxy = {
    setShape: (name, value) => driver.setShape(name, value),
    releaseShapes: (names) => driver.releaseShapes(names),
  };
  const lipsync = createLipSync({ driver: driverProxy, isBlocked: cueOwnsFace, emit: emitSpeech });
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
    if (disposed || !src || !box || !has3D || level === SIMPLE) return false;
    const token = ++shapeToken;
    let img;
    try {
      img = await loadShapeImage(src);
    } catch (err) {
      console.warn("[mouth-demo]", err?.message ?? err);
      return false;
    }
    if (disposed || token !== shapeToken || !has3D || level === SIMPLE) return false; // a newer call (resize) wins
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
  backdrop = { color: null, amount: 0, target: 0, rate: 0 };
  const stepBackdrop = (dt) => {
    if (backdrop.amount === backdrop.target) return;
    const d = dt * backdrop.rate;
    backdrop.amount = backdrop.target > backdrop.amount
      ? Math.min(backdrop.target, backdrop.amount + d)
      : Math.max(backdrop.target, backdrop.amount - d);
    if (has3D) scene.setBackdrop(backdrop.color, backdrop.amount);
  };

  // ---- quality ----
  let paused = false;
  let raf = 0;
  let lastT = 0;
  const startLoop = () => {
    stopLoop();
    lastT = 0;
    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      const dt = lastT ? Math.min(100, Math.max(0, now - lastT)) : 0;
      lastT = now;
      frame(dt, now);
    };
    raf = requestAnimationFrame(tick);
  };
  const stopLoop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  let adaptive = opts.adaptive;
  let baseLevel = level; // the monitor never climbs above the tier it was given
  let canStepUp = false; // one step back up, and only right after a step down
  let changing = Promise.resolve();

  const emitQuality = (reason, fps = null) => {
    const L = LEVELS[level];
    const detail = { tier: L.tier, level: L.id, fps: fps == null ? null : Math.round(fps * 10) / 10, reason, adaptive };
    container.dispatchEvent(new CustomEvent("quality:change", { bubbles: true, detail }));
    try { opts.onQualityChange?.(detail); } catch (err) { console.warn("[mouth-demo] onQualityChange failed:", err); }
  };

  /** Apply a rung of the ladder to the live stack (the 3D stack exists unless the rung is simple). */
  const applyLevel = (next) => {
    const wasDiagram = diagramOn();
    level = next;
    const L = LEVELS[level];
    root.dataset.quality = L.tier;
    if (has3D) scene.canvas.style.display = level === SIMPLE ? "none" : "block"; // scene.js sets it inline
    if (level === SIMPLE) {
      // Park the 3D stack: not drawn or updated. Turning the cloud off ends any intro / outro at once.
      if (opts.posterUrl && !poster.getAttribute("src")) poster.src = opts.posterUrl;
      if (has3D) cloud.setActive(false);
    } else {
      cloud.setActive(style === "particles");
      scene.setPixelRatioCap(L.dpr);
      particles.setPixelRatio(scene.renderer.getPixelRatio());
      const size = lastSize ?? measure();
      if (size) hologram.setSize(size.w, size.h);
      cloud.setDotFraction(Math.min(1, L.dots / cloud.buildShare));
      cloud.setScatterEnabled(L.scatter);
      cloud.setDeformerStride(L.stride);
      scene.setBackdrop(backdrop.color, backdrop.amount);
    }
    if (wasDiagram !== diagramOn()) {
      S.show = showTarget();
      cutaway.show(S.show);
      if (cue) startCueLoop(false);
    }
    monitor?.reset();
    renderDebug();
  };

  /**
   * Move to rung `next`, building the 3D stack if it is missing. `rebuild` (an explicit choice) also replaces a
   * light-built point cloud when the full tier is asked for. Serialised: changes apply in the order asked.
   */
  const changeLevel = (next, { reason, fps = null, rebuild = false } = {}) => {
    changing = changing.then(async () => {
      if (disposed) return;
      let target = Math.max(0, Math.min(SIMPLE, next));
      let why = reason;
      if (target !== SIMPLE) {
        if (!has3D) {
          try {
            await build3D(LEVELS[target].tier);
          } catch (err) {
            if (disposed) return;
            console.warn("[mouth-demo] the 3D guide could not load; staying on the simple view:", err?.message ?? err);
            target = SIMPLE;
            why = "3d-failed";
          }
        } else if (rebuild && cloud.buildShare < LEVELS[target].dots) {
          rebuildCloud(LEVELS[target].tier);
        }
      }
      if (disposed) return;
      const changed = target !== level || why === "3d-failed";
      applyLevel(target);
      if (changed || reason === "user" || reason === "set") emitQuality(why, fps);
    });
    return changing;
  };

  monitor = createFpsMonitor({
    onDown: ({ fps, fallback }) => {
      if (!adaptive || level >= SIMPLE) return;
      canStepUp = !fallback;
      void changeLevel(level + 1, { reason: fallback ? "fps-fallback" : "fps-low", fps });
    },
    onUp: ({ fps }) => {
      if (!adaptive || !canStepUp || level <= baseLevel) return;
      canStepUp = false;
      void changeLevel(level - 1, { reason: "fps-high", fps });
    },
    onSample: () => { if (debugEl) renderDebug(); },
    fpsOverride: params.fakeFps ? () => params.fakeFps : null,
  });
  disposers.push(() => monitor.dispose());

  const demo = {
    get driverName() { return driver.name; },

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
      const loop = diagramOn() ? sideLoop(next) : frontLoop(next);
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
      if (level === SIMPLE) {
        // no camera to swing: the diagram is already on stage
        if (has3D) views.setView(next, { animate: false });
        if (cue) startCueLoop(false);
        return Promise.resolve(true);
      }
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
      zoom = z;
      views.setZoom(z);
    },

    // Freeze everything (face, camera, effects, choreography clock) without losing state.
    pause() {
      paused = true;
      if (!disposed) stopLoop();
    },

    resume() {
      paused = false;
      if (disposed) return;
      monitor.reset(); // the time spent paused is not a slow frame
      startLoop();
    },

    /**
     * Switch tier: "full" | "light" | "simple". `adaptive: false` pins it (the frame-rate monitor leaves it
     * alone); otherwise the monitor may step it down and back up one rung. Resolves once applied; the 3D stack
     * is built on the way up from simple (if that fails the demo stays simple, reason "3d-failed").
     */
    setQuality(tier, { adaptive: auto = true, reason = "set" } = {}) {
      if (!TIERS.includes(tier) || disposed) return Promise.resolve();
      adaptive = auto !== false;
      baseLevel = LEVEL_OF[tier];
      canStepUp = false;
      monitor.restart();
      return changeLevel(LEVEL_OF[tier], { reason, rebuild: true });
    },

    /** The tier being drawn now (after any automatic step). */
    getQuality() {
      return LEVELS[level].tier;
    },

    /** The rung within the tier: "full" | "full-dpr" | "full-dots" | "light" | "simple". */
    get qualityLevel() {
      return LEVELS[level].id;
    },

    setStyle(next) {
      if (!STYLES.includes(next)) return;
      style = next;
      root.dataset.style = next;
      if (next === "particles") {
        hologram.setStyle("solid"); // restores the meshes; the cloud then hides them behind its depth prepass
        cloud.setActive(level !== SIMPLE);
      } else {
        cloud.setActive(false);
        hologram.setStyle(next);
      }
      scene?.setSolidLighting(next === "solid");
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
        if (has3D) scene.setBackdrop(backdrop.color, backdrop.amount);
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
      stopLoop();
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

  // Build the 3D stack for the starting tier (the simple tier never builds it). A stack that cannot be built
  // (no WebGL, the avatar fails to load) leaves the lesson on the simple view instead of failing it.
  let startReason = opts.qualityReason;
  if (level !== SIMPLE) {
    try {
      await build3D(LEVELS[level].tier);
    } catch (err) {
      if (disposed) throw err;
      console.warn("[mouth-demo] the 3D guide could not load; using the simple view:", err?.message ?? err);
      level = SIMPLE;
      baseLevel = SIMPLE;
      startReason = "3d-failed";
    }
  }
  applyLevel(level);
  S.show = showTarget(); // the simple tier opens with the diagram on stage
  cutaway.show(S.show);

  if (params.debug) {
    // DevTools: __mouthDemo.disperse() / .assemble() / .assembly; the public object is __mouthDemo.demo
    window.__mouthDemo = window.__mouthDemo ?? {};
    Object.assign(window.__mouthDemo, {
      demo,
      cloud,
      assemble: (o) => demo.assemble(o),
      disperse: (o) => demo.disperse(o),
    });
    Object.defineProperty(window.__mouthDemo, "assembly", { get: () => demo.assembly, configurable: true });
  }
  if (params.fpsdebug) {
    // DevTools: __mouthQuality.level / .fps / .setQuality("light")
    window.__mouthQuality = {
      get level() { return LEVELS[level].id; },
      get fps() { return monitor.fps; },
      setQuality: (t, o) => demo.setQuality(t, o),
    };
  }

  // Ready
  loading.remove();
  syncButtons();
  renderDebug();

  // One frame of the demo; also the resume target for pause()/resume().
  function frame(dt, now) {
    const live = has3D && level !== SIMPLE;
    if (pendingSize) {
      lastSize = pendingSize;
      if (has3D) {
        scene.setSize(pendingSize.w, pendingSize.h);
        hologram.setSize(pendingSize.w, pendingSize.h);
      }
      pendingSize = null;
    }
    const step = Math.min(dt, 100);
    const scaled = step * timeline.speed;
    stepBackdrop(step);
    timeline.update(step);
    lipsync.update(step);
    // The side diagram follows the lip sync whenever no cue owns the face; otherwise paint()'s setPose
    // (run earlier this frame by timeline.update) holds it. With no speech the pose is all zero (neutral).
    if (!cueOwnsFace() && (diagramOn() || S.show > 0)) cutaway.setBlend(lipsync.pose());
    if (!live) return; // simple: nothing in 3D to update or draw
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
    monitor.tick(now);
  }
  if (!paused) startLoop();

  setTimeout(() => {
    if (disposed) return;
    container.dispatchEvent(new CustomEvent("demo:ready", { bubbles: true, detail: { driver: driver.name } }));
    emitQuality(startReason); // the starting tier (after any fallback)
  }, 0);

  return demo;
}
