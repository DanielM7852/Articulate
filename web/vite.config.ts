import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repo = (p: string) => fileURLToPath(new URL(p, import.meta.url)).replace(/\\/g, '/');

/**
 * The live vowel graph and the 3D mouth reference come from sibling workstreams
 * in this repository and are imported in place rather than copied:
 *   @vowel-mapper -> ../vowel-mapper/src   F1/F2 engine (AudioWorklet + Worker + Burg LPC)
 *   @mouth-demo   -> ../mouth-demo         three.js hologram mouth and its avatar
 * `dedupe` makes their bare imports (react, three, TalkingHead) resolve from web/node_modules,
 * so the sibling trees share this app's single React instance.
 * The dev server proxies /v1 to the FastAPI backend in ../backend.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@vowel-mapper': repo('../vowel-mapper/src'),
      '@mouth-demo': repo('../mouth-demo'),
      '@lesson-rules': repo('../spacetimedb/src/lessonRules.ts'),
    },
    dedupe: ['react', 'react-dom', 'three', '@met4citizen/talkinghead', '@fontsource/atkinson-hyperlegible'],
  },
  build: {
    // The AudioWorklet module is tiny; keep it a real file instead of an inlined data URL.
    assetsInlineLimit: (file) => (file.endsWith('.js') ? false : undefined),
    rollupOptions: {
      input: {
        main: repo('./index.html'),
        teach: repo('./teach.html'),
        live: repo('./live.html'),
      },
    },
  },
  server: {
    port: 5173,
    host: true,
    fs: { allow: [repo('..')] },
    proxy: {
      '/v1': 'http://127.0.0.1:8000',
    },
  },
});
