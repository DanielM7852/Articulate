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
const lastOpacity = (page: Page) => page.locator('linearGradient stop[offset="1"]').last().getAttribute('stop-opacity').then(Number);

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

test('a glide has connected curves and an age gradient; stalled ink fully evaporates', async ({ page }) => {
  await render(page);
  await expect(page.locator('.vowel-trail')).toHaveCount(2);
  const paths = await page.locator('.vowel-trail').evaluateAll((paths) => paths.map((p) => p.getAttribute('d')!));
  expect(paths.every((d) => d.includes(' C'))).toBe(true);
  expect(paths[1].split(' C')[0].slice(1)).toBe(paths[0].split(' ').at(-1));
  const stops = await page.locator('linearGradient stop').evaluateAll((stops) => stops.map((s) => Number(s.getAttribute('stop-opacity'))));
  expect(stops[0]).toBeLessThan(stops.at(-1)!);
  await page.screenshot({ path: 'test-results/trail-glide.png' });
  const initial = await lastOpacity(page);
  await page.clock.runFor(1000);
  expect(await lastOpacity(page)).toBeLessThan(initial);
  await page.clock.runFor(2100);
  await expect(page.locator('.vowel-trail, linearGradient, [data-testid="cursor"]')).toHaveCount(0);
  expect(await pending(page)).toBe(0);
});

test('a held vowel keeps the head steady, then a new segment starts without reviving the old one', async ({ page }) => {
  await render(page);
  await expect(page.getByTestId('cursor')).toBeVisible();
  const location = await page.getByTestId('cursor').getAttribute('transform');
  await page.clock.runFor(1500);
  const oldOpacity = await lastOpacity(page);
  const held = { ...trace.at(-1)!, timestampMs: 525 };
  await render(page, { point: held });
  await expect(page.getByTestId('cursor')).toHaveAttribute('opacity', '1');
  await expect(page.getByTestId('cursor')).toHaveAttribute('transform', location!);
  // Existing ink retains its age when audio timestamps resume behind wall time.
  expect(Number(await page.locator('linearGradient stop[offset="1"]').nth(1).getAttribute('stop-opacity'))).toBeLessThanOrEqual(oldOpacity);
  const next = { timestampMs: 550, f1: 350, f2: 800, segment: 1 };
  await render(page, { trace: [...trace, held, next], point: next });
  await expect(page.locator('.vowel-trail')).toHaveCount(3);
  await expect(page.locator('.vowel-trail[data-segment="1"]')).toHaveCount(0);
  await render(page, { trace: [...trace, held, next], point: { ...next, timestampMs: 575, f1: 400 } });
  await expect(page.locator('.vowel-trail[data-segment="1"]')).toHaveCount(1);
});

test('Finish restores the retained static trace; restart and unmount cancel animation', async ({ page }) => {
  await render(page);
  await expect(page.locator('.vowel-trail')).toHaveCount(2);
  await page.clock.runFor(3100);
  await expect(page.locator('.vowel-trail')).toHaveCount(0);
  await render(page, { live: false });
  await expect(page.locator('.vowel-trail')).toHaveCount(2);
  await expect(page.getByTestId('cursor')).toHaveAttribute('opacity', '1');
  expect(await pending(page)).toBe(0);
  const held = await page.locator('.vowel-plot').innerHTML();
  await page.clock.runFor(4000);
  expect(await page.locator('.vowel-plot').innerHTML()).toBe(held);
  await render(page, { trace: [], point: null });
  await expect(page.locator('.vowel-trail')).toHaveCount(0);
  expect(await pending(page)).toBe(0);
  await render(page);
  await expect(page.locator('.vowel-trail')).toHaveCount(2);
  expect(await pending(page)).toBe(1);
  await page.evaluate(() => window.trailHarness.unmount());
  expect(await pending(page)).toBe(0);
});

test('background time expires ink without replaying frames on return', async ({ page }) => {
  await render(page);
  await expect(page.locator('.vowel-trail')).toHaveCount(2);
  await page.evaluate(() => window.trailHarness.visibility(true));
  expect(await pending(page)).toBe(0);
  await page.clock.runFor(5000);
  await page.evaluate(() => window.trailHarness.visibility(false));
  await expect(page.locator('.vowel-trail, linearGradient')).toHaveCount(0);
  expect(await pending(page)).toBe(0);
});

test('reduced motion uses straight strokes, still fades, and clips ink on mobile and desktop', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await render(page);
  await expect(page.locator('.vowel-trail').first()).toHaveAttribute('d', / L/);
  expect(await pending(page)).toBe(0);
  const initial = await lastOpacity(page);
  await page.clock.runFor(1000);
  expect(await lastOpacity(page)).toBeLessThan(initial);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('.vowel-trail').first().locator('..')).toHaveAttribute('clip-path', /url\(#.+-clip\)/);
  }
  await page.screenshot({ path: 'test-results/trail-reduced-motion.png' });
  await page.clock.runFor(2100);
  await expect(page.locator('.vowel-trail')).toHaveCount(0);
});
