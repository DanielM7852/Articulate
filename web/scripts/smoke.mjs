// Headless walk through the whole flow against a running dev server: guide intro (Go), quiz, word lesson.
// Usage: npm run smoke [-- http://127.0.0.1:5173]. Screenshots land in web/smoke-out/. Uses fake camera and mic devices.
import { mkdirSync } from 'node:fs';
mkdirSync(process.env.SMOKE_OUT ?? 'smoke-out', { recursive: true });
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`);
  else if (m.text().includes('[pointcloud]')) console.log(m.text().slice(0, 600));
});
const snap = async (name) => page.screenshot({ path: `${process.env.SMOKE_OUT ?? 'smoke-out'}/${name}.png` });
/** Poll the hash route; the intro's assemble/greeting/disperse timing is not fixed, so wait up to `ms`. */
const waitForHash = async (hash, ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (new URL(page.url()).hash.startsWith(hash)) return true;
    await page.waitForTimeout(250);
  }
  return false;
};

await page.goto(base + '/#/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const rootText = (await page.locator('#root').innerText().catch(() => '')).slice(0, 200);
console.log('root text:', JSON.stringify(rootText));
// wait for the guide
const ready = await page.locator('.mr[data-state="ready"]').waitFor({ timeout: 25000 }).then(() => true).catch(() => false);
console.log('guide ready:', ready, '| mr state:', await page.locator('.mr').getAttribute('data-state'));
await page.waitForTimeout(4500);
console.log('caption:', await page.locator('.cap-text').innerText().catch(() => '(none)'));
console.log('camera pill:', await page.locator('.intro-camera').innerText().catch(() => '(none)'));
await snap('intro');
// Pointer fallback: the guide should glance toward the pointer with its eyes and a slight head turn.
const eyes = { x: 380, y: 150, width: 520, height: 220 };
await page.mouse.move(1260, 120);
await page.waitForTimeout(1800);
await page.screenshot({ path: `${process.env.SMOKE_OUT ?? 'smoke-out'}/eyes-right-up.png`, clip: eyes });
await page.mouse.move(20, 760);
await page.waitForTimeout(1800);
await page.screenshot({ path: `${process.env.SMOKE_OUT ?? 'smoke-out'}/eyes-left-down.png`, clip: eyes });
// Pointer over the face: dots near it scatter, then settle back once it leaves.
await page.mouse.move(600, 330, { steps: 12 });
await page.mouse.move(680, 400, { steps: 12 });
await page.waitForTimeout(250);
await page.screenshot({ path: `${process.env.SMOKE_OUT ?? 'smoke-out'}/scatter.png`, clip: { x: 420, y: 200, width: 440, height: 360 } });
await page.mouse.move(1100, 700);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${process.env.SMOKE_OUT ?? 'smoke-out'}/scatter-settled.png`, clip: { x: 420, y: 200, width: 440, height: 360 } });

// Intro: Go -> the guide assembles, greets, disperses -> quiz.
const go = page.getByRole('button', { name: /^\s*go\b/i });
if (await go.count()) await go.first().click();
else await page.getByRole('button', { name: /begin/i }).click(); // older intro
console.log('reached quiz:', await waitForHash('#/quiz/1', 40000), '| url:', page.url());
await page.getByRole('button', { name: 'Continue' }).waitFor({ timeout: 15000 });
console.log('quiz caption:', await page.locator('.cap-text').innerText().catch(() => '(none)'));
console.log('continue disabled:', await page.getByRole('button', { name: 'Continue' }).isDisabled());
console.log('checked options:', await page.locator('[aria-checked="true"]').count());
await page.getByRole('checkbox', { name: /Everyday conversations/ }).click();
console.log('continue after answer disabled:', await page.getByRole('button', { name: 'Continue' }).isDisabled());
await snap('quiz');
await page.getByRole('button', { name: 'Continue' }).click();
await page.waitForTimeout(600);
await page.getByRole('radio', { name: /Just exploring/ }).click();
await page.getByRole('radio', { name: 'Steady' }).click();
await page.getByRole('button', { name: 'Continue' }).click();
await page.waitForTimeout(600);
await page.getByRole('radio', { name: /Watching the mouth/ }).click();
await page.getByRole('radio', { name: 'A little guidance' }).click();
await page.getByRole('button', { name: 'Continue' }).click();
// Quiz -> word lesson: Ava on the left, the word board on the right.
const lesson = await waitForHash('#/lesson');
console.log('reached lesson:', lesson, '| url:', page.url());
if (!lesson) errors.push(`expected #/lesson after the quiz, got ${page.url()}`);
const board = await page.locator('.wl-board > *').first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
if (!board) errors.push('word board did not render');
const lessonGuide = await page.locator('.wl-guide .mr[data-state="ready"]').waitFor({ timeout: 25000 }).then(() => true).catch(() => false);
console.log('board:', board, '| lesson guide ready:', lessonGuide);
await page.waitForTimeout(4000);
console.log('lesson phase:', await page.locator('.wl-stage').getAttribute('data-phase').catch(() => '(none)'));
console.log('lesson caption:', await page.locator('.cap-text').innerText().catch(() => '(none)'));
console.log('lesson pills:', (await page.locator('.wl-guide .lp-pill').allInnerTexts().catch(() => [])).join(' | '));
await snap('lesson');
// The loop is hands-free: give the board and the coach time for one attempt, then look again.
await page.waitForTimeout(8000);
console.log('lesson later | phase:', await page.locator('.wl-stage').getAttribute('data-phase').catch(() => '(none)'), '| caption:', await page.locator('.cap-text').first().innerText().catch(() => '(none)'));
await snap('lesson-later');
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
