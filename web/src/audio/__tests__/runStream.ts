// npx esbuild src/audio/__tests__/runStream.ts --bundle --platform=node --format=esm --define:import.meta.env.VITE_TELEMETRY='"off"' --outfile=<tmp>/stream-tests.mjs && node <tmp>/stream-tests.mjs
import { runStreamTests } from './teacherStream.test';

void runStreamTests();
