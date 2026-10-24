import { expect, test, type Page } from '@playwright/test';
import type { VowelPlotProps } from '../src/components/VowelPlot';
import type { VowelPoint } from '../src/audio/tracker';

const trace: VowelPoint[] = [
  { timestampMs: 0, f1: 300, f2: 2300, segment: 0 },
  { timestampMs: 250, f1: 450, f2: 1900, segment: 0 },
  { timestampMs: 500, f1: 700, f2: 1300, segment: 0 },
];
const render = (page: Page, props: Partial<VowelPlotProps> = {}) => page.evaluate((props) => window.trailHarness.render(props), {
  trace, point: trace.at(-1)!, faded: false, live: true, ...props,
});
const pending = (page: Page) => page.evaluate(() => window.trailHarness.pendingFrames());
const outlines = (page: Page) => page.locator('.vowel-trail').evaluateAll((paths) => paths.map((p) => p.getAttribute('d')!));
const vertices = (d: string) => {
  const xy = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  return Array.from({ length: xy.length / 2 }, (_, i) => ({ x: xy[2 * i], y: xy[2 * i + 1] }));
};
/** Total ink area (shoelace): shrinks as ribbons taper with age. */
const inkArea = async (page: Page) => (await outlines(page)).reduce((total, d) => {
  const points = vertices(d);
  const twice = points.reduce((sum, p, i) => {
    const q = points[(i + 1) % points.length];
    return sum + p.x * q.y - q.x * p.y;
  }, 0);
  return total + Math.abs(twice) / 2;
}, 0);

test.beforeEach(async ({ page }) => {
  test.skip(process.env.MAPPER_PREVIEW === '1', 'Deterministic component harness uses the Vite dev server.');
  await page.goto('/');
  await page.clock.install();
  await page.evaluate(async () => {
    const path = '/e2e/trailHarness.tsx';
    const { mountTrail } = await import(/* @vite-ignore */ path);
    window.trailHarness = mountTrail();
  });
});

test('a glide is one smooth tapered ribbon; stalled ink fully evaporates', async ({ page }) => {
  await render(page);
  await expect(page.locator('.vowel-trail')).toHaveCount(1);
  await expect(page.locator('linearGradient')).toHaveCount(0);
  const [d] = await outlines(page);
  expect(d).toMatch(/^M.* Z$/);
  // Outline runs tail→head on one side, head→tail on the other: the older tail is narrower.
  const points = vertices(d);
  const half = points.length / 2;
  const width = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  expect(width(points[0], points.at(-1)!)).toBeLessThan(width(points[half - 1], points[half]));
  // Curved: the glide is subdivided, not drawn as two straight pieces.
  expect(points.length).toBeGreaterThan(6);
  await page.screenshot({ path: 'test-results/trail-glide.png' });
  const initial = await inkArea(page);
  await page.clock.runFor(1000);
  expect(await inkArea(page)).toBeLessThan(initial);
  await page.clock.runFor(2100);
  await expect(page.locator('.vowel-trail, [data-testid="cursor"]')).toHaveCount(0);
  expect(await pending(page)).toBe(0);
});

test('a held vowel keeps the head steady, then a new segment starts without reviving the old one', async ({ page }) => {
  await render(page);
  await expect(page.getByTestId('cursor')).toBeVisible();
  const location = await page.getByTestId('cursor').getAttribute('transform');
  const fresh = await inkArea(page);
  await page.clock.runFor(1500);
  const held = { ...trace.at(-1)!, timestampMs: 525 };
  await render(page, { point: held });
  await expect(page.getByTestId('cursor')).toHaveAttribute('opacity', '1');
  await expect(page.getByTestId('cursor')).toHaveAttribute('transform', location!);
  await expect(page.getByTestId('cursor')).toHaveAttribute('data-f1', String(held.f1));
  // Existing ink retains its age when audio timestamps resume behind wall time.
  expect(await inkArea(page)).toBeLessThan(fresh * 0.8);
  const next = { timestampMs: 550, f1: 350, f2: 800, segment: 1 };
  await render(page, { trace: [...trace, held, next], point: next });
  await expect(page.locator('.vowel-trail')).toHaveCount(1);
  await expect(page.locator('.vowel-trail[data-segment="1"]')).toHaveCount(0);
  await render(page, { trace: [...trace, held, next], point: { ...next, timestampMs: 575, f1: 400 } });
  // The new stroke grows out from its first sample as the head eases in.
  await page.clock.runFor(200);
  await expect(page.locator('.vowel-trail[data-segment="1"]')).toHaveCount(1);
  await expect(page.getByTestId('cursor')).toHaveAttribute('data-f1', '400');
});

test('Finish restores the retained static trace; restart and unmount cancel animation', async ({ page }) => {
  await render(page);
  await expect(page.locator('.vowel-trail')).toHaveCount(1);
  await page.clock.runFor(3100);
  await expect(page.locator('.vowel-trail')).toHaveCount(0);
  await render(page, { live: false });
  await expect(page.locator('.vowel-trail')).toHaveCount(1);
  await expect(page.getByTestId('cursor')).toHaveAttribute('opacity', '1');
  expect(await pending(page)).toBe(0);
  const held = await page.locator('.vowel-plot').innerHTML();
  await page.clock.runFor(4000);
  expect(await page.locator('.vowel-plot').innerHTML()).toBe(held);
  await render(page, { trace: [], point: null });
  await expect(page.locator('.vowel-trail')).toHaveCount(0);
  expect(await pending(page)).toBe(0);
  await render(page);
  await expect(page.locator('.vowel-trail')).toHaveCount(1);
  expect(await pending(page)).toBe(1);
  await page.evaluate(() => window.trailHarness.unmount());
  expect(await pending(page)).toBe(0);
});

test('background time expires ink without replaying frames on return', async ({ page }) => {
  await render(page);
  await expect(page.locator('.vowel-trail')).toHaveCount(1);
  await page.evaluate(() => window.trailHarness.visibility(true));
  expect(await pending(page)).toBe(0);
  await page.clock.runFor(5000);
  await page.evaluate(() => window.trailHarness.visibility(false));
  await expect(page.locator('.vowel-trail')).toHaveCount(0);
  expect(await pending(page)).toBe(0);
});

test('reduced motion uses straight strokes, still fades, and clips ink on mobile and desktop', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await render(page);
  // Straight strokes: one outline vertex per side per sample (3 samples, 6 vertices).
  await expect(page.locator('.vowel-trail')).toHaveCount(1);
  expect(vertices((await outlines(page))[0])).toHaveLength(6);
  expect(await pending(page)).toBe(0);
  const initial = await inkArea(page);
  await page.clock.runFor(1000);
  expect(await inkArea(page)).toBeLessThan(initial);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('.vowel-trail').first().locator('..')).toHaveAttribute('clip-path', /url\(#.+-clip\)/);
  }
  await page.screenshot({ path: 'test-results/trail-reduced-motion.png' });
  await page.clock.runFor(2100);
  await expect(page.locator('.vowel-trail')).toHaveCount(0);
});
