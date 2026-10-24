import { afterEach, expect, it, vi } from "vitest";
import { analyzeArticulation, encodeMonoWav } from "../src/articulation";

afterEach(() => vi.unstubAllGlobals());

it("encodes actual PCM with the original sample rate and correct WAV lengths", async () => {
  const blob = encodeMonoWav(new Float32Array([0, -1, 1, 0.5]), 48000);
  const view = new DataView(await blob.arrayBuffer());
  expect(blob.type).toBe("audio/wav");
  expect(view.byteLength).toBe(52);
  expect(view.getUint32(24, true)).toBe(48000);
  expect(view.getUint32(40, true)).toBe(8);
  expect(view.getInt16(46, true)).toBe(-32768);
  expect(view.getInt16(48, true)).toBe(32767);
});

it("rejects nonfinite/out-of-range PCM, invalid clocks and excessively long recordings", async () => {
  expect(() => encodeMonoWav(new Float32Array([NaN]), 16000)).toThrow("finite");
  expect(() => encodeMonoWav(new Float32Array([1.1]), 16000)).toThrow("within");
  expect(() => encodeMonoWav(new Float32Array(16000 * 31), 16000)).toThrow(
    "30 seconds",
  );
  await expect(
    analyzeArticulation(new Blob(), { captureStartMonotonicMs: 1 }),
  ).rejects.toThrow("both");
});

it("sends a WAV to the separate service with the supplied attempt and audio capture clock", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: "articulate.articulation/1",
          attemptId: "a",
          models: { sparc: { status: "unavailable", series: {} } },
        }),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  const wav = encodeMonoWav(new Float32Array(16000), 16000);
  const result = await analyzeArticulation(wav, {
    models: ["sparc", "arti6"],
    attemptId: "a",
    captureStartMonotonicMs: 100,
    timeOriginUnixMs: 1000,
  });
  const [url, options] = fetcher.mock.calls[0];
  expect(url).toContain("models=sparc%2Carti6");
  expect(url).toContain("capture_start_monotonic_ms=100");
  expect(options.body).toBe(wav);
  expect(result.models.sparc?.status).toBe("unavailable");
  expect(result.models.sparc?.series).toEqual({});
});

it("surfaces service failures and incompatible contracts without inventing output", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("busy", { status: 503 })),
  );
  await expect(analyzeArticulation(new Blob())).rejects.toThrow("503");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ schemaVersion: "other" })),
      ),
  );
  await expect(analyzeArticulation(new Blob())).rejects.toThrow("Unexpected");
});
