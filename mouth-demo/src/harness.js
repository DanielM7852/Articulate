import { createMouthDemo } from "./mouth-demo.js";

const app = document.getElementById("app");
const CUE_KEYS = { 1: "round-lips", 2: "spread-lips", 3: "open-jaw" };

function isTyping(target) {
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
}

// DEV ONLY (key L): plays a canned "please say banana, my mama made pie" timeline against a
// performance.now() clock so lip sync can be eyeballed without audio. Not used by web/.
// Phonemes are ARPAbet and arrive in two batches via append(), like streamed data would.
const DEV_PHONEMES = "p l iy z|s ey|b ah n ae n ah|m ay|m aa m ah|m ey d|p ay".split("|").join(" ").split(" ");
const DEV_WORDS = ["please", "say", "banana", "my", "mama", "made", "pie"];
function devLipSync(demo) {
  demo.stop(); // a cue owns the mouth; let it ease out first
  const t0 = performance.now() + 500; // clock reads negative for the first 0.5 s
  const phonemes = DEV_PHONEMES.map((p, i) => ({ p, start: 0.1 + i * 0.09, end: 0.1 + (i + 1) * 0.09 }));
  const handle = demo.speak({ clock: () => (performance.now() - t0) / 1000, timeline: { phonemes: phonemes.slice(0, 10) } });
  setTimeout(() => handle.append({ phonemes: phonemes.slice(10) }), 700);
  const total = 0.1 + phonemes.length * 0.09;
  const words = DEV_WORDS.map((text, i) => ({ text, start: 0.1 + (i / DEV_WORDS.length) * (total - 0.1), end: 0.1 + ((i + 0.9) / DEV_WORDS.length) * (total - 0.1) }));
  handle.append({ words });
  handle.end();
}

function onKey(demo, e) {
  if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (demo.handleCalibrationKey(e)) {
    e.preventDefault();
    return;
  }
  const key = e.key.toLowerCase();
  if (CUE_KEYS[key]) demo.showCue(CUE_KEYS[key]);
  else if (key === "r") demo.replay();
  else if (key === "s") demo.setSpeed(demo.speed === 1 ? 0.5 : 1);
  else if (key === "v") demo.setView(demo.view === "side" ? "front" : "side");
  else if (key === "g") demo.toggleCalibration();
  else if (key === "h") { const o = ["hologram", "porcelain", "hybrid", "solid"]; demo.setStyle(o[(o.indexOf(demo.style) + 1) % o.length]); }
  else if (key === "l") devLipSync(demo);
  else if (key === "0") demo.stop();
  else return;
  e.preventDefault();
}

createMouthDemo(app, {}).then((demo) => {
  window.demo = demo;
  window.addEventListener("keydown", (e) => onKey(demo, e));
  demo.showCue("round-lips");
}).catch((err) => {
  console.error("[harness] could not start the demo:", err);
});
