export const POSES = ["neutral", "oo", "ee", "ah", "tongueTip", "velar", "r"];

const SVG_NS = "http://www.w3.org/2000/svg";
const NAVY = "#203E68";
const BLUE = "#CBD7E6";
const WHITE = "#FFFFFF";
const MARKER = "#E8590C";
const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

// Each element has the same commands and number count in every pose (see lerpPath).
const PATHS = {
  tongue: {
    neutral: "M 100 226 C 130 214 170 212 205 218 C 240 224 268 232 282 248 C 284 266 270 278 245 280 C 190 284 130 278 108 254 C 100 244 98 234 100 226 Z",
    oo: "M 118 236 C 150 236 185 234 212 214 C 232 180 262 172 284 206 C 292 236 280 272 248 280 C 190 284 140 280 122 262 C 116 254 116 244 118 236 Z",
    ee: "M 100 212 C 120 186 150 166 185 166 C 220 166 250 186 274 220 C 282 250 270 274 245 280 C 190 284 130 280 106 256 C 100 242 98 226 100 212 Z",
    ah: "M 124 292 C 150 290 190 284 220 280 C 245 278 268 266 284 260 C 288 276 284 288 270 294 C 220 302 165 314 130 316 C 122 312 120 302 124 292 Z",
    // t d n l: tip up on the alveolar ridge just behind the upper teeth
    tongueTip: "M 98 163 C 112 160 150 194 200 212 C 240 222 268 234 282 250 C 284 268 270 280 245 282 C 190 286 128 280 112 240 C 106 212 99 184 98 163 Z",
    // k g ng: back of the tongue raised against the velum
    velar: "M 104 232 C 140 226 182 210 216 180 C 240 150 262 150 274 224 C 290 244 280 274 248 280 C 190 284 134 280 110 258 C 102 248 100 240 104 232 Z",
    // r: bunched / retroflex. Body raised mid-mouth, tip lifted and drawn back, well clear of the ridge
    r: "M 140 200 C 160 186 190 172 215 176 C 245 182 268 214 282 250 C 284 268 270 280 245 282 C 190 286 130 280 114 250 C 108 236 122 216 140 200 Z",
  },
  upperLip: {
    neutral: "M 64 130 C 50 142 44 170 50 190 C 53 200 66 203 76 199 C 70 188 66 170 74 150 C 70 142 68 136 64 130 Z",
    oo: "M 60 130 C 38 140 14 166 18 186 C 22 196 44 198 62 192 C 52 184 50 168 58 150 C 56 142 58 136 60 130 Z",
    ee: "M 64 130 C 60 144 58 166 62 182 C 64 190 72 192 80 190 C 74 182 72 168 76 152 C 72 144 68 136 64 130 Z",
    ah: "M 64 130 C 54 140 52 160 56 176 C 58 184 68 186 78 183 C 72 176 70 164 74 150 C 70 142 68 136 64 130 Z",
    tongueTip: "M 64 130 C 50 142 44 170 50 190 C 53 200 66 203 76 199 C 70 188 66 170 74 150 C 70 142 68 136 64 130 Z",
    velar: "M 64 130 C 50 142 44 170 50 190 C 53 200 66 203 76 199 C 70 188 66 170 74 150 C 70 142 68 136 64 130 Z",
    r: "M 62.2 130 C 44.6 141.1 30.5 168.2 35.6 188.2 C 39 198.2 56.1 200.8 69.7 195.8 C 61.9 186.2 58.8 169.1 66.8 150 C 63.7 142 63.5 136 62.2 130 Z",
  },
  lowerLipJaw: {
    neutral: "M 272 284 C 220 282 150 282 112 268 C 100 262 96 252 96 240 L 94 208 L 76 205 C 62 206 54 214 56 228 C 58 240 50 252 52 268 C 54 292 74 318 104 324 C 154 332 222 330 262 306 C 278 296 286 280 292 258",
    oo: "M 272 284 C 220 282 150 282 112 268 C 100 262 96 252 96 240 L 94 210 L 72 206 C 46 204 28 214 32 230 C 36 244 48 254 52 268 C 54 292 74 318 104 324 C 154 332 222 330 262 306 C 278 296 286 280 292 258",
    ee: "M 272 284 C 220 282 150 282 112 268 C 100 262 96 252 96 240 L 94 208 L 80 205 C 68 206 62 212 62 226 C 62 240 54 252 54 268 C 54 292 74 318 104 324 C 154 332 222 330 262 306 C 278 296 286 280 292 258",
    ah: "M 283 288 C 232 301 165 322 125 319 C 112 317 105 309 102 297 L 90 267 L 72 270 C 59 275 54 285 60 297 C 65 308 61 322 68 337 C 77 359 103 378 134 375 C 184 368 248 346 280 312 C 292 297 295 280 294 257",
    // jaw slightly open (neutral toward ah by 0.2 and 0.25)
    tongueTip: "M 274 285 C 222 286 153 290 115 278 C 102 273 98 263 97 251 L 93 220 L 75 218 C 61 220 54 228 57 242 C 59 254 52 266 55 282 C 59 305 80 330 110 334 C 160 339 227 333 266 307 C 281 296 288 280 292 258",
    velar: "M 275 285 C 223 287 154 292 115 281 C 103 276 98 266 98 254 L 93 223 L 75 221 C 61 223 54 232 57 245 C 60 257 53 270 56 285 C 60 309 81 333 112 337 C 162 341 229 334 267 308 C 282 296 288 280 292 258",
    r: "M 273 284.5 C 221 284 151.5 286 113.5 273 C 101 267.5 97 257.5 96.5 245.5 L 93.5 214.9 L 73.7 211.9 C 54.3 212.1 42.3 221 45.7 235.9 C 48.6 248.8 50.1 259.9 53.5 275 C 56.5 298.5 77 324 107 329 C 157 335.5 224.5 331.5 264 306.5 C 279.5 296 287 280 292 258",
  },
};

// Weighted blend (setBlend): weight name -> pose. The result is neutral + sum of w * (pose - neutral).
export const BLEND_POSES = { ah: "ah", oo: "oo", ee: "ee", tongue: "tongueTip", velar: "velar", r: "r" };
const BLEND_KEYS = Object.keys(BLEND_POSES);

// Parse every element once: the neutral path split around its numbers, plus each blend pose's offsets from neutral.
const commands = (d) => d.replace(NUM, "").replace(/\s+/g, "");
const PARSED = {};
for (const [k, poses] of Object.entries(PATHS)) {
  const base = poses.neutral.match(NUM).map(Number);
  for (const [name, d] of Object.entries(poses)) {
    const n = (d.match(NUM) || []).length;
    if (n !== base.length || commands(d) !== commands(poses.neutral)) {
      throw new Error(`cutaway: ${k}.${name} does not match neutral (${n} vs ${base.length} numbers)`);
    }
  }
  PARSED[k] = {
    parts: poses.neutral.split(NUM),
    base,
    deltas: BLEND_KEYS.map((w) => poses[BLEND_POSES[w]].match(NUM).map((v, i) => +v - base[i])),
    out: new Float64Array(base.length),
  };
}

// Neutral + weighted offsets as a path string. `w` holds one weight per BLEND_KEYS entry.
export function blendPath(k, w) {
  const P = PARSED[k];
  const out = P.out;
  for (let i = 0; i < out.length; i++) {
    let v = P.base[i];
    for (let j = 0; j < w.length; j++) if (w[j]) v += w[j] * P.deltas[j][i];
    out[i] = v;
  }
  let d = P.parts[0];
  for (let i = 0; i < out.length; i++) d += +out[i].toFixed(2) + P.parts[i + 1];
  return d;
}

// Weights clamped to [0, 1] and scaled down so they sum to at most 1 (shapes never overshoot a pose).
export function normalizeBlend(weights, out = new Float64Array(BLEND_KEYS.length)) {
  let sum = 0;
  for (let j = 0; j < BLEND_KEYS.length; j++) {
    const v = Number(weights?.[BLEND_KEYS[j]]);
    out[j] = v > 0 ? Math.min(1, v) : 0;
    sum += out[j];
  }
  if (sum > 1) for (let j = 0; j < out.length; j++) out[j] /= sum;
  return out;
}

export function lerpPath(a, b, t) {
  const na = a.match(NUM) || [];
  const nb = b.match(NUM) || [];
  if (na.length !== nb.length) {
    throw new Error(`lerpPath: number counts differ (${na.length} vs ${nb.length})`);
  }
  let i = 0;
  return a.replace(NUM, () => {
    const v = +na[i] + (+nb[i] - +na[i]) * t;
    i++;
    return +v.toFixed(2);
  });
}

function svgEl(name, attrs = {}, parent) {
  const el = document.createElementNS(SVG_NS, name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(el);
  return el;
}

const STATIC_PATHS = [
  // nose and nasal cavity
  "M 98 34 C 74 66 44 96 30 118 C 26 128 40 133 60 130",
  "M 92 80 C 150 78 240 86 292 136",
  // hard palate and velum with uvula
  "M 80 172 C 100 150 150 146 215 152 C 250 155 275 170 285 205 C 288 216 277 219 273 208",
  // upper teeth
  "M 72 156 L 72 190 Q 72 197 79 197 L 88 197 Q 94 197 94 190 L 94 168",
  // back of the throat
  "M 300 142 C 332 210 334 300 306 392",
];

export function createCutaway(parentEl) {
  const uid = Math.random().toString(36).slice(2, 8);
  const patId = `md-dots-${uid}`;

  const el = document.createElement("div");
  el.className = "md-cutaway";
  el.setAttribute("aria-hidden", "true");

  const svg = svgEl("svg", { class: "md-cutaway__svg", viewBox: "0 0 400 400" });
  svg.style.transform = "scaleX(-1)";
  el.appendChild(svg);

  const defs = svgEl("defs", {}, svg);
  const pattern = svgEl("pattern", { id: patId, width: 10, height: 10, patternUnits: "userSpaceOnUse" }, defs);
  svgEl("rect", { width: 10, height: 10, fill: BLUE }, pattern);
  const dots = [
    svgEl("circle", { cx: 2.5, cy: 2.5, r: 1.5, fill: NAVY }, pattern),
    svgEl("circle", { cx: 7.5, cy: 7.5, r: 1.5, fill: NAVY }, pattern),
  ];

  svgEl("rect", { width: 400, height: 400, fill: WHITE }, svg);

  const stat = svgEl("g", { fill: "none", stroke: NAVY, "stroke-width": 2.5, "stroke-linecap": "round", "stroke-linejoin": "round" }, svg);
  for (const d of STATIC_PATHS) svgEl("path", { d }, stat);

  const anim = svgEl("g", { fill: "none", stroke: NAVY, "stroke-width": 2.5, "stroke-linecap": "round", "stroke-linejoin": "round" }, svg);
  const tongueHalo = svgEl("path", { d: PATHS.tongue.neutral, stroke: BLUE, "stroke-width": 0, "stroke-opacity": 0 }, anim);
  const tongue = svgEl("path", { d: PATHS.tongue.neutral, fill: `url(#${patId})` }, anim);
  const upperLip = svgEl("path", { d: PATHS.upperLip.neutral }, anim);
  const lowerLipJaw = svgEl("path", { d: PATHS.lowerLipJaw.neutral }, anim);
  const els = { tongue, upperLip, lowerLipJaw };

  // Contact marker: a dot with a soft halo on the palate line. Hidden until setMarker.
  const MARKERS = { ridge: [98, 161], velum: [250, 162] };
  const marker = svgEl("g", { class: "md-cutaway__marker", opacity: 0 }, svg);
  const markerHalo = svgEl("circle", { class: "md-cutaway__halo", r: 15, fill: MARKER, "fill-opacity": 0.3 }, marker);
  const markerDot = svgEl("circle", { r: 6, fill: MARKER, stroke: WHITE, "stroke-width": 2 }, marker);

  const cueLabel = document.createElement("div");
  cueLabel.className = "md-cutaway__cue";
  el.appendChild(cueLabel);

  const label = document.createElement("span");
  label.className = "md-cutaway__label";
  label.textContent = "Illustrative view";
  el.appendChild(label);

  parentEl.appendChild(el);

  function setHighlight(v) {
    const h = Math.min(1, Math.max(0, v));
    tongue.setAttribute("stroke-width", 2.5 + h * 2.5);
    tongueHalo.setAttribute("stroke-width", h * 12);
    tongueHalo.setAttribute("stroke-opacity", h);
    for (const d of dots) {
      d.setAttribute("r", 1.5 + h * 0.7);
      d.setAttribute("fill-opacity", 0.55 + h * 0.45);
    }
  }

  // where: "ridge" | "velum" | null; strength 0..1 sets opacity and size.
  function setMarker(where, strength = 1) {
    const pos = MARKERS[where];
    const m = pos ? Math.min(1, Math.max(0, strength)) : 0;
    if (pos) for (const c of [markerHalo, markerDot]) { c.setAttribute("cx", pos[0]); c.setAttribute("cy", pos[1]); }
    markerDot.setAttribute("r", 4 + m * 2.5);
    markerHalo.setAttribute("r", 9 + m * 8);
    marker.setAttribute("opacity", m);
  }

  function setCueLabel(text) {
    cueLabel.textContent = text || "";
    cueLabel.classList.toggle("is-on", !!text);
  }

  function show(t) {
    const o = Math.min(1, Math.max(0, t));
    el.style.opacity = o;
    el.style.visibility = o <= 0 ? "hidden" : "visible";
  }

  // Last weights written by setBlend; setPose invalidates them so the next blend always repaints.
  const blendW = new Float64Array(BLEND_KEYS.length);
  const lastW = new Float64Array(BLEND_KEYS.length);
  let blendValid = false;

  function setPose(from, to, t) {
    for (const k in els) {
      els[k].setAttribute("d", lerpPath(PATHS[k][from], PATHS[k][to], t));
    }
    tongueHalo.setAttribute("d", tongue.getAttribute("d"));
    blendValid = false;
  }

  // Lip-sync drive: { ah, oo, ee, tongue, velar } weights in [0, 1]; all zero is neutral.
  // Skips the DOM write when the weights have not changed since the last blend.
  function setBlend(weights) {
    normalizeBlend(weights, blendW);
    if (blendValid) {
      let same = true;
      for (let j = 0; j < blendW.length; j++) if (Math.abs(blendW[j] - lastW[j]) > 1e-4) { same = false; break; }
      if (same) return;
    }
    lastW.set(blendW);
    blendValid = true;
    for (const k in els) els[k].setAttribute("d", blendPath(k, blendW));
    tongueHalo.setAttribute("d", tongue.getAttribute("d"));
  }

  show(0);
  setHighlight(0);

  return { el, show, setPose, setBlend, setHighlight, setMarker, setCueLabel, dispose() { el.remove(); } };
}
