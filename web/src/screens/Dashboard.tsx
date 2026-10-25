import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';
import { subscribeTelemetry, type NodeId, type TelemetryEvent } from '../telemetry/client';
import brandMark from '../assets/landing/brand-mark.svg';
import { FACE_POINTS, canonicalFace, createDotFace, decodeFaceV2, decodeFaceV3 } from '../dashboard/dotFace';
import '../styles/dashboard.css';

/**
 * Backend dashboard for a second screen: the whole system as a live graph drawn in the guide's
 * own visual language. Each subsystem is a breathing cluster of navy dots lit from the upper left;
 * every telemetry event (docs/telemetry.md) sends a packet of dots along its edge and the target
 * ripples. One 2D canvas draws all the dots; the labels and live detail cards are HTML laid out in
 * a fixed 1600 x 900 design space that is scaled to fit the viewport (the canvas uses the same
 * transform). Animation state lives in refs; React only re-renders the cards, at most 10 times a second.
 * The perception streams (lip.mesh, audio.spectrum) are drawn by the same frame loop: the MediaPipe card's
 * face canvas (a dot face over the full mesh for v3 and v2 frames, the 81-point wireframe for v1), and the Audio
 * cluster as a radial equaliser on per-band springs.
 *
 * Live events come from `subscribeTelemetry`. `?demo` (or `d`) replays /telemetry-demo.json through
 * the same path, and with no live event 15 s after connecting the replay starts on its own, tagged.
 */

const W = 1600;
const H = 900;

/**
 * Where a node runs. The coach model and speech to text take their tag from the live provider; 'LLM' and 'STT' are
 * the neutral tags shown before any evidence arrives.
 */
type Loc = 'browser' | 'server' | 'Cartesia' | 'Anthropic' | 'OpenAI' | 'LLM' | 'STT' | 'maincloud';

interface NodeDef {
  id: NodeId;
  name: string;
  caption: string;
  loc: Loc;
  x: number;
  y: number;
  r: number;
  /** dots in the cluster */
  n: number;
  /** annotation block (label + card): top-left corner and width, design px */
  ann: [number, number, number];
  /** which edge of the annotation lines up with the cluster */
  align?: 'left' | 'right';
}

const NODES: NodeDef[] = [
  { id: 'camera', name: 'Camera', caption: 'webcam capture', loc: 'browser', x: 404, y: 112, r: 28, n: 150, ann: [446, 92, 140] },
  { id: 'mediapipe', name: 'MediaPipe', caption: 'FaceLandmarker → LipFrame', loc: 'browser', x: 404, y: 262, r: 40, n: 230, ann: [44, 76, 306], align: 'right' },
  { id: 'mic', name: 'Microphone', caption: 'microphone capture', loc: 'browser', x: 84, y: 540, r: 28, n: 150, ann: [52, 580, 170] },
  { id: 'audio', name: 'Audio', caption: 'spectrum and formant analysis in the browser', loc: 'browser', x: 300, y: 568, r: 40, n: 230, ann: [96, 652, 214], align: 'right' },
  { id: 'stt', name: 'Speech to text', caption: 'OpenAI Realtime in the word lesson · Cartesia Ink in hands-free practice', loc: 'STT', x: 664, y: 176, r: 40, n: 220, ann: [660, 228, 214] },
  { id: 'tts', name: 'Sonic', caption: 'Cartesia Sonic text to speech (Ava’s voice)', loc: 'Cartesia', x: 930, y: 176, r: 40, n: 220, ann: [930, 228, 196] },
  { id: 'backend', name: 'Backend', caption: 'FastAPI app', loc: 'server', x: 790, y: 488, r: 52, n: 320, ann: [536, 404, 190], align: 'right' },
  { id: 'pitch', name: 'Acoustics', caption: 'Praat/Parselmouth pitch and formants', loc: 'server', x: 566, y: 762, r: 34, n: 190, ann: [324, 712, 200], align: 'right' },
  { id: 'sparc', name: 'SPARC', caption: 'articulatory model collector (needs ARTICULATION_URL)', loc: 'server', x: 1010, y: 650, r: 38, n: 210, ann: [1058, 606, 184] },
  { id: 'db', name: 'SpacetimeDB', caption: 'live tables, subscriptions', loc: 'maincloud', x: 790, y: 768, r: 44, n: 260, ann: [846, 736, 170] },
  { id: 'claude', name: 'Coach model', caption: 'language model: coach decisions, notes, insights', loc: 'LLM', x: 1212, y: 470, r: 112, n: 760, ann: [1262, 612, 312] },
  { id: 'ui', name: 'Learner', caption: 'the learner’s screen', loc: 'browser', x: 1478, y: 196, r: 44, n: 260, ann: [1416, 250, 170] },
];
const NODE = Object.fromEntries(NODES.map((n) => [n.id, n])) as Record<NodeId, NodeDef>;

/**
 * Edges drawn on the paper: the source -> target pairs in docs/telemetry.md, plus mic -> audio. A pair missing here
 * still animates (curveFor makes an undrawn lane on first use) but has no dotted line. Bend is a fraction of the length.
 */
const EDGES: [NodeId, NodeId, number][] = [
  ['camera', 'mediapipe', 0.06],
  ['mic', 'audio', 0.06],
  ['mic', 'stt', 0.28], // bowed clear of the MediaPipe card
  ['mediapipe', 'db', 0.12],
  ['audio', 'db', 0.06],
  ['stt', 'ui', -0.11],
  ['ui', 'tts', 0.12],
  ['tts', 'ui', 0.12],
  ['backend', 'tts', 0.12],
  ['ui', 'backend', 0.06],
  ['backend', 'ui', 0.06],
  ['backend', 'claude', 0.1],
  ['claude', 'backend', 0.1],
  ['backend', 'pitch', 0.16],
  ['pitch', 'backend', 0.16],
  ['backend', 'sparc', 0.16],
  ['sparc', 'backend', 0.16],
  ['backend', 'db', 0.05],
  ['ui', 'db', 0.2], // ui.join / ui.ping / ui.leave; bowed clear of the coach model's halo
];

/** Perception streams (10 Hz): they drive the wireframe and the audio equaliser in place, no packets. */
const PERCEPT = new Set(['lip.mesh', 'audio.spectrum']);
/** High-rate kinds: they animate but stay out of the ticker. */
const QUIET = new Set(['lip.frame', 'audio.frame', 'lip.batch', 'audio.batch', 'ui.ping', ...PERCEPT]);

const PACKET_MS = 600;
const RIPPLE_MS = 760;
const HALO_MS = 1700;
const CHAR_MS = 25;
const FALLBACK_MS = 15000;
/** Rows older than this on arrival are backfill: they fill the cards but do not animate. */
const STALE_MS = 30000;
const TICK_MS = 6000;
const PRESENCE_MS = 60000;
const FADE_MS = 500;
const MAX_DOTS = 24;
/** A perception stream with no frame for this long reads as gone (wireframe fades, equaliser relaxes). */
const PERCEPT_MS = 1500;
/** The camera reads "on" only while camera.on was seen and a lip.frame or lip.mesh arrived this recently. */
const FACE_MS = 5000;
/** A microphone stream with no spectrum for this long reads as closed. */
const MIC_QUIET_MS = 3000;
/** sparc.features are EMA units; the bars span -SPARC_RANGE..+SPARC_RANGE around a centre line. */
const SPARC_RANGE = 2;
/** lip.mesh v1: 81 points as flat x, y pairs (docs/telemetry.md, "Perception streams"). */
const MESH_LEN = 162;
const MESH_LERP_MS = 80;
/** The face canvas, design px. */
const FACE_BOX = 280;
const FACE_PAD = 6;
/** The v1 wireframe is drawn in a 200-unit square, scaled to the canvas. */
const WIRE = 200;
const SPEC_BINS = 32;
/** Equaliser springs, per second: lively but not jittery (damping ratio ~0.64). */
const SPRING_K = 120;
const SPRING_C = 14;
/** rms that fills the meter and the breathing. */
const RMS_FULL = 0.3;

const TONES = ['#203e68', '#3b5884', '#8fa5c3', '#c2cedd'];
const TONE_ALPHA = [0.94, 0.9, 1, 1];

// ---------- live model (cards) ----------

interface TickItem {
  key: string;
  source: string;
  target: string;
  label: string;
  at: number;
}

type CoachProvider = 'openai' | 'anthropic';
type SttProvider = 'openai' | 'cartesia';
type CameraState = 'waiting' | 'on' | 'off';
type MicState = 'waiting' | 'listening' | 'closed';
/** MediaPipe card: a live mesh, lip.frame tracking without a mesh, or no face */
type FaceState = 'mesh' | 'tracking' | 'none';

const PROVIDER_TAG: Record<CoachProvider, Loc> = { openai: 'OpenAI', anthropic: 'Anthropic' };
const STT_TAG: Record<SttProvider, Loc> = { openai: 'OpenAI', cartesia: 'Cartesia' };
const STT_NAME: Record<SttProvider, string> = { openai: 'OpenAI Realtime', cartesia: 'Cartesia Ink' };

interface BackendUp {
  provider: CoachProvider | null;
  model: string | null;
  articulation: boolean | null;
  pitchTable: boolean | null;
}

interface Model {
  count: number;
  stamps: number[];
  /** the latest camera.on / camera.off and the tab that sent it */
  camera: { on: boolean; sid: string | null } | null;
  /** any microphone evidence yet: audio.spectrum or an stt.* event */
  micSeen: boolean;
  /** performance.now() of the newest sign of an open stream (audio.spectrum, stt.open) */
  micAt: number | null;
  /** latest lip.frame; `at` is its arrival in performance.now() time (backfill lands in the past) */
  lip: { ok: boolean; opening: number; width: number; rounding: number; at: number; sid: string | null } | null;
  /** f1 / f2 stay null when the frame had none (outside practice attempts) */
  audio: { f1: number | null; f2: number | null; rms: number; env: number[] } | null;
  /**
   * latest lip.mesh; `at` is performance.now() on arrival. v1: `pts` 81 points 0..255. v2: `xyz` the full mesh,
   * decoded once on arrival (dotFace.ts frame) from a wire v2 (replay) or v3 (live) payload; `n` is the point
   * count the frame carried.
   */
  mesh: { v: 1; pts: number[]; n: number; at: number; sid: string | null } | { v: 2; xyz: Float32Array; n: number; at: number; sid: string | null } | null;
  /** latest audio.spectrum, bins 0..1 */
  spectrum: { bins: number[]; rms: number; at: number; sid: string | null } | null;
  stt: { text: string; final: boolean } | null;
  sttProvider: SttProvider | null;
  tts: { chars: number; voice: string; ms: number | null } | null;
  /** voiced is 0..100; f1 / f2 (Hz) only when the backend measured formants */
  pitch: {
    mean: number | null;
    min: number | null;
    max: number | null;
    voiced: number | null;
    latency: number | null;
    method: string | null;
    f1: number | null;
    f2: number | null;
  } | null;
  /** method named by the latest pitch.extract or pitch.result */
  pitchMethod: string | null;
  /** feats are signed EMA units; seen is true once any sparc.* event arrived */
  sparc: { feats: number[] | null; latency: number | null; skipped: string | null; seen: boolean };
  dbReads: number[];
  dbWrites: number[];
  dbTable: string | null;
  claude: { model: string; purpose: string; latency: number | null; inTok: number | null; outTok: number | null; error: string | null } | null;
  /** who answered the latest claude.* event (or a newer backend.up); `at` is its event time */
  coachProvider: { provider: CoachProvider; at: number } | null;
  backendUp: BackendUp | null;
  claudeCalls: number;
  claudeLine: string;
  backendReqs: number[];
  backendOut: number[];
  ui: { verdict: string | null; cue: string | null; score: string | null };
  ticker: TickItem[];
  lastAt: Record<string, number>;
  /** sid -> last seen (epoch ms); leftAt is set while the dot fades out */
  presence: Map<string, { seen: number; leftAt: number | null }>;
}

const freshModel = (): Model => ({
  count: 0,
  stamps: [],
  camera: null,
  micSeen: false,
  micAt: null,
  lip: null,
  audio: null,
  mesh: null,
  spectrum: null,
  stt: null,
  sttProvider: null,
  tts: null,
  pitch: null,
  pitchMethod: null,
  sparc: { feats: null, latency: null, skipped: null, seen: false },
  dbReads: [],
  dbWrites: [],
  dbTable: null,
  claude: null,
  coachProvider: null,
  backendUp: null,
  claudeCalls: 0,
  claudeLine: '',
  backendReqs: [],
  backendOut: [],
  ui: { verdict: null, cue: null, score: null },
  ticker: [],
  lastAt: {},
  presence: new Map(),
});

interface Snap {
  count: number;
  rate: number;
  cameraState: CameraState;
  micState: MicState;
  faceState: FaceState;
  lip: Model['lip'];
  audio: Model['audio'];
  meshLive: boolean;
  /** points in the latest mesh frame (81, 468 or 478) */
  meshPoints: number;
  /** only while the stream is live */
  spectrum: { bins: number[]; rms: number } | null;
  stt: Model['stt'];
  sttProvider: SttProvider | null;
  tts: Model['tts'];
  pitch: Model['pitch'];
  pitchMethod: string | null;
  sparc: Model['sparc'];
  dbReads: number;
  dbWrites: number;
  dbTable: string | null;
  claude: Model['claude'];
  /** the latest provider evidence, else backend.up's idle default; null before either */
  coachProvider: CoachProvider | null;
  backendUp: BackendUp | null;
  claudeCalls: number;
  backendRpm: number;
  backendOut: number;
  ui: Model['ui'];
  ticker: TickItem[];
  learners: number;
  dots: { sid: string; leaving: boolean }[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function within(list: number[], now: number, ms: number) {
  while (list.length && now - list[0] > ms) list.shift();
  return list.length;
}

const meshLive = (m: Model, now: number) => m.mesh !== null && now - m.mesh.at < PERCEPT_MS;
const specLive = (m: Model, now: number) => m.spectrum !== null && now - m.spectrum.at < PERCEPT_MS;

/** 'openai' | 'anthropic' from a payload's `provider`, else inferred from its model (rows without one, e.g. the replay). */
function coachProviderOf(p: Record<string, unknown>): CoachProvider | null {
  const v = str(p.provider)?.toLowerCase();
  if (v === 'openai' || v === 'anthropic') return v;
  const model = str(p.model)?.toLowerCase() ?? '';
  if (model.startsWith('gpt-')) return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  return null;
}

/** 'openai' (Realtime) | 'cartesia' (Ink). Rows from before the field existed all came from Cartesia Ink. */
function sttProviderOf(p: Record<string, unknown>): SttProvider | null {
  if (p.provider === undefined) return 'cartesia';
  const v = str(p.provider)?.toLowerCase();
  return v === 'openai' || v === 'cartesia' ? v : null;
}

/** States derived from stream liveness; they change with time alone, so the card loop re-renders on their key. */
function derive(m: Model, now: number) {
  const ml = meshLive(m, now);
  const sl = specLive(m, now);
  const faceAt = Math.max(m.lip?.at ?? -Infinity, m.mesh?.at ?? -Infinity);
  const cameraState: CameraState =
    m.camera?.on === true && now - faceAt < FACE_MS ? 'on' : m.camera === null && faceAt === -Infinity ? 'waiting' : 'off';
  // stt.close never closes the mic on its own: the spectrum decides, with a grace of MIC_QUIET_MS
  const micState: MicState = sl || (m.micAt !== null && now - m.micAt <= MIC_QUIET_MS) ? 'listening' : m.micSeen ? 'closed' : 'waiting';
  const lipLive = m.lip !== null && m.lip.ok && now - m.lip.at < PERCEPT_MS;
  const faceState: FaceState = ml ? 'mesh' : lipLive ? 'tracking' : 'none';
  return { ml, sl, cameraState, micState, faceState, key: `${ml}|${sl}|${cameraState}|${micState}|${faceState}` };
}

function snapshot(m: Model, now: number): Snap {
  const d = derive(m, now);
  return {
    count: m.count,
    rate: within(m.stamps, now, 10000) / 10,
    cameraState: d.cameraState,
    micState: d.micState,
    faceState: d.faceState,
    lip: m.lip,
    audio: m.audio,
    meshLive: d.ml,
    meshPoints: m.mesh ? m.mesh.n : FACE_POINTS,
    spectrum: m.spectrum && d.sl ? { bins: m.spectrum.bins, rms: m.spectrum.rms } : null,
    stt: m.stt,
    sttProvider: m.sttProvider,
    tts: m.tts,
    pitch: m.pitch,
    pitchMethod: m.pitch?.method ?? m.pitchMethod,
    sparc: m.sparc,
    dbReads: within(m.dbReads, now, 60000),
    dbWrites: within(m.dbWrites, now, 60000),
    dbTable: m.dbTable,
    claude: m.claude,
    coachProvider: m.coachProvider?.provider ?? m.backendUp?.provider ?? null,
    backendUp: m.backendUp,
    claudeCalls: m.claudeCalls,
    backendRpm: within(m.backendReqs, now, 60000),
    backendOut: within(m.backendOut, now, 60000),
    ui: m.ui,
    ticker: m.ticker.filter((t) => now - t.at < TICK_MS),
    learners: [...m.presence.values()].filter((v) => v.leftAt === null).length,
    dots: [...m.presence].map(([sid, v]) => ({ sid, leaving: v.leftAt !== null })),
  };
}

/** Expires presence entries (60 s without any event, or a leave) and drops faded ones. Returns true on change. */
function prunePresence(m: Model): boolean {
  const wall = Date.now();
  let changed = false;
  for (const [sid, v] of m.presence) {
    if (v.leftAt === null) {
      if (wall - v.seen > PRESENCE_MS) {
        v.leftAt = wall;
        changed = true;
      }
    } else if (wall - v.leftAt > FADE_MS) {
      m.presence.delete(sid);
      changed = true;
    }
  }
  return changed;
}

/** Folds one event into the card model. Older events (backfill) never overwrite newer state of the same kind. */
function apply(m: Model, e: TelemetryEvent, now: number, live: boolean) {
  m.count += 1;
  const psid = typeof e.payload?.sid === 'string' ? e.payload.sid : null;
  if (psid && Date.now() - e.at <= PRESENCE_MS) {
    const cur = m.presence.get(psid);
    if (e.kind === 'ui.leave') {
      if (cur && cur.leftAt === null) cur.leftAt = Date.now();
    } else if (!cur || cur.leftAt === null || e.kind === 'ui.join') {
      m.presence.set(psid, { seen: Math.max(e.at, cur?.seen ?? 0), leftAt: null });
    }
  }
  if (live) m.stamps.push(now);
  const counted = live ? now : now - 1; // backfill still counts toward the rolling minute
  // The browser's coach.request carries a sid; the backend logs a duplicate without one, which is not a request.
  if (e.kind === 'coach.request' && psid) m.backendReqs.push(counted);
  const prev = m.lastAt[e.kind];
  if (prev !== undefined && e.at < prev) return;
  m.lastAt[e.kind] = e.at;
  const p = e.payload ?? {};
  // arrival in performance.now() time: backfill lands as far in the past as the row is old, so it never reads live
  const arrived = live ? now : now - Math.max(0, Date.now() - e.at);
  const noteCoach = () => {
    const provider = coachProviderOf(p);
    if (provider && (!m.coachProvider || e.at >= m.coachProvider.at)) m.coachProvider = { provider, at: e.at };
  };
  switch (e.kind) {
    case 'camera.on':
      m.camera = { on: true, sid: psid };
      break;
    case 'camera.off':
      m.camera = { on: false, sid: psid };
      break;
    case 'stt.open':
      m.micSeen = true;
      m.micAt = Math.max(m.micAt ?? -Infinity, arrived);
      m.sttProvider = sttProviderOf(p) ?? m.sttProvider;
      break;
    case 'stt.close':
      m.micSeen = true;
      m.sttProvider = sttProviderOf(p) ?? m.sttProvider;
      break;
    case 'lip.frame':
      m.lip = {
        ok: p.ok !== false,
        opening: clamp01(num(p.opening) ?? 0),
        width: clamp01(num(p.width) ?? 0),
        rounding: clamp01(num(p.rounding) ?? 0),
        at: arrived,
        sid: psid,
      };
      break;
    case 'audio.frame': {
      const env = Array.isArray(p.env) ? p.env.map((v) => clamp01(Number(v) || 0)).slice(0, 32) : [];
      m.audio = { f1: num(p.f1), f2: num(p.f2), rms: clamp01(num(p.rms) ?? 0), env };
      break;
    }
    case 'ui.leave':
      // the tab is gone: its camera, face and microphone stop reading live at once
      if (!psid) break;
      if (m.camera?.sid === psid) m.camera = { on: false, sid: psid };
      if (m.lip?.sid === psid) m.lip = null;
      if (m.mesh?.sid === psid) m.mesh = null;
      if (m.spectrum?.sid === psid) {
        m.spectrum = null;
        m.micAt = null;
      }
      break;
    case 'lip.mesh': {
      // Backfill is stale by definition; and one face at a time: a second tab waits until the first goes quiet.
      if (!live) break;
      if (m.mesh && m.mesh.sid !== psid && now - m.mesh.at < PERCEPT_MS) break;
      if ((p.v === 2 || p.v === 3) && typeof p.pts === 'string') {
        const n = num(p.n) ?? 0;
        const xyz = p.v === 3 ? decodeFaceV3(p.pts, n) : decodeFaceV2(p.pts, n);
        if (!xyz) break;
        m.mesh = { v: 2, xyz, n, at: now, sid: psid };
      } else if (Array.isArray(p.pts) && p.pts.length === MESH_LEN) {
        // v1 stays valid; while full-mesh (v2/v3) frames from this tab are flowing they win
        if (m.mesh && m.mesh.v === 2 && m.mesh.sid === psid && now - m.mesh.at < PERCEPT_MS) break;
        m.mesh = { v: 1, pts: p.pts.map((v) => Math.min(255, Math.max(0, Number(v) || 0))), n: 81, at: now, sid: psid };
      }
      break;
    }
    case 'audio.spectrum': {
      if (!live || !Array.isArray(p.bins) || p.bins.length < SPEC_BINS) break;
      if (m.spectrum && m.spectrum.sid !== psid && now - m.spectrum.at < PERCEPT_MS) break;
      m.spectrum = {
        bins: p.bins.slice(0, SPEC_BINS).map((v) => clamp01((Number(v) || 0) / 255)),
        rms: clamp01(num(p.rms) ?? 0),
        at: now,
        sid: psid,
      };
      m.micSeen = true;
      m.micAt = now;
      break;
    }
    case 'stt.transcript':
      m.stt = { text: (str(p.text) ?? '').slice(0, 80), final: p.final === true };
      m.micSeen = true;
      m.sttProvider = sttProviderOf(p) ?? m.sttProvider;
      break;
    case 'tts.speak':
      m.tts = { chars: num(p.chars) ?? 0, voice: str(p.voice) ?? '—', ms: m.tts?.ms ?? null };
      break;
    case 'tts.audio':
      m.tts = { chars: m.tts?.chars ?? 0, voice: m.tts?.voice ?? '—', ms: num(p.ms) };
      break;
    case 'pitch.extract':
      m.pitchMethod = str(p.method) ?? m.pitchMethod;
      break;
    case 'pitch.result': {
      const voiced = num(p.voicedPct);
      const method = str(p.method);
      m.pitch = {
        mean: num(p.f0Mean),
        min: num(p.f0Min),
        max: num(p.f0Max),
        // 0..100; the recorded replay still carries a 0..1 fraction
        voiced: voiced == null ? null : voiced <= 1 ? voiced * 100 : voiced,
        latency: num(p.latencyMs),
        method,
        f1: num(p.f1Hz),
        f2: num(p.f2Hz),
      };
      if (method) m.pitchMethod = method;
      break;
    }
    case 'sparc.request':
      m.sparc = { ...m.sparc, seen: true };
      break;
    case 'sparc.features':
      m.sparc = {
        feats: [p.tongueHeight, p.tongueFront, p.jawOpen, p.lipForward, p.lipAperture].map((v) => num(v) ?? 0),
        latency: num(p.latencyMs),
        skipped: null,
        seen: true,
      };
      break;
    case 'sparc.skipped':
      m.sparc = { ...m.sparc, skipped: str(p.reason) ?? 'skipped', seen: true };
      break;
    case 'backend.up': {
      const up: BackendUp = {
        provider: coachProviderOf(p),
        model: str(p.model),
        articulation: typeof p.articulation === 'boolean' ? p.articulation : null,
        pitchTable: typeof p.pitchTable === 'boolean' ? p.pitchTable : null,
      };
      m.backendUp = up;
      // a backend that started after the latest call is newer evidence than that call
      if (up.provider && m.coachProvider && e.at >= m.coachProvider.at) m.coachProvider = { provider: up.provider, at: e.at };
      break;
    }
    case 'db.read':
      m.dbReads.push(counted);
      m.dbTable = str(p.table) ?? m.dbTable;
      break;
    case 'db.write':
      m.dbWrites.push(counted);
      m.dbTable = str(p.table) ?? m.dbTable;
      break;
    case 'lip.batch':
    case 'audio.batch':
      m.dbWrites.push(counted);
      m.dbTable = 'metric_batch';
      break;
    case 'claude.request':
      noteCoach();
      m.claudeCalls += 1;
      m.claude = { model: str(p.model) ?? m.claude?.model ?? '—', purpose: str(p.purpose) ?? '—', latency: null, inTok: null, outTok: null, error: null };
      break;
    case 'claude.response':
      noteCoach();
      m.claude = {
        model: str(p.model) ?? m.claude?.model ?? '—',
        purpose: str(p.purpose) ?? m.claude?.purpose ?? '—',
        latency: num(p.latencyMs),
        inTok: num(p.inputTokens),
        outTok: num(p.outputTokens),
        error: null,
      };
      m.claudeLine = (str(p.line) ?? '').slice(0, 120);
      break;
    case 'claude.error':
      noteCoach();
      m.claude = {
        model: str(p.model) ?? m.claude?.model ?? '—',
        purpose: str(p.purpose) ?? m.claude?.purpose ?? '—',
        latency: num(p.latencyMs),
        inTok: null,
        outTok: null,
        error: (str(p.error) ?? 'error').slice(0, 60),
      };
      break;
    case 'coach.decision':
      m.ui = { ...m.ui, verdict: str(p.verdict), cue: str(p.cue) };
      break;
    case 'video.score':
      m.ui = { ...m.ui, score: str(p.verdict) };
      break;
  }
  if (e.source === 'backend') m.backendOut.push(counted);
}

// ---------- dot engine ----------

interface Cluster {
  def: NodeDef;
  dx: Float32Array;
  dy: Float32Array;
  rr: Float32Array;
  size: Float32Array;
  tone: Uint8Array;
  ph: Float32Array;
  phase: number;
  glowAt: number;
  glowAmp: number;
  rippleAt: number;
  haloAt: number;
}

interface Curve {
  ax: number;
  ay: number;
  cx: number;
  cy: number;
  bx: number;
  by: number;
  len: number;
  heatAt: number;
  drift: number;
}

interface Packet {
  curve: Curve;
  target: Cluster;
  t0: number;
  n: number;
  big: boolean;
  seed: number;
  done: boolean;
}

/** Deterministic noise so a reload draws the same clusters. */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Light from the upper left and a little toward the viewer.
const LIGHT = (() => {
  const v = [-0.55, -0.62, 0.56];
  const l = Math.hypot(v[0], v[1], v[2]);
  return v.map((c) => c / l);
})();

/** Lit-from-the-upper-left shade of a point on a unit disc: 0 lit .. 1 shadow (same rule as the clusters). */
function shadeAt(x: number, y: number) {
  const d = Math.min(1, Math.hypot(x, y));
  const z = Math.sqrt(1 - d * d);
  const lum = (x * LIGHT[0] + y * LIGHT[1] + z * LIGHT[2] + 1) / 2;
  return Math.pow(1 - lum, 1.15);
}

// ---------- MediaPipe wireframe ----------

/** A neutral face in lip.mesh order, shown faintly until the first frame arrives. */
function restingMesh(): Float32Array {
  const a = new Float32Array(MESH_LEN);
  const put = (i: number, x: number, y: number) => {
    a[2 * i] = x;
    a[2 * i + 1] = Math.min(255, Math.max(0, y));
  };
  // Lips: left corner, along the lower lip to the right corner, back along the upper lip.
  for (let i = 0; i < 20; i++) {
    const c = -Math.cos((Math.PI * i) / 10);
    const s = Math.sin((Math.PI * i) / 10);
    put(i, 128 + 31 * c, 168 + (s > 0 ? 13 : 11) * s);
    put(20 + i, 128 + 26 * c, 168 + 1.2 * s);
  }
  // Face oval, clockwise from the top of the forehead (clamped like the live frames).
  for (let i = 0; i < 36; i++) {
    const th = (2 * Math.PI * i) / 36;
    put(40 + i, 128 + 89 * Math.sin(th) * (1 + 0.09 * Math.cos(th)), 98 - 118 * Math.cos(th));
  }
  put(76, 69, 67);
  put(77, 107, 70);
  put(78, 149, 70);
  put(79, 187, 67);
  put(80, 128, 128);
  return a;
}

const WIRE_PAD = 5;
const WIRE_DOT_ALPHA = [1, 0.78, 0.56];

/** Draws one wireframe frame. `p` holds 81 points in 0..255; the context is in device px of a `px` square. */
function drawWire(c: CanvasRenderingContext2D, px: number, p: Float32Array, alpha: number) {
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, px, px);
  const k = px / WIRE;
  c.setTransform(k, 0, 0, k, 0, 0);
  const span = (WIRE - 2 * WIRE_PAD) / 255;
  const X = (i: number) => WIRE_PAD + p[2 * i] * span;
  const Y = (i: number) => WIRE_PAD + p[2 * i + 1] * span;
  const ring = (from: number, count: number) => {
    const path = new Path2D();
    path.moveTo(X(from), Y(from));
    for (let i = 1; i < count; i++) path.lineTo(X(from + i), Y(from + i));
    path.closePath();
    return path;
  };
  c.globalAlpha = alpha;
  c.lineJoin = 'round';
  c.lineCap = 'round';

  // Face oval: the light outline the features sit in. Points clamped to the frame edge (usually the top of
  // the forehead) are not real positions, so the outline breaks there and reads as cropped, not flattened.
  const clamped = (i: number) => {
    const x = p[2 * i];
    const y = p[2 * i + 1];
    return x <= 0.5 || x >= 254.5 || y <= 0.5 || y >= 254.5;
  };
  const oval = new Path2D();
  let pen = false;
  for (let j = 0; j <= 36; j++) {
    const i = 40 + (j % 36);
    if (clamped(i)) {
      pen = false;
      continue;
    }
    if (pen) oval.lineTo(X(i), Y(i));
    else oval.moveTo(X(i), Y(i));
    pen = true;
  }
  c.strokeStyle = 'rgba(203, 215, 230, 0.6)';
  c.lineWidth = 1.4;
  c.stroke(oval);

  // Eyes: two short strokes.
  c.strokeStyle = 'rgba(32, 62, 104, 0.55)';
  c.lineWidth = 1.2;
  c.beginPath();
  c.moveTo(X(76), Y(76));
  c.lineTo(X(77), Y(77));
  c.moveTo(X(78), Y(78));
  c.lineTo(X(79), Y(79));
  c.stroke();

  // Lips: the outer ring tinted, the opening between the inner ring filled navy.
  const outer = ring(0, 20);
  const inner = ring(20, 20);
  c.fillStyle = 'rgba(32, 62, 104, 0.08)';
  c.fill(outer);
  c.fillStyle = 'rgba(32, 62, 104, 0.72)';
  c.fill(inner);
  c.strokeStyle = '#203e68';
  c.lineWidth = 1.25;
  c.stroke(outer);
  c.lineWidth = 0.9;
  c.stroke(inner);

  // A dot at every vertex, lit from the upper left: smaller and lighter toward the light.
  const paths = [new Path2D(), new Path2D(), new Path2D()];
  for (let i = 0; i < 81; i++) {
    if (i >= 40 && i < 76 && clamped(i)) continue;
    const x = X(i);
    const y = Y(i);
    const sh = shadeAt((p[2 * i] - 128) / 112, (p[2 * i + 1] - 112) / 124);
    const lip = i < 40;
    const s = (lip ? 0.95 : 0.8) + (lip ? 1.15 : 1.05) * sh + (i === 80 ? 0.9 : 0);
    const band = lip || i === 80 ? (sh > 0.35 ? 0 : 1) : sh > 0.5 ? 0 : sh > 0.25 ? 1 : 2;
    paths[band].moveTo(x + s, y);
    paths[band].arc(x, y, s, 0, Math.PI * 2);
  }
  c.fillStyle = '#203e68';
  for (let b = 0; b < 3; b++) {
    c.globalAlpha = alpha * WIRE_DOT_ALPHA[b];
    c.fill(paths[b]);
  }
  c.globalAlpha = 1;
}

function buildCluster(def: NodeDef, index: number): Cluster {
  const rand = mulberry(1013 * (index + 1));
  const n = def.n;
  const halo = Math.round(n * 0.12);
  const total = n + halo;
  const dx = new Float32Array(total);
  const dy = new Float32Array(total);
  const rr = new Float32Array(total);
  const size = new Float32Array(total);
  const tone = new Uint8Array(total);
  const ph = new Float32Array(total);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const big = def.id === 'claude';
  const sMin = big ? 1.05 : 0.9;
  const sMax = big ? 3.4 : 2.7;
  for (let i = 0; i < total; i++) {
    let x: number;
    let y: number;
    if (i < n) {
      // Sunflower disc, jittered: reads as a sphere once shaded.
      const k = Math.sqrt((i + 0.5) / n);
      const a = i * golden;
      const j = (rand() - 0.5) * 0.09;
      x = Math.cos(a) * (k + j);
      y = Math.sin(a) * (k + j);
    } else {
      // A sparse halo just outside the rim, like the head's mist.
      const a = rand() * Math.PI * 2;
      const k = 1.04 + rand() * 0.24;
      x = Math.cos(a) * k;
      y = Math.sin(a) * k;
    }
    const d = Math.hypot(x, y);
    const z = Math.sqrt(Math.max(0, 1 - Math.min(1, d) ** 2));
    const lum = (x * LIGHT[0] + y * LIGHT[1] + z * LIGHT[2] + 1) / 2; // 0 shadow .. 1 lit
    const shade = Math.pow(1 - lum, 1.15);
    dx[i] = x * def.r;
    dy[i] = y * def.r;
    rr[i] = d * def.r;
    ph[i] = rand() * Math.PI * 2;
    if (i >= n) {
      size[i] = 0.7 + rand() * 0.6;
      tone[i] = rand() < 0.6 ? 2 : 3;
      continue;
    }
    size[i] = (sMin + (sMax - sMin) * shade) * (0.82 + rand() * 0.36);
    const t = lum + (rand() - 0.5) * 0.16;
    tone[i] = t < 0.5 ? 0 : t < 0.64 ? 1 : t < 0.8 ? 2 : 3;
  }
  return { def, dx, dy, rr, size, tone, ph, phase: index * 1.7, glowAt: -1e9, glowAmp: 0, rippleAt: -1e9, haloAt: -1e9 };
}

function makeCurve(a: NodeDef, b: NodeDef, bend: number): Curve {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const L = Math.hypot(vx, vy) || 1;
  // Perpendicular, so a reverse edge with the same bend bows to the other side (two lanes).
  const cx = mx + (-vy / L) * bend * L;
  const cy = my + (vx / L) * bend * L;
  const ua = Math.hypot(cx - a.x, cy - a.y) || 1;
  const ub = Math.hypot(cx - b.x, cy - b.y) || 1;
  const ax = a.x + ((cx - a.x) / ua) * a.r * 1.08;
  const ay = a.y + ((cy - a.y) / ua) * a.r * 1.08;
  const bx = b.x + ((cx - b.x) / ub) * b.r * 1.08;
  const by = b.y + ((cy - b.y) / ub) * b.r * 1.08;
  let len = 0;
  let px = ax;
  let py = ay;
  for (let i = 1; i <= 24; i++) {
    const t = i / 24;
    const q = 1 - t;
    const x = q * q * ax + 2 * q * t * cx + t * t * bx;
    const y = q * q * ay + 2 * q * t * cy + t * t * by;
    len += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return { ax, ay, cx, cy, bx, by, len, heatAt: -1e9, drift: Math.random() };
}

function pointOn(c: Curve, t: number, out: { x: number; y: number }) {
  const q = 1 - t;
  out.x = q * q * c.ax + 2 * q * t * c.cx + t * t * c.bx;
  out.y = q * q * c.ay + 2 * q * t * c.cy + t * t * c.by;
}

/** cubic-bezier(0.23, 1, 0.32, 1), the --ease-out token, solved for x by bisection. */
function easeOut(x: number) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let lo = 0;
  let hi = 1;
  let t = x;
  for (let i = 0; i < 14; i++) {
    t = (lo + hi) / 2;
    const q = 1 - t;
    const bx = 3 * q * q * t * 0.23 + 3 * q * t * t * 0.32 + t * t * t;
    if (bx < x) lo = t;
    else hi = t;
  }
  const q = 1 - t;
  return 3 * q * q * t * 1 + 3 * q * t * t * 1 + t * t * t;
}

interface Engine {
  fire(e: TelemetryEvent): void;
  setLine(text: string): void;
  reset(): void;
  destroy(): void;
}

interface EngineIO {
  /** the span Claude's line types into */
  line: () => HTMLElement | null;
  /** the MediaPipe card's wireframe canvas */
  wire: () => HTMLCanvasElement | null;
  /** the live card model (read for lip.mesh and audio.spectrum) */
  model: () => Model;
}

/**
 * The Audio cluster as a radial equaliser: each dot maps its angle to one of the 32 bands (mirrored left and
 * right, low bands at the top) and is pushed outward by that band's level. One spring per band carries the
 * motion, so every dot on a band moves together and the shape stays coherent.
 */
interface Equaliser {
  /** per dot: its band 0..31, radial weight (with a little per-dot variety), unit direction */
  band: Uint8Array;
  weight: Float32Array;
  ux: Float32Array;
  uy: Float32Array;
  target: Float32Array;
  pos: Float32Array;
  vel: Float32Array;
  floor: Float32Array;
  floorSet: boolean;
  rms: { target: number; pos: number; vel: number };
  seen: unknown;
  live: boolean;
}

function buildEqualiser(cl: Cluster): Equaliser {
  const len = cl.dx.length;
  const band = new Uint8Array(len);
  const weight = new Float32Array(len);
  const ux = new Float32Array(len);
  const uy = new Float32Array(len);
  const r = cl.def.r;
  for (let i = 0; i < len; i++) {
    const rr = cl.rr[i] || 1e-3;
    ux[i] = cl.dx[i] / rr;
    uy[i] = cl.dy[i] / rr;
    // 0 at the top, pi at the bottom, the same on both sides
    const phi = Math.atan2(Math.abs(cl.dx[i]), -cl.dy[i]);
    band[i] = Math.min(SPEC_BINS - 1, Math.floor((phi / Math.PI) * SPEC_BINS));
    const d = Math.min(1.3, rr / r);
    // the core barely moves, the rim carries the shape; per-dot variety from the cluster's own phase
    weight[i] = (0.1 + 0.9 * Math.pow(Math.min(1, d), 2) + (d > 1 ? 0.1 : 0)) * (0.88 + 0.24 * ((cl.ph[i] / (Math.PI * 2)) % 1));
  }
  return {
    band,
    weight,
    ux,
    uy,
    target: new Float32Array(SPEC_BINS),
    pos: new Float32Array(SPEC_BINS),
    vel: new Float32Array(SPEC_BINS),
    floor: new Float32Array(SPEC_BINS),
    floorSet: false,
    rms: { target: 0, pos: 0, vel: 0 },
    seen: null,
    live: false,
  };
}

function createEngine(canvas: HTMLCanvasElement, stage: HTMLElement, io: EngineIO, reduce: boolean): Engine {
  const ctx = canvas.getContext('2d')!;
  const clusters = NODES.map(buildCluster);
  const byId = Object.fromEntries(clusters.map((c) => [c.def.id, c])) as Record<NodeId, Cluster>;
  const eq = buildEqualiser(byId.audio);
  const scratch = new Float32Array(SPEC_BINS);
  // Face canvas: positions ease from where they are toward each new frame over MESH_LERP_MS. v2 frames drive the
  // dot face (the canonical face until the first one), v1 frames the wireframe; the newest version decides.
  const wFrom = restingMesh();
  const wTo = wFrom.slice();
  const wCur = wFrom.slice();
  const dotFace = createDotFace(FACE_BOX, FACE_PAD);
  const fFrom = canonicalFace();
  const fTo = fFrom.slice();
  const fCur = fFrom.slice();
  let wMode: 1 | 2 = 2;
  let wT0 = -1e9;
  let wSeen: unknown = null;
  let wEl: HTMLCanvasElement | null = null;
  let wCtx: CanvasRenderingContext2D | null = null;
  let wAlpha = 0.25;
  let wDrawnAlpha = -1;
  let wDrawnK = -1;
  let wDirty = true;
  let prevNow = 0;
  const curves = new Map<string, Curve>();
  for (const [s, t, bend] of EDGES) curves.set(`${s}>${t}`, makeCurve(NODE[s], NODE[t], bend));
  const curveFor = (s: NodeId, t: NodeId) => {
    const key = `${s}>${t}`;
    let c = curves.get(key);
    if (!c && NODE[s] && NODE[t] && s !== t) {
      c = makeCurve(NODE[s], NODE[t], 0.1);
      curves.set(key, c);
    }
    return c;
  };
  const staticLayer = document.createElement('canvas');
  const sctx = staticLayer.getContext('2d')!;
  let packets: Packet[] = [];
  let scale = 1;
  let ox = 0;
  let oy = 0;
  let dpr = 1;
  let raf = 0;
  let dirtyUntil = 0;
  let line = '';
  let lineAt = 0;
  let lineShown = -1;
  const pt = { x: 0, y: 0 };

  const drawStatic = () => {
    staticLayer.width = canvas.width;
    staticLayer.height = canvas.height;
    sctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
    sctx.clearRect(-ox / scale, -oy / scale, canvas.width, canvas.height);
    for (const [s, t] of EDGES) {
      const c = curves.get(`${s}>${t}`)!;
      const steps = Math.max(4, Math.round(c.len / 7.5));
      sctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        pointOn(c, i / steps, pt);
        const r = 1.05 + 0.25 * Math.sin(i * 1.7);
        sctx.moveTo(pt.x + r, pt.y);
        sctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      }
      sctx.fillStyle = '#cbd7e6';
      sctx.fill();
    }
  };

  const resize = () => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    scale = Math.min(vw / W, vh / H);
    ox = (vw - W * scale) / 2;
    oy = (vh - H * scale) / 2;
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;
    stage.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
    drawStatic();
    wDirty = true;
    dirtyUntil = performance.now() + 50;
  };

  const halo = (x: number, y: number, r0: number, r1: number, alpha: number) => {
    if (alpha <= 0.004) return;
    const g = ctx.createRadialGradient(x, y, r0, x, y, r1);
    g.addColorStop(0, `rgba(203, 215, 230, ${alpha})`);
    g.addColorStop(1, 'rgba(203, 215, 230, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r1, 0, Math.PI * 2);
    ctx.fill();
  };

  /** Folds the newest audio.spectrum into the band targets and steps the springs. */
  const stepEqualiser = (now: number, dt: number) => {
    const sp = io.model().spectrum;
    if (sp && sp !== eq.seen) {
      eq.seen = sp;
      // Gate against a slowly adapting noise floor so a quiet room rests flat.
      for (let k = 0; k < SPEC_BINS; k++) {
        const v = sp.bins[k];
        const f = eq.floorSet ? eq.floor[k] : v;
        eq.floor[k] = v < f ? v : f + (v - f) * 0.01;
        // a gentle curve keeps the valleys between formants low, so the peaks read as lobes
        scratch[k] = Math.pow(clamp01((v - eq.floor[k] - 0.04) / Math.max(0.2, 0.96 - eq.floor[k])), 1.4);
      }
      eq.floorSet = true;
      for (let k = 0; k < SPEC_BINS; k++) {
        const a = scratch[Math.max(0, k - 1)];
        const b = scratch[Math.min(SPEC_BINS - 1, k + 1)];
        eq.target[k] = 0.15 * a + 0.7 * scratch[k] + 0.15 * b;
      }
      eq.rms.target = clamp01(sp.rms / RMS_FULL);
      dirtyUntil = Math.max(dirtyUntil, now + 50);
    }
    const live = sp !== null && now - sp.at < PERCEPT_MS;
    if (!live && eq.live) {
      eq.target.fill(0);
      eq.rms.target = 0;
    }
    if (live !== eq.live) {
      eq.live = live;
      dirtyUntil = Math.max(dirtyUntil, now + 50);
    }
    if (reduce) {
      eq.pos.set(eq.target);
      eq.vel.fill(0);
      eq.rms.pos = eq.rms.target;
      return;
    }
    // Semi-implicit Euler, in two substeps so a slow frame stays stable.
    const h = dt / 2;
    for (let s = 0; s < 2; s++) {
      for (let k = 0; k < SPEC_BINS; k++) {
        eq.vel[k] += (SPRING_K * (eq.target[k] - eq.pos[k]) - SPRING_C * eq.vel[k]) * h;
        eq.pos[k] += eq.vel[k] * h;
      }
      const q = eq.rms;
      q.vel += (SPRING_K * (q.target - q.pos) - SPRING_C * q.vel) * h;
      q.pos += q.vel * h;
    }
  };

  /** Eases the face toward the newest lip.mesh and redraws its canvas only when something moved. */
  const stepWire = (now: number, dtMs: number) => {
    const el = io.wire();
    if (el !== wEl) {
      wEl = el;
      wCtx = el ? el.getContext('2d') : null;
      wDirty = true;
    }
    if (!wEl || !wCtx) return;
    const px = Math.max(1, Math.round(FACE_BOX * scale * dpr));
    if (wEl.width !== px || wEl.height !== px) {
      wEl.width = px;
      wEl.height = px;
      wDirty = true;
    }
    const mesh = io.model().mesh;
    if (mesh && mesh !== wSeen) {
      wSeen = mesh;
      if (mesh.v === 2) {
        fFrom.set(fCur);
        fTo.set(mesh.xyz);
      } else {
        wFrom.set(wCur);
        for (let i = 0; i < MESH_LEN; i++) wTo[i] = mesh.pts[i];
      }
      wMode = mesh.v;
      wT0 = now;
      wDirty = true;
    }
    const live = mesh !== null && now - mesh.at < PERCEPT_MS;
    const aim = live ? 1 : 0.25;
    if (reduce) wAlpha = aim;
    else {
      wAlpha += (aim - wAlpha) * (1 - Math.exp(-dtMs / 140));
      if (Math.abs(aim - wAlpha) < 0.004) wAlpha = aim;
    }
    const k = reduce ? 1 : Math.min(1, Math.max(0, (now - wT0) / MESH_LERP_MS));
    if (!wDirty && k === wDrawnK && wAlpha === wDrawnAlpha) return;
    if (wMode === 2) {
      for (let i = 0; i < fCur.length; i++) fCur[i] = fFrom[i] + (fTo[i] - fFrom[i]) * k;
      dotFace.draw(wCtx, px, fCur, wAlpha);
    } else {
      for (let i = 0; i < MESH_LEN; i++) wCur[i] = wFrom[i] + (wTo[i] - wFrom[i]) * k;
      drawWire(wCtx, px, wCur, wAlpha);
    }
    wDrawnK = k;
    wDrawnAlpha = wAlpha;
    wDirty = false;
  };

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dtMs = Math.min(100, Math.max(0, now - prevNow));
    prevNow = now;
    const el = io.line();
    if (el) {
      const shown = reduce ? line.length : Math.min(line.length, Math.floor((now - lineAt) / CHAR_MS));
      if (shown !== lineShown) {
        lineShown = shown;
        el.textContent = line.slice(0, shown);
        el.dataset.typing = shown < line.length ? 'true' : 'false';
      }
    }
    stepWire(now, dtMs);
    stepEqualiser(now, Math.min(1 / 30, dtMs / 1000));
    if (reduce && now > dirtyUntil) return;
    const t = reduce ? 0 : now / 1000;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(staticLayer, 0, 0);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);

    // Idle streams: a few dots drift along every edge; recently used edges run darker.
    for (const c of curves.values()) {
      const heat = Math.exp(-(now - c.heatAt) / 2600);
      ctx.globalAlpha = 0.22 + 0.6 * heat;
      ctx.beginPath();
      const count = c.len > 300 ? 4 : 3;
      for (let i = 0; i < count; i++) {
        const u = (c.drift + i / count + t * (24 / c.len)) % 1;
        pointOn(c, u, pt);
        const r = 1.5 + heat * 0.6;
        ctx.moveTo(pt.x + r, pt.y);
        ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      }
      ctx.fillStyle = heat > 0.3 ? '#3b5884' : '#9fb1c9';
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Halos behind clusters that just fired, and Claude's breathing light.
    for (const cl of clusters) {
      const { x, y, r } = cl.def;
      const g = cl.glowAmp * Math.exp(-(now - cl.glowAt) / 480);
      if (g > 0.01) halo(x, y, r * 0.4, r * 1.9, 0.55 * g);
      if (cl.def.id === 'claude') {
        halo(x, y, r * 0.6, r * 1.75, reduce ? 0.32 : 0.26 + 0.08 * Math.sin(t * 0.9));
        const k = (now - cl.haloAt) / HALO_MS;
        if (k >= 0 && k < 1 && !reduce) {
          const e = easeOut(k);
          const ring = r * (1.05 + 0.85 * e);
          const a = 0.5 * (1 - k) * (1 - k);
          const gr = ctx.createRadialGradient(x, y, ring * 0.8, x, y, ring * 1.12);
          gr.addColorStop(0, 'rgba(203, 215, 230, 0)');
          gr.addColorStop(0.55, `rgba(160, 182, 210, ${a})`);
          gr.addColorStop(1, 'rgba(203, 215, 230, 0)');
          ctx.fillStyle = gr;
          ctx.beginPath();
          ctx.arc(x, y, ring * 1.12, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Clusters, batched into one path per tone.
    const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    for (const cl of clusters) {
      const { x: cx, y: cy, r } = cl.def;
      const g = cl.glowAmp * Math.exp(-(now - cl.glowAt) / 480);
      const isEq = cl === byId.audio;
      // The audio cluster also swells with the voice's loudness.
      const loud = isEq && !reduce ? Math.max(-0.1, eq.rms.pos) : 0;
      const breath = 1 + (0.022 + 0.03 * loud) * Math.sin(t * 1.05 + cl.phase) + 0.09 * loud;
      const push = r * 0.6;
      const wob = reduce ? 0 : r * 0.012 + 0.35;
      const rAge = now - cl.rippleAt;
      const rip = !reduce && rAge >= 0 && rAge < RIPPLE_MS;
      const rk = rip ? rAge / RIPPLE_MS : 0;
      const front = r * 1.3 * easeOut(rk);
      const amp = rip ? (1 - rk) * r * 0.11 : 0;
      const wide = r * 0.22;
      const darken = g > 0.72 ? 2 : g > 0.3 ? 1 : 0;
      const grow = 1 + 0.32 * g;
      const len = cl.dx.length;
      for (let i = 0; i < len; i++) {
        let x = cx + cl.dx[i] * breath;
        let y = cy + cl.dy[i] * breath;
        if (wob) {
          const p = cl.ph[i];
          x += wob * Math.sin(t * 0.8 + p);
          y += wob * Math.cos(t * 0.67 + p * 1.3);
        }
        if (rip && cl.rr[i] > 0.5) {
          const dd = (cl.rr[i] - front) / wide;
          const push = amp * Math.exp(-dd * dd);
          x += (cl.dx[i] / cl.rr[i]) * push;
          y += (cl.dy[i] / cl.rr[i]) * push;
        }
        let s = cl.size[i] * grow;
        let tone = Math.max(0, cl.tone[i] - darken);
        if (isEq) {
          // one band per angular sector, so the rim steps like equaliser bars
          const level = Math.max(-0.12, eq.pos[eq.band[i]]) * eq.weight[i];
          if (level > 0.002 || level < -0.002) {
            x += eq.ux[i] * level * push;
            y += eq.uy[i] * level * push;
            // dots flung outward read lighter and smaller, like the halo
            if (level > 0.08) {
              s *= 1 - 0.28 * Math.min(1, level);
              if (level > 0.4) tone = Math.min(3, tone + 1);
            }
          }
        }
        const path = paths[tone];
        path.moveTo(x + s, y);
        path.arc(x, y, s, 0, Math.PI * 2);
      }
    }
    for (let k = 0; k < 4; k++) {
      ctx.globalAlpha = TONE_ALPHA[k];
      ctx.fillStyle = TONES[k];
      ctx.fill(paths[k]);
    }
    ctx.globalAlpha = 1;

    // Packets in flight.
    if (packets.length) {
      const front = new Path2D();
      const tail = new Path2D();
      for (const p of packets) {
        const age = now - p.t0;
        const k = reduce ? 1 : Math.min(1, age / PACKET_MS);
        if (k >= 1 && !p.done) {
          p.done = true;
          p.target.rippleAt = now;
          if (p.target.glowAmp * Math.exp(-(now - p.target.glowAt) / 480) < 0.55) {
            p.target.glowAt = now;
            p.target.glowAmp = p.big ? 0.6 : 0.4;
          }
        }
        if (reduce) continue;
        const e = easeOut(k);
        const fade = k >= 1 ? Math.max(0, 1 - (age - PACKET_MS) / 220) : 1;
        if (fade <= 0) continue;
        const rand = mulberry(p.seed);
        for (let i = 0; i < p.n; i++) {
          const u = e - i * (p.big ? 0.028 : 0.035) * (0.4 + 0.6 * (1 - k));
          if (u < 0) continue;
          pointOn(p.curve, Math.min(1, u), pt);
          const jx = (rand() - 0.5) * 4;
          const jy = (rand() - 0.5) * 4;
          const s = ((p.big ? 2.5 : 1.9) - i * 0.12) * fade;
          if (s <= 0.3) continue;
          const path = i < 3 ? front : tail;
          path.moveTo(pt.x + jx + s, pt.y + jy);
          path.arc(pt.x + jx, pt.y + jy, s, 0, Math.PI * 2);
        }
      }
      ctx.fillStyle = '#203e68';
      ctx.fill(front);
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = '#5a76a0';
      ctx.fill(tail);
      ctx.globalAlpha = 1;
      packets = packets.filter((p) => now - p.t0 < PACKET_MS + 260);
    }
  };

  resize();
  window.addEventListener('resize', resize);
  document.addEventListener('fullscreenchange', resize);
  raf = requestAnimationFrame(frame);

  return {
    fire(e) {
      if (PERCEPT.has(e.kind)) return; // drawn in place by stepWire / stepEqualiser
      const now = performance.now();
      const src = byId[e.source];
      const dst = byId[e.target];
      if (src) {
        src.glowAt = now;
        src.glowAmp = 1;
      }
      if (src && dst && e.kind === 'claude.response') src.haloAt = now;
      const c = src && dst ? curveFor(e.source, e.target) : undefined;
      if (c && dst) {
        c.heatAt = now;
        const quiet = QUIET.has(e.kind);
        packets.push({ curve: c, target: dst, t0: now, n: quiet ? 5 : 11, big: !quiet, seed: (Math.random() * 1e9) | 0, done: false });
        if (packets.length > 140) packets.splice(0, packets.length - 140);
        // The microphone feeds the analyser that reports audio frames.
        if (e.kind === 'audio.frame') {
          const mc = curveFor('mic', 'audio');
          if (mc) {
            mc.heatAt = now;
            packets.push({ curve: mc, target: byId.audio, t0: now - 120, n: 4, big: false, seed: (Math.random() * 1e9) | 0, done: false });
          }
        }
      }
      dirtyUntil = now + 900;
    },
    setLine(text) {
      line = text;
      lineAt = performance.now();
      lineShown = -1;
      dirtyUntil = performance.now() + 50;
    },
    reset() {
      packets = [];
      for (const c of clusters) {
        c.glowAt = -1e9;
        c.rippleAt = -1e9;
        c.haloAt = -1e9;
      }
      for (const c of curves.values()) c.heatAt = -1e9;
      line = '';
      lineShown = -1;
      dirtyUntil = performance.now() + 50;
    },
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      document.removeEventListener('fullscreenchange', resize);
    },
  };
}

// ---------- cards ----------

const hz = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v)}`);
const fmt = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('en-US'));

/** 32 bars (the live spectrum, or the rms-ring envelope) and an rms level meter at the right. */
function Spark({ bars, level }: { bars: number[]; level: number | null }) {
  const list = bars.length ? bars : Array.from({ length: SPEC_BINS }, () => 0);
  return (
    <svg className="dash-spark" viewBox="0 0 140 30" preserveAspectRatio="none" aria-hidden="true">
      {list.map((v, i) => (
        <rect
          key={i}
          className="dash-spark__bar"
          x={i * 4 + 0.5}
          y={2}
          width={2.6}
          height={28}
          rx={1}
          style={{ transform: `scaleY(${Math.max(1 / 28, clamp01(v)).toFixed(3)})` }}
        />
      ))}
      <rect className="dash-spark__track" x={133} y={2} width={6} height={28} rx={1.5} />
      <rect
        className="dash-spark__level"
        x={133}
        y={2}
        width={6}
        height={28}
        rx={1.5}
        style={{ transform: `scaleY(${clamp01(level ?? 0).toFixed(3)})` }}
      />
    </svg>
  );
}

const SPARC_LABELS = ['tongue height', 'tongue front', 'jaw open', 'lip forward', 'lip aperture'];

function Detail({ id, s, wireRef }: { id: NodeId; s: Snap; wireRef: RefObject<HTMLCanvasElement> }): ReactNode {
  switch (id) {
    case 'camera':
      return <p className="dash-status" data-on={s.cameraState === 'on' || undefined}>{s.cameraState}</p>;
    case 'mic':
      return <p className="dash-status" data-on={s.micState === 'listening' || undefined}>{s.micState}</p>;
    case 'mediapipe':
      return (
        <div className="dash-card dash-card--mesh">
          {/* drawn by the canvas engine from lip.mesh (dot face, or the v1 wireframe); sized for the device in stepWire */}
          <canvas ref={wireRef} className="dash-wire" data-live={s.meshLive || undefined} aria-hidden="true" />
          <dl className="dash-kv">
            <div><dt>open</dt><dd>{s.lip ? s.lip.opening.toFixed(2) : '—'}</dd></div>
            <div><dt>wide</dt><dd>{s.lip ? s.lip.width.toFixed(2) : '—'}</dd></div>
            <div><dt>round</dt><dd>{s.lip ? s.lip.rounding.toFixed(2) : '—'}</dd></div>
            <div><dt>face</dt><dd data-warn={s.lip && !s.lip.ok ? 'true' : undefined}>{s.lip ? (s.lip.ok ? 'ok' : 'lost') : '—'}</dd></div>
          </dl>
          <p className="dash-meta">
            {s.faceState === 'mesh' ? `face mesh · ${s.meshPoints} points` : s.faceState === 'tracking' ? 'tracking · mesh unavailable' : 'no face'}
          </p>
        </div>
      );
    case 'audio': {
      const rms = s.spectrum ? s.spectrum.rms : s.audio ? s.audio.rms : null;
      return (
        <div className="dash-card">
          <Spark bars={s.spectrum ? s.spectrum.bins : s.audio?.env ?? []} level={rms == null ? null : rms / RMS_FULL} />
          <p className="dash-readout">
            <span>F1 <b>{hz(s.audio?.f1)}</b></span>
            <span>F2 <b>{hz(s.audio?.f2)}</b></span>
            <span className="dash-unit dash-unit--inline">Hz</span>
            <span className="dash-rms">rms <b>{rms == null ? '—' : rms.toFixed(2)}</b></span>
          </p>
          {!s.audio && <p className="dash-meta">F1/F2 during practice attempts</p>}
        </div>
      );
    }
    case 'stt':
      return (
        <div className="dash-card">
          <p className="dash-quote" data-final={s.stt?.final ? 'true' : 'false'}>
            {s.stt?.text ? `“${s.stt.text}”` : <span className="dash-dim">no speech yet</span>}
          </p>
          <p className="dash-meta">
            {s.stt ? (s.stt.final ? 'final' : 'partial') : 'waiting'}
            {s.sttProvider ? ` · ${STT_NAME[s.sttProvider]}` : ''}
          </p>
        </div>
      );
    case 'tts':
      return (
        <div className="dash-card">
          <p className="dash-readout">
            <span><b>{s.tts ? fmt(s.tts.chars) : '—'}</b> chars</span>
            <span>voice <b>{s.tts?.voice ?? '—'}</b></span>
          </p>
          <p className="dash-meta">{s.tts?.ms != null ? `${(s.tts.ms / 1000).toFixed(1)} s of audio` : 'waiting'}</p>
        </div>
      );
    case 'backend':
      return (
        <div className="dash-card">
          <p className="dash-big">
            {s.backendRpm}
            <span> req / min</span>
          </p>
          <p className="dash-meta">{s.backendOut} calls out / min</p>
          {s.backendUp && (
            <>
              <p className="dash-meta">
                coach: {s.backendUp.provider ?? '—'} · {s.backendUp.model ?? '—'}
              </p>
              <p className="dash-meta">
                SPARC {s.backendUp.articulation == null ? '—' : s.backendUp.articulation ? 'on' : 'off'} · pitch table{' '}
                {s.backendUp.pitchTable == null ? '—' : s.backendUp.pitchTable ? 'on' : 'off'}
              </p>
            </>
          )}
        </div>
      );
    case 'pitch': {
      const pt = s.pitch;
      const formants = pt != null && (pt.f1 != null || pt.f2 != null);
      // with formants the Hz unit sits on their row and the method leads the meta line
      const meta = pt
        ? [formants ? null : 'Hz', s.pitchMethod, pt.voiced != null ? `${Math.round(pt.voiced)}% voiced` : null, pt.latency != null ? `${Math.round(pt.latency)} ms` : null]
        : ['waiting', s.pitchMethod];
      return (
        <div className="dash-card">
          <p className="dash-readout">
            <span>mean <b>{hz(pt?.mean)}</b></span>
            <span>min <b>{hz(pt?.min)}</b></span>
            <span>max <b>{hz(pt?.max)}</b></span>
          </p>
          {formants && (
            <p className="dash-readout">
              <span>F1 <b>{hz(pt.f1)}</b></span>
              <span>F2 <b>{hz(pt.f2)}</b></span>
              <span className="dash-unit">Hz</span>
            </p>
          )}
          <p className="dash-meta">{meta.filter(Boolean).join(' · ')}</p>
        </div>
      );
    }
    case 'sparc': {
      const feats = s.sparc.feats;
      if (!feats) {
        const noCollector = s.backendUp?.articulation === false && !s.sparc.seen;
        return (
          <div className="dash-card">
            <p className="dash-standby" data-small={noCollector || undefined}>
              {noCollector ? 'standby · no collector' : s.sparc.skipped ? 'standby' : 'waiting'}
            </p>
            {!noCollector && s.sparc.skipped && <p className="dash-meta">skipped · {s.sparc.skipped}</p>}
          </div>
        );
      }
      return (
        <div className="dash-card" data-stale={s.sparc.skipped ? 'true' : undefined}>
          <ul className="dash-bars">
            {feats.map((v, i) => (
              <li key={SPARC_LABELS[i]}>
                <span>{SPARC_LABELS[i]}</span>
                {/* centred on zero: right for positive, left for negative, full at ±SPARC_RANGE */}
                <i style={{ '--v': Math.min(1, Math.max(-1, v / SPARC_RANGE)).toFixed(3) } as CSSProperties} />
                <b>{v > 0 ? '+' : ''}{v.toFixed(2)}</b>
              </li>
            ))}
          </ul>
          <p className="dash-meta">
            {s.sparc.skipped ? `standby · ${s.sparc.skipped}` : s.sparc.latency != null ? `${Math.round(s.sparc.latency)} ms` : ''}
          </p>
        </div>
      );
    }
    case 'db':
      return (
        <div className="dash-card">
          <p className="dash-readout">
            <span><b>{s.dbReads}</b> reads</span>
            <span><b>{s.dbWrites}</b> writes</span>
          </p>
          <p className="dash-meta">{s.dbTable ? `last · ${s.dbTable}` : 'per minute'}</p>
        </div>
      );
    case 'ui':
      return (
        <div className="dash-card">
          <p className="dash-readout">
            <span>coach <b>{s.ui.verdict ?? '—'}</b></span>
            <span>lips <b>{s.ui.score ?? '—'}</b></span>
          </p>
          <p className="dash-meta">{s.ui.cue ? `cue · ${s.ui.cue}` : 'waiting'}</p>
        </div>
      );
    default:
      return null;
  }
}

function Presence({ dots }: { dots: Snap['dots'] }) {
  if (!dots.length) return null;
  const shown = dots.slice(0, MAX_DOTS);
  const extra = dots.filter((d) => !d.leaving).length - shown.filter((d) => !d.leaving).length;
  return (
    <div className="dash-presence" aria-hidden="true">
      {shown.map((d) => (
        <i key={d.sid} className="dash-presence__dot" data-leaving={d.leaving || undefined} />
      ))}
      {extra > 0 && <span className="dash-presence__more">+{extra}</span>}
    </div>
  );
}

/** The tag beside a node's name: the coach model and speech to text follow the provider that last answered. */
function locOf(n: NodeDef, s: Snap): Loc {
  if (n.id === 'claude') return s.coachProvider ? PROVIDER_TAG[s.coachProvider] : n.loc;
  if (n.id === 'stt') return s.sttProvider ? STT_TAG[s.sttProvider] : n.loc;
  return n.loc;
}

function ClaudeCard({ s, lineRef }: { s: Snap; lineRef: RefObject<HTMLSpanElement> }) {
  const c = s.claude;
  return (
    <div className="dash-card dash-card--claude">
      <div className="dash-claude__top">
        <span className="dash-chip">{c?.model ?? s.backendUp?.model ?? 'model —'}</span>
        <span className="dash-chip dash-chip--line">{s.coachProvider ? PROVIDER_TAG[s.coachProvider] : 'provider —'}</span>
        <span className="dash-chip dash-chip--soft">{c?.purpose ?? 'idle'}</span>
      </div>
      <p className="dash-claude__line" aria-live="off">
        <span ref={lineRef} />
        <i className="dash-caret" aria-hidden="true" />
      </p>
      <dl className="dash-claude__stats">
        <div><dt>latency</dt><dd>{c?.latency != null ? `${fmt(Math.round(c.latency))} ms` : c ? '…' : '—'}</dd></div>
        <div><dt>in</dt><dd>{fmt(c?.inTok)}</dd></div>
        <div><dt>out</dt><dd>{fmt(c?.outTok)}</dd></div>
        <div className="dash-claude__calls"><dt>{s.claudeCalls === 1 ? 'call' : 'calls'}</dt><dd>{s.claudeCalls}</dd></div>
      </dl>
      {c?.error && <p className="dash-meta dash-warn">error · {c.error}</p>}
    </div>
  );
}

// ---------- screen ----------

type Conn = 'connecting' | 'live' | 'offline';

export default function Dashboard() {
  const [params] = useSearchParams();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);
  const wireRef = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  const model = useRef<Model>(freshModel());
  const dirty = useRef(true);
  /** liveness-derived states as last rendered (derive().key), so going quiet re-renders the cards once */
  const shownLive = useRef('');
  const [snap, setSnap] = useState<Snap>(() => snapshot(model.current, performance.now()));
  const [conn, setConn] = useState<Conn>('connecting');
  const [forced, setForced] = useState<boolean | null>(() => (params.has('demo') ? true : null));
  const demo = forced ?? conn === 'offline';
  const demoRef = useRef(demo);
  demoRef.current = demo;
  const liveSeen = useRef(false);
  const tickSeq = useRef(0);

  const ingest = useCallback((e: TelemetryEvent, animate: boolean) => {
    const now = performance.now();
    const m = model.current;
    apply(m, e, now, animate);
    if (animate) {
      engine.current?.fire(e);
      if (e.kind === 'claude.response' && m.claudeLine) engine.current?.setLine(m.claudeLine);
      if (!QUIET.has(e.kind)) {
        tickSeq.current += 1;
        m.ticker.unshift({ key: `${e.id}-${tickSeq.current}`, source: e.source, target: e.target, label: e.label, at: now });
        if (m.ticker.length > 7) m.ticker.length = 7;
      }
    } else if (e.kind === 'claude.response' && m.claudeLine) {
      engine.current?.setLine(m.claudeLine);
    }
    dirty.current = true;
  }, []);

  // Canvas engine.
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const eng = createEngine(
      canvas,
      stage,
      { line: () => lineRef.current, wire: () => wireRef.current, model: () => model.current },
      reduce,
    );
    engine.current = eng;
    return () => {
      eng.destroy();
      engine.current = null;
    };
  }, []);

  // Cards: at most 10 renders a second, only when something changed (the ticker also needs its expiry).
  useEffect(() => {
    const id = window.setInterval(() => {
      const m = model.current;
      const now = performance.now();
      if (prunePresence(m)) dirty.current = true;
      const { key } = derive(m, now);
      if (key !== shownLive.current) dirty.current = true;
      if (!dirty.current && !m.ticker.some((t) => now - t.at >= TICK_MS)) return;
      m.ticker = m.ticker.filter((t) => now - t.at < TICK_MS);
      dirty.current = false;
      shownLive.current = key;
      setSnap(snapshot(m, now));
    }, 100);
    return () => window.clearInterval(id);
  }, []);

  // A switch between live and replay starts from clean cards.
  useEffect(() => {
    model.current = freshModel();
    engine.current?.reset();
    dirty.current = true;
  }, [demo]);

  // Live stream: always subscribed, so a live event can end an automatic replay.
  useEffect(() => {
    let off: () => void = () => {};
    try {
      off = subscribeTelemetry((e) => {
        const fresh = Date.now() - e.at < STALE_MS;
        if (fresh && !liveSeen.current) {
          liveSeen.current = true;
          setConn('live');
        }
        if (demoRef.current) return;
        ingest(e, fresh);
      });
    } catch {
      setConn('offline');
    }
    const timer = window.setTimeout(() => {
      if (!liveSeen.current) setConn('offline');
    }, FALLBACK_MS);
    return () => {
      window.clearTimeout(timer);
      off();
    };
  }, [ingest]);

  // Replay: the demo file on a loop, through the same ingest path.
  useEffect(() => {
    if (!demo) return;
    let stopped = false;
    let timer = 0;
    type DemoEvent = Omit<TelemetryEvent, 'id' | 'at'> & { t: number };
    fetch(`${import.meta.env.BASE_URL}telemetry-demo.json`)
      .then((r) => r.json() as Promise<{ durationMs: number; events: DemoEvent[] }>)
      .then((doc) => {
        if (stopped) return;
        const events = [...doc.events].sort((a, b) => a.t - b.t);
        const duration = Math.max(doc.durationMs || 0, (events[events.length - 1]?.t ?? 0) + 1000);
        let start = performance.now();
        let idx = 0;
        let loop = 0;
        const tick = () => {
          const now = performance.now();
          let el = now - start;
          if (el > duration * 1.5) {
            // the tab slept: pick up from the top instead of flooding
            start = now;
            idx = 0;
            el = 0;
          }
          while (idx < events.length && events[idx].t <= el) {
            const d = events[idx];
            ingest({ id: `demo-${loop}-${idx}`, at: Date.now(), source: d.source, target: d.target, kind: d.kind, label: d.label, payload: d.payload ?? {} }, el - d.t < 1500);
            idx += 1;
          }
          if (el >= duration) {
            start += duration;
            idx = 0;
            loop += 1;
          }
        };
        tick();
        timer = window.setInterval(tick, 40);
      })
      .catch(() => {
        /* no demo file: the graph keeps breathing */
      });
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [demo, ingest]);

  // Keyboard: f fullscreen, d demo.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat) return;
      const k = ev.key.toLowerCase();
      if (k === 'f') {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        else void document.documentElement.requestFullscreen?.().catch(() => {});
      } else if (k === 'd') {
        setForced(!demoRef.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="dash">
      <canvas ref={canvasRef} className="dash-canvas" aria-hidden="true" />
      <div ref={stageRef} className="dash-stage">
        <header className="dash-head">
          <div className="dash-brand">
            <img src={brandMark} alt="" aria-hidden="true" width={24} height={26} />
            <h1>articulate</h1>
            <span className="dash-sub">live system view</span>
          </div>
          <div className="dash-head__right">
            {demo && (
              <span className="dash-replay" title="Replaying recorded telemetry. Press d to switch.">
                replay
              </span>
            )}
            <span className="dash-count dash-learners">
              <b>{snap.learners}</b> {snap.learners === 1 ? 'learner' : 'learners'} live
            </span>
            <span className="dash-count">
              <b>{snap.count.toLocaleString('en-US')}</b> events
              <span className="dash-count__rate"> · {snap.rate.toFixed(1)}/s</span>
            </span>
            <span className="dash-pill" data-state={conn}>
              <i aria-hidden="true" />
              {conn}
            </span>
          </div>
        </header>

        {NODES.map((n) => {
          const [ax, ay, aw] = n.ann;
          return (
            <section
              key={n.id}
              className={`dash-node dash-node--${n.id}`}
              data-align={n.align}
              style={{ left: ax, top: ay, width: aw }}
              aria-label={n.name}
            >
              <h2 className="dash-node__name">
                {n.name}
                <span className="dash-node__loc">{locOf(n, snap)}</span>
              </h2>
              <p className="dash-node__cap">{n.caption}</p>
              {n.id === 'claude' ? <ClaudeCard s={snap} lineRef={lineRef} /> : <Detail id={n.id} s={snap} wireRef={wireRef} />}
              {n.id === 'ui' && <Presence dots={snap.dots} />}
            </section>
          );
        })}

        <aside className="dash-legend" aria-label="How to read this view">
          <p className="dash-legend__title">How to read it</p>
          <p>
            Each cluster of dots is one part of the system, lit like Ava’s head. When an event flows, a packet of dots
            runs along its line and the part it reaches ripples. Everything converges on the coach model.
          </p>
        </aside>

        <footer className="dash-foot">
          <span className="dash-foot__keys" aria-hidden="true">
            <kbd>f</kbd> fullscreen <kbd>d</kbd> {demo ? 'live' : 'replay'}
          </span>
          <ol className="dash-ticker" aria-live="polite" aria-label="Recent events">
            {snap.ticker.map((t) => (
              <li key={t.key}>
                <span className="dash-ticker__route">
                  {t.source} <span aria-label="to">→</span> {t.target}
                </span>
                <span className="dash-ticker__label"> · {t.label}</span>
              </li>
            ))}
          </ol>
        </footer>
      </div>
    </div>
  );
}
