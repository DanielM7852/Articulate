import { getGPUTier } from "detect-gpu";

/**
 * Adaptive quality for the guide.
 *
 * Three tiers:
 *   full    the particle head at full density, pixel ratio up to 2, pointer scatter
 *   light   30% of the dots, pixel ratio up to 1.25, no scatter, the CPU deformer every other frame
 *   simple  no 3D at all: a still picture and the 2D cutaway diagram, which follows lip sync and cues
 *
 * detectTier() picks one at startup (once per tab session; the result is cached in sessionStorage),
 * and createFpsMonitor() watches the frame rate so the demo can step down (or back up) at runtime.
 * Overrides: `?quality=full|light|simple` on the page URL (also inside a hash route, `#/?quality=simple`)
 * wins over everything; then the user's own choice in localStorage `articulate.quality`.
 */
export const TIERS = ["full", "light", "simple"];
export const STORAGE_KEY = "articulate.quality";
const SESSION_KEY = "articulate.quality.detected";
const SOFTWARE = /swiftshader|llvmpipe|softpipe|microsoft basic render|software/i;
const GPU_TIMEOUT_MS = 4000;
const GAP_MS = 5000; // createFpsMonitor: a frame gap this long means the loop was stopped

const isTier = (t) => TIERS.includes(t);

/** Query parameters from both the search part and a hash route's own query (`#/lesson?x=1`). */
export function urlParams() {
  const out = new URLSearchParams();
  try {
    if (typeof location === "undefined") return out;
    for (const [k, v] of new URLSearchParams(location.search)) out.set(k, v);
    const h = location.hash || "";
    const q = h.indexOf("?");
    if (q >= 0) for (const [k, v] of new URLSearchParams(h.slice(q + 1))) out.set(k, v);
  } catch {
    /* no URL: no overrides */
  }
  return out;
}

/** The `?quality=` override, or null. */
export function readUrlQuality() {
  const q = urlParams().get("quality");
  return isTier(q) ? q : null;
}

/** The user's stored choice, or null for "auto". */
export function readStoredQuality() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isTier(v) ? v : null;
  } catch {
    return null;
  }
}

/** Store the user's choice; null (auto) removes it. */
export function storeQuality(tier) {
  try {
    if (isTier(tier)) localStorage.setItem(STORAGE_KEY, tier);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
}

function readCache() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && isTier(v.tier) ? v : null;
  } catch {
    return null;
  }
}

function writeCache(v) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(v));
  } catch {
    /* detection simply runs again next load */
  }
}

/** A throwaway WebGL context: whether there is one at all, and whether the browser calls it slow. */
function probeWebGL() {
  const result = { webgl: false, caveat: false, renderer: "", gl: null };
  if (typeof document === "undefined") return result;
  const tryCtx = (attrs) => {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      return c.getContext("webgl2", attrs) || c.getContext("webgl", attrs) || c.getContext("experimental-webgl", attrs);
    } catch {
      return null;
    }
  };
  const fast = tryCtx({ failIfMajorPerformanceCaveat: true, antialias: false, depth: false });
  const gl = fast || tryCtx({ antialias: false, depth: false });
  if (!gl) return result;
  result.webgl = true;
  result.caveat = !fast; // a context exists, but only with a major performance caveat (usually software)
  result.gl = gl;
  try {
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    result.renderer = String((dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || "");
  } catch {
    /* renderer stays unknown */
  }
  return result;
}

function release(gl) {
  try {
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    /* ignore */
  }
}

/**
 * The hardware's own tier, ignoring overrides. Runs once per tab session (cached in sessionStorage).
 * Resolves { tier, reason, gpuTier, renderer, isMobile, software }; never rejects.
 */
export async function detectHardwareTier({ benchmarksURL } = {}) {
  const cached = readCache();
  if (cached) return cached;
  const nav = typeof navigator !== "undefined" ? navigator : {};
  const cores = nav.hardwareConcurrency || 0;
  const memory = nav.deviceMemory || 0;
  let out;
  let probe = null;
  try {
    probe = probeWebGL();
    if (!probe.webgl) {
      out = { tier: "simple", reason: "no-webgl", gpuTier: 0, renderer: "", isMobile: false, software: false };
    } else {
      let gpu = null;
      try {
        let timer;
        gpu = await Promise.race([
          getGPUTier({ glContext: probe.gl, ...(benchmarksURL ? { benchmarksURL } : {}) }),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), GPU_TIMEOUT_MS);
          }),
        ]).finally(() => clearTimeout(timer));
      } catch (err) {
        console.warn("[quality] GPU benchmark lookup failed:", err?.message ?? err);
      }
      const renderer = probe.renderer || gpu?.gpu || "";
      const software = SOFTWARE.test(renderer) || SOFTWARE.test(gpu?.gpu || "");
      const isMobile = !!gpu?.isMobile;
      const gpuTier = Number.isFinite(gpu?.tier) ? gpu.tier : null;
      let tier = "full";
      let reason = gpu ? `gpu-tier-${gpuTier}` : "gpu-unknown";
      if (gpu?.type === "WEBGL_UNSUPPORTED") [tier, reason] = ["simple", "no-webgl"];
      else if (software) [tier, reason] = ["simple", "software-renderer"];
      else if (probe.caveat) [tier, reason] = ["simple", "performance-caveat"];
      else if (gpuTier === 0) [tier, reason] = ["simple", gpu?.type === "BLOCKLISTED" ? "gpu-blocklisted" : "gpu-tier-0"];
      else if (gpuTier === 1) [tier, reason] = ["light", "gpu-tier-1"];
      else if (isMobile) [tier, reason] = ["light", "mobile"];
      else if (cores && cores <= 4) [tier, reason] = ["light", `cores-${cores}`];
      else if (memory && memory <= 4) [tier, reason] = ["light", `memory-${memory}gb`];
      out = { tier, reason, gpuTier, renderer, isMobile, software };
    }
  } catch (err) {
    console.warn("[quality] detection failed, using full:", err?.message ?? err);
    out = { tier: "full", reason: "detect-error", gpuTier: null, renderer: "", isMobile: false, software: false };
  } finally {
    release(probe?.gl);
  }
  writeCache(out);
  return out;
}

/**
 * The tier to start with: `?quality=` wins, then the user's stored choice, then the hardware.
 * Resolves { tier, reason, source: 'url' | 'user' | 'detected', detected, gpuTier, renderer, isMobile, software };
 * `detected` is the hardware's own tier (what "auto" means). Never rejects.
 */
export async function detectTier(opts = {}) {
  let hw;
  try {
    hw = await detectHardwareTier(opts);
  } catch {
    hw = { tier: "full", reason: "detect-error", gpuTier: null, renderer: "", isMobile: false, software: false };
  }
  const url = readUrlQuality();
  const user = readStoredQuality();
  if (url) return { ...hw, tier: url, reason: "url", source: "url", detected: hw.tier };
  if (user) return { ...hw, tier: user, reason: "user", source: "user", detected: hw.tier };
  return { ...hw, source: "detected", detected: hw.tier };
}

/**
 * Frame-rate monitor, modelled on drei's PerformanceMonitor. Call tick() once per rendered frame.
 * Every `sampleMs` it records the average fps; once `samples` of them are kept, if `threshold` of them sit
 * below bounds[0] it calls onDown, if that share sits at or above bounds[1] it calls onUp (within 2 fps:
 * vsync jitter keeps a 60 Hz display a hair under 60). After any change, and after a pause or a hidden tab,
 * it ignores the next `settleMs`. After `maxFlipflops` changes of direction it stops and calls onDown once
 * more as the hard fallback. `fpsOverride()` (debugging) replaces each measured sample when it returns a number.
 */
export function createFpsMonitor({
  onDown,
  onUp,
  onSample,
  bounds = [50, 60],
  sampleMs = 250,
  samples = 10,
  threshold = 0.75,
  maxFlipflops = 3,
  settleMs = 3000,
  fpsOverride = null,
} = {}) {
  const kept = [];
  let frames = 0;
  let t0 = 0;
  let last = 0;
  let settleUntil = 0;
  let flips = 0;
  let lastDir = 0;
  let stopped = false;
  let avg = 0;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const settle = (at = now()) => {
    kept.length = 0;
    frames = 0;
    t0 = at;
    settleUntil = at + settleMs;
  };

  const onVisibility = () => {
    if (typeof document !== "undefined" && !document.hidden) settle();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  const act = (dir, at) => {
    const fps = Math.round(avg * 10) / 10;
    settle(at);
    if (lastDir && dir !== lastDir) flips++;
    lastDir = dir;
    if (flips >= maxFlipflops) {
      stopped = true;
      onDown?.({ fps, fallback: true });
      return;
    }
    if (dir < 0) onDown?.({ fps, fallback: false });
    else onUp?.({ fps });
  };

  return {
    tick(at = now()) {
      if (stopped) return;
      if (typeof document !== "undefined" && document.hidden) return;
      // A stall this long is a stopped loop (pause, background tab), not a slow frame: start over. Slower
      // frames than this still count, so a machine drawing under 1 fps still steps down.
      if (!last || at - last > GAP_MS) {
        last = at;
        settle(at);
        return;
      }
      last = at;
      if (at < settleUntil) {
        t0 = at;
        frames = 0;
        return;
      }
      frames++;
      const span = at - t0;
      if (span < sampleMs) return;
      let fps = (frames * 1000) / span;
      const forced = fpsOverride?.();
      if (Number.isFinite(forced)) fps = forced;
      t0 = at;
      frames = 0;
      kept.push(fps);
      if (kept.length > samples) kept.shift();
      avg = kept.reduce((s, v) => s + v, 0) / kept.length;
      onSample?.(fps, avg);
      if (kept.length < samples) return;
      const below = kept.filter((v) => v < bounds[0]).length / kept.length;
      const above = kept.filter((v) => v >= bounds[1] - 2).length / kept.length;
      if (below >= threshold) act(-1, at);
      else if (above >= threshold) act(1, at);
    },
    /** Ignore the next settleMs (call after any quality change made elsewhere). */
    reset() {
      last = 0;
      settle();
    },
    /** Start over completely: flip-flop count too (a user's explicit choice). */
    restart() {
      stopped = false;
      flips = 0;
      lastDir = 0;
      last = 0;
      settle();
    },
    get fps() {
      return avg;
    },
    get stopped() {
      return stopped;
    },
    dispose() {
      stopped = true;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
