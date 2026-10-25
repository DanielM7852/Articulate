import type { GraphId } from './route';

/**
 * The live graph's layout on its fixed 1600 x 900 design stage (Dashboard.tsx scales it to fit), and the curve
 * geometry the edges and packets share. Browser inputs sit on the left, cloud speech along the top, the backend in
 * the middle with the coach model to its right, the analysis services and the two databases along the bottom, and the
 * learner's screen with Ava's head on the right, the session recap under it and the phone model at the foot of that
 * column. The recap reaches the coach model in an arc over the coach card; the learner's lanes to the phone model and
 * the classroom database run down the gap between the coach card and the recap. Annotations face outward so the edges
 * run through the middle without crossing text; the bends were tuned against measured annotation boxes, so a moved
 * node or a longer caption needs its edges checked again.
 */

export const W = 1600;
export const H = 900;

/** Where a node runs. The coach model takes its tag from the live provider; 'LLM' is the tag before any evidence. */
export type Loc = 'browser' | 'server' | 'OpenAI' | 'Cartesia' | 'Anthropic' | 'LLM' | 'maincloud' | 'SpacetimeDB' | 'Azure Speech' | 'GPU service';

export interface NodeDef {
  id: GraphId;
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

export const NODES: NodeDef[] = [
  // browser inputs, left: the camera and the face on top, the microphone and its analysis below
  { id: 'camera', name: 'Camera', caption: 'webcam capture', loc: 'browser', x: 404, y: 112, r: 28, n: 150, ann: [446, 92, 140] },
  { id: 'mediapipe', name: 'MediaPipe', caption: 'FaceLandmarker → LipFrame', loc: 'browser', x: 404, y: 262, r: 40, n: 230, ann: [44, 76, 306], align: 'right' },
  { id: 'mic', name: 'Microphone', caption: 'microphone capture', loc: 'browser', x: 84, y: 480, r: 28, n: 150, ann: [52, 520, 184] },
  { id: 'audio', name: 'Audio', caption: 'AnalyserNode spectrum and waveform, vowel-mapper worklet formants', loc: 'browser', x: 300, y: 508, r: 40, n: 230, ann: [86, 592, 254], align: 'right' },
  // cloud speech, top; annotations above so the lines run underneath
  { id: 'realtime', name: 'Realtime', caption: 'speech to text in the word lesson', loc: 'OpenAI', x: 650, y: 236, r: 36, n: 210, ann: [614, 80, 196] },
  { id: 'stt', name: 'Ink', caption: 'hands-free speech to text', loc: 'Cartesia', x: 860, y: 236, r: 34, n: 200, ann: [826, 80, 196] },
  { id: 'tts', name: 'Sonic', caption: 'text to speech, Ava’s voice', loc: 'Cartesia', x: 1070, y: 236, r: 36, n: 210, ann: [1034, 80, 190] },
  // the learner's side, right: the recap (last in this list) just under the learner, the phone model below it
  { id: 'head', name: 'Head', caption: 'Ava’s 3D head (three.js / TalkingHead)', loc: 'browser', x: 1280, y: 236, r: 30, n: 170, ann: [1250, 80, 150] },
  { id: 'ui', name: 'Learner', caption: 'the learner’s screen', loc: 'browser', x: 1490, y: 266, r: 44, n: 260, ann: [1404, 80, 172] },
  { id: 'phones', name: 'Phones', caption: 'KoelLabs wav2vec2 phone model', loc: 'GPU service', x: 1460, y: 690, r: 30, n: 170, ann: [1432, 726, 150] },
  // server: the backend and the coach model it calls
  { id: 'backend', name: 'Backend', caption: 'FastAPI app', loc: 'server', x: 740, y: 430, r: 52, n: 320, ann: [516, 400, 164], align: 'right' },
  { id: 'claude', name: 'Coach model', caption: 'decisions, notes', loc: 'LLM', x: 970, y: 468, r: 72, n: 520, ann: [1060, 388, 276] },
  // along the bottom: SpacetimeDB under the inputs that write to it, the server-side analysis, the classroom database
  { id: 'db', name: 'SpacetimeDB', caption: 'articulate-live: telemetry, attempts', loc: 'maincloud', x: 470, y: 636, r: 38, n: 240, ann: [438, 682, 200] },
  { id: 'pitch', name: 'Acoustics', caption: 'Praat / Parselmouth: F0, F1, F2', loc: 'server', x: 676, y: 636, r: 32, n: 180, ann: [644, 682, 182] },
  { id: 'sparc', name: 'SPARC', caption: 'articulation service', loc: 'server', x: 862, y: 636, r: 34, n: 190, ann: [830, 682, 182] },
  { id: 'azure', name: 'Azure', caption: 'pronunciation assessment', loc: 'Azure Speech', x: 1048, y: 644, r: 32, n: 180, ann: [1016, 690, 178] },
  { id: 'classroom', name: 'Classroom DB', caption: 'lessons, roster, summaries', loc: 'SpacetimeDB', x: 1340, y: 650, r: 36, n: 230, ann: [1226, 696, 150], align: 'right' },
  // the recap, under the learner (kept last: a cluster's dot noise is seeded by its index)
  { id: 'recap', name: 'Recap', caption: 'post-session recap by Claude, emailed via Resend', loc: 'server', x: 1500, y: 400, r: 28, n: 160, ann: [1410, 434, 166], align: 'right' },
];

export const NODE = Object.fromEntries(NODES.map((n) => [n.id, n])) as Record<GraphId, NodeDef>;

/**
 * Edges drawn on the paper, [from, to, bend]: the routes in route.ts that carry traffic, plus mic -> audio. A route
 * missing here still animates (the engine makes an undrawn lane on first use) but has no line. Bend is a fraction of
 * the length, perpendicular to the chord, so a reverse edge with the same bend bows to the other side (two lanes).
 */
export const EDGES: [GraphId, GraphId, number][] = [
  ['camera', 'mediapipe', 0.04],
  ['mic', 'audio', 0.05],
  ['mic', 'realtime', 0.2],
  ['mic', 'stt', 0.1],
  ['mediapipe', 'db', 0.33],
  ['audio', 'db', -0.01],
  ['realtime', 'ui', 0.12],
  ['stt', 'ui', 0.16],
  ['ui', 'tts', -0.14],
  ['tts', 'ui', -0.24],
  ['tts', 'head', 0.02],
  ['ui', 'head', -0.22],
  ['backend', 'tts', -0.21],
  ['ui', 'backend', 0.06],
  ['backend', 'ui', -0.02],
  ['backend', 'claude', 0.1],
  ['claude', 'backend', 0.1],
  ['backend', 'pitch', 0],
  ['pitch', 'backend', -0.13],
  ['backend', 'sparc', -0.06],
  ['sparc', 'backend', -0.02],
  ['backend', 'azure', 0],
  ['azure', 'backend', -0.05],
  ['backend', 'db', -0.28],
  ['backend', 'classroom', 0.15],
  ['ui', 'classroom', 0.12],
  ['ui', 'phones', 0.44],
  ['phones', 'ui', -0.4],
  ['ui', 'recap', 0.06],
  ['recap', 'ui', 0.06],
  ['recap', 'claude', 0.45],
  ['claude', 'recap', -0.42],
];

export interface Curve {
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

/** A quadratic from rim to rim, bowed `bend` x length off the chord (perpendicular, so reverse edges get two lanes). */
export function makeCurve(a: NodeDef, b: NodeDef, bend: number): Curve {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const L = Math.hypot(vx, vy) || 1;
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

export function pointOn(c: Curve, t: number, out: { x: number; y: number }) {
  const q = 1 - t;
  out.x = q * q * c.ax + 2 * q * t * c.cx + t * t * c.bx;
  out.y = q * q * c.ay + 2 * q * t * c.cy + t * t * c.by;
}
