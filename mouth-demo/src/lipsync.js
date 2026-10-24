// Timed lip sync: turns streamed phoneme / word timestamps into mouth blend shapes,
// driven by an external audio clock (seconds since the speech audio started).
// Pure module: it talks to the avatar only through driver.setShape / releaseShapes.

const LEAD_S = 0.03; // read the timeline slightly ahead of the audio so lips anticipate sounds
const SMOOTH_S = 0.06; // critically damped smoothing time (about 90% of the way in ~60 ms)
const MAX_DT_S = 0.05;
const GAP_HOLD_S = 0.15; // silences shorter than this inside speech keep the lips moving, not resting
const TAIL_S = 0.12; // linger after the last timed item before relaxing
const SETTLE = 0.004;

// Every blend shape lip sync may write. Names a model lacks are ignored by the drivers.
const CHANNELS = [
  "jawOpen", "mouthClose", "mouthPressLeft", "mouthPressRight", "mouthPucker", "mouthFunnel",
  "mouthSmileLeft", "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight",
  "mouthLowerDownLeft", "mouthLowerDownRight", "mouthUpperUpLeft", "mouthUpperUpRight", "mouthRollLower",
];
const INDEX = Object.fromEntries(CHANNELS.map((n, i) => [n, i]));

// Compact viseme spec: left/right pairs share one value.
const PAIRS = { press: "mouthPress", smile: "mouthSmile", stretch: "mouthStretch", lower: "mouthLowerDown", upper: "mouthUpperUp" };
function viseme(spec) {
  const out = new Float32Array(CHANNELS.length);
  for (const [k, v] of Object.entries(spec)) {
    if (PAIRS[k]) {
      out[INDEX[`${PAIRS[k]}Left`]] = v;
      out[INDEX[`${PAIRS[k]}Right`]] = v;
    } else {
      out[INDEX[k]] = v;
    }
  }
  return out;
}

// Jaw floors at 0.06 for everything but bilabials, so the mouth never shuts mid-word.
const V = {
  rest: viseme({}),
  open: viseme({ jawOpen: 0.5, lower: 0.25, upper: 0.1 }), // ah, a, ae, schwa
  mid: viseme({ jawOpen: 0.32, stretch: 0.22, smile: 0.1, lower: 0.12 }), // eh, ey
  spread: viseme({ jawOpen: 0.14, smile: 0.4, stretch: 0.3 }), // ee, ih, y
  round: viseme({ jawOpen: 0.35, mouthFunnel: 0.55, mouthPucker: 0.35 }), // aw, o
  pucker: viseme({ jawOpen: 0.12, mouthPucker: 0.85, mouthFunnel: 0.6 }), // oo, w
  bilabial: viseme({ jawOpen: 0.02, mouthClose: 0.65, press: 0.5 }), // p b m
  labiodental: viseme({ jawOpen: 0.1, mouthRollLower: 0.6, upper: 0.2 }), // f v
  postalv: viseme({ jawOpen: 0.15, mouthPucker: 0.5, mouthFunnel: 0.5 }), // sh zh ch j
  sibilant: viseme({ jawOpen: 0.06, smile: 0.25, stretch: 0.2 }), // s z
  tongue: viseme({ jawOpen: 0.18, lower: 0.08 }), // t d n l th
  velar: viseme({ jawOpen: 0.2, lower: 0.06 }), // k g ng h
  r: viseme({ jawOpen: 0.15, mouthPucker: 0.3, mouthFunnel: 0.2 }),
  other: viseme({ jawOpen: 0.2, lower: 0.06 }), // unknown symbol
};

const GROUPS = {
  open: "aa ah ae a ax ɑ æ ʌ ə ɐ ɚ ɜ ɝ ɒ",
  mid: "eh ey e ɛ eɪ ei",
  spread: "iy ih i ɪ y j ɨ",
  round: "ao ow oy o ɔ ɔɪ oʊ əʊ oh ø œ",
  pucker: "uw uh u ʊ w ʉ ɯ",
  bilabial: "p b m",
  labiodental: "f v ɱ",
  postalv: "sh zh ch jh ʃ ʒ tʃ dʒ ɕ ʑ",
  sibilant: "s z ts dz",
  tongue: "t d n l th dh θ ð ɾ ɫ dx ɳ ɖ ʈ ɭ ɲ",
  velar: "k g ng hh h ŋ x ɣ q ɡ ʔ",
  r: "r er ɹ ɻ ʁ ʀ",
  rest: "sil sp pau silence",
};
const TABLE = new Map();
for (const [name, list] of Object.entries(GROUPS)) for (const sym of list.split(" ")) TABLE.set(sym, V[name]);
// Diphthongs that start open (ARPAbet AY / AW, IPA aɪ / aʊ).
for (const sym of ["ay", "aw", "aɪ", "aʊ", "ai", "au"]) TABLE.set(sym, V.open);

// Strip stress digits and IPA length / stress / aspiration marks, lowercase ARPAbet.
const STRIP = new RegExp("[-0-9 _<>|." + String.fromCharCode(0x2c8, 0x2cc, 0x2d0, 0x2d1, 0x2b0, 0x2b2, 0x2b7, 0x329, 0x32f, 0x303, 0x35c, 0x361) + "]", "g");
function normalize(sym) {
  return String(sym ?? "").replace(STRIP, "").toLowerCase();
}

export function visemeFor(sym) {
  const s = normalize(sym);
  if (!s) return V.rest;
  return TABLE.get(s) ?? TABLE.get(s.slice(0, 2)) ?? TABLE.get(s[0]) ?? (/[a-zɐ-ʯθð]/.test(s[0]) ? V.other : V.rest);
}

// Cheap deterministic hash in [0, 1) so word-only motion varies but is repeatable.
function hash01(str, n) {
  let h = 2166136261 ^ n;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

const countSyllables = (text) => Math.max(1, (String(text).toLowerCase().match(/[aeiouy]+/g) ?? []).length);

// Index of the last item with start <= t, or -1. Items are sorted by start.
function lastStarted(items, t) {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

const clean = (list, keyOk) => (Array.isArray(list) ? list.filter((x) => x && keyOk(x) && Number.isFinite(x.start) && Number.isFinite(x.end)) : []);
const byStart = (a, b) => a.start - b.start;

export function createLipSync({ driver, isBlocked = () => false, emit = () => {} }) {
  const values = new Float32Array(CHANNELS.length);
  const vel = new Float32Array(CHANNELS.length);
  const target = new Float32Array(CHANNELS.length);
  let session = null;
  let owning = false; // we have written shapes the driver still holds

  const fillPhoneme = (s, t) => {
    const ph = s.phonemes;
    const i = lastStarted(ph, t);
    if (i >= 0 && t < ph[i].end) { target.set(visemeFor(ph[i].p)); return true; }
    const prev = i >= 0 ? ph[i] : null;
    const next = ph[i + 1] ?? null;
    if (prev && next && next.start - prev.end < GAP_HOLD_S) {
      target.set(visemeFor(t < (prev.end + next.start) / 2 ? prev.p : next.p));
      return true;
    }
    if (prev && !next && t - prev.end < GAP_HOLD_S / 2) { target.set(visemeFor(prev.p)); return true; }
    if (!prev && next && next.start - t < GAP_HOLD_S / 2) { target.set(visemeFor(next.p)); return true; }
    target.fill(0);
    return true;
  };

  // Word-only fallback: one open/close per syllable across the word, a soft floor between words.
  const fillWord = (s, t) => {
    const w = s.words;
    const i = lastStarted(w, t);
    target.fill(0);
    if (i < 0 || t >= w[i].end) return;
    const word = w[i];
    const dur = Math.max(0.05, word.end - word.start);
    const n = countSyllables(word.text);
    const phase = ((t - word.start) / dur) * n;
    const syl = Math.min(n - 1, Math.floor(phase));
    const swing = Math.sin(Math.PI * (phase - syl)) ** 2;
    const amp = 0.55 + 0.45 * hash01(word.text, syl);
    const flavour = hash01(word.text, syl + 17);
    const e = swing * amp;
    target[INDEX.jawOpen] = 0.08 + 0.34 * e;
    target[INDEX.mouthLowerDownLeft] = target[INDEX.mouthLowerDownRight] = 0.14 * e;
    if (flavour < 0.3) { target[INDEX.mouthPucker] = 0.3 * e; target[INDEX.mouthFunnel] = 0.2 * e; }
    else if (flavour > 0.65) { target[INDEX.mouthSmileLeft] = target[INDEX.mouthSmileRight] = 0.2 * e; }
  };

  const computeTarget = (s, t) => {
    const ph = s.phonemes;
    const phonemeMode = ph.length && t >= ph[0].start - GAP_HOLD_S && t <= ph[ph.length - 1].end + GAP_HOLD_S;
    if (phonemeMode) fillPhoneme(s, t);
    else fillWord(s, t);
  };

  const lastTimedEnd = (s) => Math.max(s.phonemes.length ? s.phonemes[s.phonemes.length - 1].end : 0, s.words.length ? s.words.reduce((m, w) => Math.max(m, w.end), 0) : 0);

  const finish = (s) => {
    if (s.done) return;
    s.done = true;
    if (session === s) session = null;
    if (s.started) emit("speech:end");
  };

  // Advance the session's notion of what the lips should do. Runs even while a cue blocks the visuals.
  const tickSession = (s) => {
    if (s.done) return;
    let t;
    try { t = Number(s.clock()); } catch { t = NaN; }
    if (!Number.isFinite(t)) return; // bad reading: hold the current shape
    if (t < 0) { target.fill(0); return; } // audio not started yet
    if (!s.started) { s.started = true; emit("speech:start"); }
    // Stalls and rewinds hold the last target instead of jumping.
    if (t < s.lastT) return;
    s.lastT = t;
    computeTarget(s, t + LEAD_S);
    if (s.ended && t > lastTimedEnd(s) + TAIL_S) finish(s);
  };

  // Critically damped spring (Unity SmoothDamp form), per channel.
  const smooth = (dt) => {
    const omega = 2 / SMOOTH_S;
    const x = omega * dt;
    const k = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    for (let i = 0; i < values.length; i++) {
      const change = values[i] - target[i];
      const temp = (vel[i] + omega * change) * dt;
      vel[i] = (vel[i] - omega * temp) * k;
      values[i] = target[i] + (change + temp) * k;
    }
  };

  const settled = () => {
    for (let i = 0; i < values.length; i++) if (Math.abs(values[i]) > SETTLE || Math.abs(vel[i]) > 0.05) return false;
    return true;
  };

  const releaseDriver = () => {
    if (!owning) return;
    owning = false;
    driver.releaseShapes(CHANNELS);
  };

  return {
    get speaking() { return !!session; },

    speak({ clock, timeline } = {}) {
      if (session) { session.stop(); }
      const s = {
        clock: typeof clock === "function" ? clock : () => -1,
        phonemes: [],
        words: [],
        ended: false,
        started: false,
        done: false,
        lastT: -Infinity,
      };
      const add = (tl) => {
        if (!tl) return;
        s.phonemes.push(...clean(tl.phonemes, (x) => typeof x.p === "string"));
        s.words.push(...clean(tl.words, (x) => typeof x.text === "string"));
        s.phonemes.sort(byStart);
        s.words.sort(byStart);
      };
      add(timeline);
      session = s;
      s.stop = () => { finish(s); };
      return {
        append(t) { if (!s.done) add(t); },
        end() { s.ended = true; },
        stop() { s.stop(); },
      };
    },

    update(dtMs) {
      const dt = Math.min(Math.max(dtMs / 1000, 0), MAX_DT_S);
      if (session) tickSession(session);
      else target.fill(0);

      if (isBlocked()) {
        // A cue owns the mouth: stay out of the way and restart from rest when it lets go.
        values.fill(0);
        vel.fill(0);
        owning = false;
        return;
      }
      if (!session && !owning) return;
      smooth(dt);
      if (!session && settled()) {
        values.fill(0);
        vel.fill(0);
        releaseDriver();
        return;
      }
      for (let i = 0; i < CHANNELS.length; i++) driver.setShape(CHANNELS[i], Math.max(0, values[i]));
      owning = true;
    },

    dispose() {
      if (session) session.stop();
      values.fill(0);
      vel.fill(0);
      releaseDriver();
    },
  };
}
