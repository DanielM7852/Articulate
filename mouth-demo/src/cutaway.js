export const POSES = ["neutral", "oo", "ee", "ah"];

const SVG_NS = "http://www.w3.org/2000/svg";
const PINK = "#FF2BA6";
const CYAN = "#3CF2FF";
const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

// Each element has the same commands and number count in every pose (see lerpPath).
const PATHS = {
  tongue: {
    neutral: "M 100 226 C 130 214 170 212 205 218 C 240 224 268 232 282 248 C 284 266 270 278 245 280 C 190 284 130 278 108 254 C 100 244 98 234 100 226 Z",
    oo: "M 118 236 C 150 236 185 234 212 214 C 232 180 262 172 284 206 C 292 236 280 272 248 280 C 190 284 140 280 122 262 C 116 254 116 244 118 236 Z",
    ee: "M 100 212 C 120 186 150 166 185 166 C 220 166 250 186 274 220 C 282 250 270 274 245 280 C 190 284 130 280 106 256 C 100 242 98 226 100 212 Z",
    ah: "M 124 292 C 150 290 190 284 220 280 C 245 278 268 266 284 260 C 288 276 284 288 270 294 C 220 302 165 314 130 316 C 122 312 120 302 124 292 Z",
  },
  upperLip: {
    neutral: "M 64 130 C 50 142 44 170 50 190 C 53 200 66 203 76 199 C 70 188 66 170 74 150 C 70 142 68 136 64 130 Z",
    oo: "M 60 130 C 38 140 14 166 18 186 C 22 196 44 198 62 192 C 52 184 50 168 58 150 C 56 142 58 136 60 130 Z",
    ee: "M 64 130 C 60 144 58 166 62 182 C 64 190 72 192 80 190 C 74 182 72 168 76 152 C 72 144 68 136 64 130 Z",
    ah: "M 64 130 C 54 140 52 160 56 176 C 58 184 68 186 78 183 C 72 176 70 164 74 150 C 70 142 68 136 64 130 Z",
  },
  lowerLipJaw: {
    neutral: "M 272 284 C 220 282 150 282 112 268 C 100 262 96 252 96 240 L 94 208 L 76 205 C 62 206 54 214 56 228 C 58 240 50 252 52 268 C 54 292 74 318 104 324 C 154 332 222 330 262 306 C 278 296 286 280 292 258",
    oo: "M 272 284 C 220 282 150 282 112 268 C 100 262 96 252 96 240 L 94 210 L 72 206 C 46 204 28 214 32 230 C 36 244 48 254 52 268 C 54 292 74 318 104 324 C 154 332 222 330 262 306 C 278 296 286 280 292 258",
    ee: "M 272 284 C 220 282 150 282 112 268 C 100 262 96 252 96 240 L 94 208 L 80 205 C 68 206 62 212 62 226 C 62 240 54 252 54 268 C 54 292 74 318 104 324 C 154 332 222 330 262 306 C 278 296 286 280 292 258",
    ah: "M 283 288 C 232 301 165 322 125 319 C 112 317 105 309 102 297 L 90 267 L 72 270 C 59 275 54 285 60 297 C 65 308 61 322 68 337 C 77 359 103 378 134 375 C 184 368 248 346 280 312 C 292 297 295 280 294 257",
  },
};

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

function hexMix(a, b, t) {
  const pa = [1, 3, 5].map((k) => parseInt(a.slice(k, k + 2), 16));
  const pb = [1, 3, 5].map((k) => parseInt(b.slice(k, k + 2), 16));
  return "rgb(" + pa.map((v, k) => Math.round(v + (pb[k] - v) * t)).join(",") + ")";
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
  const glowId = `md-glow-${uid}`;
  const patId = `md-dash-${uid}`;

  const el = document.createElement("div");
  el.className = "md-cutaway";
  el.setAttribute("aria-hidden", "true");

  const svg = svgEl("svg", { class: "md-cutaway__svg", viewBox: "0 0 400 400" });
  svg.style.transform = "scaleX(-1)";
  el.appendChild(svg);

  const defs = svgEl("defs", {}, svg);
  const filter = svgEl("filter", { id: glowId, filterUnits: "userSpaceOnUse", x: 0, y: 0, width: 400, height: 400 }, defs);
  svgEl("feGaussianBlur", { in: "SourceGraphic", stdDeviation: 3.5, result: "b" }, filter);
  const merge = svgEl("feMerge", {}, filter);
  svgEl("feMergeNode", { in: "b" }, merge);
  svgEl("feMergeNode", { in: "SourceGraphic" }, merge);

  const pattern = svgEl("pattern", { id: patId, width: 14, height: 7, patternUnits: "userSpaceOnUse" }, defs);
  svgEl("rect", { width: 14, height: 7, fill: PINK, "fill-opacity": 0.1 }, pattern);
  const dashes = [
    svgEl("line", { x1: 0, y1: 2, x2: 8, y2: 2, "stroke-width": 2, "stroke-linecap": "round" }, pattern),
    svgEl("line", { x1: 7, y1: 5.5, x2: 13, y2: 5.5, "stroke-width": 2, "stroke-linecap": "round" }, pattern),
  ];

  svgEl("rect", { width: 400, height: 400, fill: "#140A16" }, svg);

  const stat = svgEl("g", { fill: "none", stroke: PINK, "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", filter: `url(#${glowId})` }, svg);
  for (const d of STATIC_PATHS) svgEl("path", { d }, stat);

  const anim = svgEl("g", { fill: "none", stroke: PINK, "stroke-width": 2.4, "stroke-linecap": "round", "stroke-linejoin": "round", filter: `url(#${glowId})` }, svg);
  const tongue = svgEl("path", { d: PATHS.tongue.neutral, fill: `url(#${patId})` }, anim);
  const upperLip = svgEl("path", { d: PATHS.upperLip.neutral }, anim);
  const lowerLipJaw = svgEl("path", { d: PATHS.lowerLipJaw.neutral }, anim);
  const els = { tongue, upperLip, lowerLipJaw };

  const label = document.createElement("span");
  label.className = "md-cutaway__label";
  label.textContent = "Illustrative view";
  el.appendChild(label);

  parentEl.appendChild(el);

  function setHighlight(v) {
    const h = Math.min(1, Math.max(0, v));
    const c = hexMix(PINK, CYAN, h);
    tongue.setAttribute("stroke", c);
    tongue.setAttribute("stroke-width", 2.4 + h * 1.6);
    for (const d of dashes) d.setAttribute("stroke", c);
  }

  function show(t) {
    const o = Math.min(1, Math.max(0, t));
    el.style.opacity = o;
    el.style.visibility = o <= 0 ? "hidden" : "visible";
  }

  function setPose(from, to, t) {
    for (const k in els) {
      els[k].setAttribute("d", lerpPath(PATHS[k][from], PATHS[k][to], t));
    }
  }

  show(0);
  setHighlight(0);

  return { el, show, setPose, setHighlight, dispose() { el.remove(); } };
}
