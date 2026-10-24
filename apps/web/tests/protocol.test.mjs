import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(
  new URL("../src/audio.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const { frame, decode, Media } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const id = "12345678-1234-4234-8234-123456789abc";
test("browser binary framing round-trips and rejects upload direction", () => {
  const data = frame(2, id, 3, 960, 24000, new Int16Array([0, 16384, -32768]));
  assert.equal(data.byteLength, 50);
  const decoded = decode(data);
  assert.equal(decoded.id, id);
  assert.equal(decoded.seq, 3);
  assert.equal(decoded.offset, 960);
  assert.deepEqual(Array.from(decoded.samples), [0, 0.5, -1]);
  assert.throws(() => decode(frame(1, id, 0, 0, 24000, new Int16Array([1]))));
  assert.throws(() => decode(frame(2, id, 0, 0, 48000, new Int16Array([1]))));
  assert.throws(() => decode(frame(2, id, 0, 0, 24000, new Int16Array())));
});
test("browser drops obsolete generations and rejects unordered chunks", () => {
  const delivered = [];
  const media = new Media(
    () => {},
    () => {},
  );
  media.generation = id;
  media.playback = { port: { postMessage: (data) => delivered.push(data) } };
  media.receive(
    frame(
      2,
      "22345678-1234-4234-8234-123456789abc",
      0,
      0,
      24000,
      new Int16Array([1]),
    ),
  );
  assert.equal(delivered.length, 0);
  assert.throws(() =>
    media.receive(frame(2, id, 1, 0, 24000, new Int16Array([1]))),
  );
  media.receive(frame(2, id, 0, 0, 24000, new Int16Array([1, 2])));
  assert.equal(delivered.length, 1);
  assert.throws(() =>
    media.receive(frame(2, id, 1, 0, 24000, new Int16Array([1]))),
  );
  media.clear();
  assert.equal(media.generation, null);
});
