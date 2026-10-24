// Headless walk through the whole flow against a running dev server: guide intro, quiz, tutorial, practice.
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

await page.getByRole('button', { name: /begin/i }).click();
await page.waitForTimeout(1200);
console.log('quiz url:', page.url());
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
await page.waitForTimeout(1500);
console.log('after quiz url:', page.url());
const tutReady = await page.locator('.mr[data-state="ready"]').waitFor({ timeout: 25000 }).then(() => true).catch(() => false);
console.log('tutorial guide ready:', tutReady, '| caption:', await page.locator('.cap-text').innerText().catch(() => '(none)'));
await page.waitForTimeout(9000);
console.log('tutorial caption later:', await page.locator('.cap-text').innerText().catch(() => '(none)'));
await snap('tutorial');
// Through to the hands-on part: the guide shrinks, the learner's mic drives the graph.
await page.getByRole('button', { name: /Allow microphone/ }).waitFor({ timeout: 30000 });
await page.getByRole('button', { name: /Allow microphone/ }).click();
await page.waitForTimeout(2500);
console.log('solo caption:', await page.locator('.cap-text').innerText().catch(() => '(none)'), '| pip:', await page.locator('.tut-pip .mr').getAttribute('data-state'));
await page.locator('.cap-pause').click();
console.log('paused:', await page.locator('.cap-pause').getAttribute('aria-pressed'));
await snap('tutorial-solo');
await page.locator('.cap-pause').click();
await page.getByRole('button', { name: 'Skip' }).click();
await page.waitForTimeout(1500);
console.log('practice url:', page.url(), '| caption:', await page.locator('.cap-text').innerText().catch(() => '(none)'));
await snap('practice');
// On your own: the same stage without cues, reached by its route.
await page.goto(base + '/#/own', { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
console.log('own url:', page.url(), '| word:', await page.locator('.own-word').innerText().catch(() => '(none)'), '| caption:', await page.locator('.cap-text').innerText().catch(() => '(none)'));
await snap('own');
await page.getByRole('radio', { name: /Word/ }).click();
await page.getByRole('button', { name: 'Record' }).click();
await page.waitForTimeout(2500);
await page.getByRole('button', { name: /Stop/ }).click();
await page.locator('.lp-sheet').waitFor({ timeout: 15000 });
await page.waitForTimeout(1200);
console.log('own sheet:', (await page.locator('.lp-sheet').innerText()).replace(/\s+/g, ' ').slice(0, 300));
await snap('own-result');
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
