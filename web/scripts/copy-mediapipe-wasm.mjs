// Copies the MediaPipe wasm runtime from node_modules into public/ so it is served locally.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const dest = join(root, 'public', 'mediapipe', 'wasm');

if (!existsSync(src)) {
  console.error(`copy-mediapipe-wasm: ${src} not found. Run "npm ci" in web/ first.`);
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
let copied = 0;
for (const name of readdirSync(src)) {
  const from = join(src, name);
  const to = join(dest, name);
  if (!statSync(from).isFile()) continue;
  if (existsSync(to)) {
    const a = statSync(from);
    const b = statSync(to);
    if (a.size === b.size && b.mtimeMs >= a.mtimeMs) continue;
  }
  copyFileSync(from, to);
  copied++;
}
console.log(`copy-mediapipe-wasm: ${copied} file(s) copied to public/mediapipe/wasm`);
