/**
 * Minimal test harness: web has no test runner, so these suites are bundled with the
 * esbuild that ships with Vite and run under Node:
 *   npx esbuild src/game/__tests__/run.ts --bundle --platform=node --format=esm --outfile=<tmp>/game-tests.mjs && node <tmp>/game-tests.mjs
 * Nothing here is imported by the app.
 */
type Case = { name: string; fn: () => void };
const cases: Case[] = [];

export function test(name: string, fn: () => void) {
  cases.push({ name, fn });
}

export function expect<T>(actual: T, label = '') {
  const where = label ? ` (${label})` : '';
  return {
    toBe(expected: T) {
      if (actual !== expected) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${where}`);
    },
    toBeCloseTo(expected: number, tolerance: number) {
      if (typeof actual !== 'number' || Math.abs(actual - expected) > tolerance) {
        throw new Error(`expected ${expected} +/- ${tolerance}, got ${JSON.stringify(actual)}${where}`);
      }
    },
    toBeGreaterThan(expected: number) {
      if (typeof actual !== 'number' || !(actual > expected)) throw new Error(`expected > ${expected}, got ${JSON.stringify(actual)}${where}`);
    },
    toBeLessThan(expected: number) {
      if (typeof actual !== 'number' || !(actual < expected)) throw new Error(`expected < ${expected}, got ${JSON.stringify(actual)}${where}`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(`expected truthy, got ${JSON.stringify(actual)}${where}`);
    },
  };
}

export function run() {
  let failed = 0;
  for (const c of cases) {
    try {
      c.fn();
      console.log(`  ok   ${c.name}`);
    } catch (error) {
      failed++;
      console.log(`  FAIL ${c.name}\n       ${(error as Error).message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed) throw new Error(`${failed} test(s) failed`);
}
