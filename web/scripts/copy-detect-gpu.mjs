// Copies detect-gpu's GPU benchmark tables from node_modules into public/ so tier detection
// (mouth-demo/src/quality.js) works offline instead of fetching them from unpkg at runtime.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'detect-gpu', 'dist', 'benchmarks');
const dest = join(root, 'public', 'detect-gpu', 'benchmarks');

if (!existsSync(src)) {
  console.error(`copy-detect-gpu: ${src} not found. Run "npm ci" in web/ first.`);
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
console.log(`copy-detect-gpu: ${copied} file(s) copied to public/detect-gpu/benchmarks`);
