import { createMouthDemo } from "./mouth-demo.js";

const app = document.getElementById("app");
const CUE_KEYS = { 1: "round-lips", 2: "spread-lips", 3: "open-jaw" };

function isTyping(target) {
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
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
  else if (key === "h") demo.setStyle(demo.style === "hologram" ? "solid" : "hologram");
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
