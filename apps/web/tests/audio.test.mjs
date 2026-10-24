import test from "node:test";
import assert from "node:assert/strict";
import { PcmRing } from "../public/audio/ring.mjs";
test("partial playback begins before producer finishes", () => {
  const ring = new PcmRing(24000, 48000, 80);
  ring.push(new Float32Array(2400).fill(0.5));
  const out = new Float32Array(128);
  ring.render(out);
  assert.equal(ring.started, true);
  assert.equal(ring.finished, false);
  assert.equal(out[0], 0.5);
});
test("clear removes all queued sound on interruption", () => {
  const ring = new PcmRing();
  ring.push(new Float32Array(4000).fill(0.7));
  ring.clear();
  const out = new Float32Array(128);
  ring.render(out);
  assert.ok(out.every((x) => x === 0));
});
test("bounded buffering rejects overflow", () => {
  const ring = new PcmRing();
  assert.throws(() => ring.push(new Float32Array(48001)));
});
test("short final clip drains, resamples and ends", () => {
  const ring = new PcmRing(24000, 48000);
  ring.push(new Float32Array(240).fill(0.3));
  ring.finish();
  let nonzero = 0;
  for (let i = 0; i < 8; i++) {
    const out = new Float32Array(128);
    ring.render(out);
    nonzero += out.filter((x) => x !== 0).length;
  }
  assert.equal(nonzero, 480);
  assert.equal(ring.done, true);
  assert.equal(ring.consumed, 240);
});
test("underrun pauses and resumes without replay", () => {
  const ring = new PcmRing(24000, 24000, 1);
  ring.push(new Float32Array(30).fill(0.5));
  ring.render(new Float32Array(128));
  assert.equal(ring.underruns, 1);
  ring.push(new Float32Array(100).fill(0.25));
  ring.finish();
  const out = new Float32Array(128);
  ring.render(out);
  assert.equal(ring.done, true);
  assert.ok(out.some((x) => x === 0.25));
});
