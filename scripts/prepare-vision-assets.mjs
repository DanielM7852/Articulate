// Serve the wasm runtime matching the installed package; model weights are checked in separately.
import { createRequire } from "node:module";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/web/package.json"));
const bundle = require.resolve("@mediapipe/tasks-vision");
const packageDir = dirname(bundle);
const version = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8"),
).version;
if (version !== "0.10.17")
  throw new Error(
    `Expected MediaPipe 0.10.17, found ${version}. Update the collector provenance when upgrading.`,
  );
const dest = join(root, "apps/web/public/mediapipe/wasm");
mkdirSync(dest, { recursive: true });
for (const name of readdirSync(join(packageDir, "wasm")))
  copyFileSync(join(packageDir, "wasm", name), join(dest, name));
if (!existsSync(join(dest, "../face_landmarker.task")))
  throw new Error("Missing public/mediapipe/face_landmarker.task");
console.log("Prepared local MediaPipe runtime (0.10.17).");
