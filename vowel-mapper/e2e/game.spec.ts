import { expect, test, type Page } from '@playwright/test';
import { vowelSignal } from '../tests/signals';

// Same synthetic vowels as the file-based fixture in setup.ts, but switchable on cue: the warm-up
// prompts and self-paced notes decide when each sound starts, so a fixed looping file cannot line up.
const VOWELS = { ee: [300, 2300, 3000], ah: [750, 1200, 2600], oo: [350, 800, 2400], aw: [650, 1050, 2600], ih: [480, 1900, 2900], eh: [680, 1700, 2800], ae: [920, 1550, 2700] };
const screenshotDir = process.env.MAPPER_SCREENSHOTS ?? 'test-results';
const clips = Object.fromEntries(Object.entries(VOWELS).map(([name, formants]) => {
  // 0.5 s at 120 Hz pitch is a whole number of periods, so the loop seam is clean.
  const samples = vowelSignal({ formants, sampleRate: 48000, seconds: 0.5 });
  const pcm = Int16Array.from(samples, (value) => Math.round(value * 32767));
  return [name, Buffer.from(pcm.buffer).toString('base64')];
}));

type Sound = keyof typeof VOWELS | 'noise' | null;

async function installSyntheticMicrophone(page: Page) {
  await page.addInitScript((encoded: Record<string, string>) => {
    let play: (sound: string | null) => void = () => {};
    Object.assign(window, { setSyntheticSound: (sound: string | null) => play(sound) });
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext({ sampleRate: 48000 });
      await context.resume();
      const destination = context.createMediaStreamDestination();
      const buffers: Record<string, AudioBuffer> = {};
      for (const [name, base64] of Object.entries(encoded)) {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const pcm = new Int16Array(bytes.buffer);
        const buffer = context.createBuffer(1, pcm.length, 48000);
        buffer.getChannelData(0).set(Float32Array.from(pcm, (v) => v / 32767));
        buffers[name] = buffer;
      }
      const noise = context.createBuffer(1, 48000, 48000);
      noise.getChannelData(0).set(Float32Array.from({ length: 48000 }, () => (Math.random() * 2 - 1) * 0.3));
      buffers.noise = noise;
      let current: AudioBufferSourceNode | null = null;
      play = (sound) => {
        current?.stop();
        current = null;
        if (!sound) return;
        current = context.createBufferSource();
        current.buffer = buffers[sound];
        current.loop = true;
        current.connect(destination);
        current.start();
      };
      return destination.stream;
    };
  }, clips);
}

const say = (page: Page, sound: Sound) => page.evaluate((s) => (window as unknown as { setSyntheticSound(s: string | null): void }).setSyntheticSound(s), sound);

async function warmUp(page: Page, screenshot = false) {
  const status = page.getByTestId('game-status');
  await page.getByRole('button', { name: 'Start warm-up' }).click();
  for (const [vowel, label, next] of [['ee', 'eee', 'Next: ah'], ['ah', 'ah', 'Next: oo'], ['oo', 'oo', null]] as const) {
    await expect(status).toHaveText(`Hold ${label}`, { timeout: 15000 });
    await say(page, vowel);
    if (screenshot && vowel === 'ah') {
      await expect.poll(async () => Number((await page.locator('.game-meter-count').textContent())?.split('/')[0]), { timeout: 5000 }).toBeGreaterThan(10);
      await page.screenshot({ path: `${screenshotDir}/game-warmup.png` });
    }
    if (next) await expect(status).toHaveText(next, { timeout: 10000 });
    else await expect(status).not.toHaveText(`Hold ${label}`, { timeout: 10000 });
    await say(page, null);
  }
  await expect(status).toHaveText('Your zones are set');
}

test('zone game: warm-up sets personal zones, then hit, miss and "not heard clearly" all show through the real pipeline', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  const offDevice: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (!request.url().startsWith(baseURL!) && !/^(data|blob):/.test(request.url())) offDevice.push(request.url()); });
  await installSyntheticMicrophone(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Game', exact: true }).click();
  const status = page.getByTestId('game-status');
  await expect(status).toHaveText('Set your zones first');

  await warmUp(page, true);
  for (const vowel of ['ee', 'ah', 'oo']) await expect(page.getByTestId(`zone-${vowel}`)).toBeVisible();
  await expect(page.getByLabel('Wait for me')).toBeChecked();
  const eeShape = await page.getByTestId('zone-ee').locator('polygon').getAttribute('points');
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await page.getByRole('button', { name: 'Game', exact: true }).click();
  await expect(status).toHaveText('Your zones are set');
  await expect(page.getByTestId('zone-ee').locator('polygon')).toHaveAttribute('points', eeShape!);

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const outcome = (i: number) => page.getByTestId(`outcome-${i}`);

  // 1. "ah": hold steady → hit.
  await expect(status).toHaveText('Say “ah”', { timeout: 10000 });
  await expect(page.getByTestId('game-word')).toHaveAttribute('aria-label', 'Word: ah');
  await page.setViewportSize({ width: 320, height: 844 });
  const card = await page.getByTestId('game-word').boundingBox();
  const plot = await page.locator('.game-workspace .vowel-plot').boundingBox();
  expect(card!.y + card!.height).toBeLessThan(plot!.y);
  await page.screenshot({ path: `${screenshotDir}/game-playing-320.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await say(page, 'ah');
  await expect(outcome(0)).toHaveAttribute('data-outcome', 'hit', { timeout: 10000 });
  await say(page, null);

  // 2. "hi": the h is a cue only; glide ah → ee → hit.
  await expect(status).toHaveText('Say “hi”', { timeout: 10000 });
  await expect(page.getByTestId('game-word')).toContainText('breath only · not scored');
  await say(page, 'ah');
  await expect(page.getByTestId('glide-path')).toBeVisible();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${screenshotDir}/game-glide.png` });
  await say(page, 'ee');
  await expect(outcome(1)).toHaveAttribute('data-outcome', 'hit', { timeout: 10000 });
  await say(page, null);

  // 3. "how" wants ah → oo; gliding to ee instead is heard clearly but misses.
  await expect(status).toHaveText('Say “how”', { timeout: 10000 });
  await say(page, 'ah');
  await page.waitForTimeout(700);
  await say(page, 'ee');
  await expect(outcome(2)).toHaveAttribute('data-outcome', 'miss', { timeout: 10000 });
  await say(page, null);

  // 4. "we" with only broadband noise: the tracker accepts nothing, so it is not heard clearly, not a miss.
  await expect(status).toHaveText('Say “we”', { timeout: 10000 });
  await say(page, 'noise');
  await page.waitForTimeout(3000);
  await expect(status).toHaveText('Say “we”');
  await page.getByRole('button', { name: 'Try this word' }).click();
  await expect(status).toHaveText('2 of 3 zones hit', { timeout: 10000 });
  await say(page, null);
  await expect(page.getByTestId('game-tally')).toHaveText('1 not heard clearly, so not counted.');
  await expect(page.getByTestId('result-3')).toContainText('Not heard clearly');
  await page.screenshot({ path: `${screenshotDir}/game-desktop.png`, fullPage: true });

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({ path: `${screenshotDir}/game-mobile.png`, fullPage: true });
  expect(errors).toEqual([]);
  expect(offDevice).toEqual([]);
});

test('zone game, timed: an approach ring closes visually, and silence is "not heard clearly", never a miss', async ({ page }) => {
  test.setTimeout(60000);
  await installSyntheticMicrophone(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Game', exact: true }).click();
  await warmUp(page);
  await page.getByLabel('Timed rings').check();
  await expect(page.getByLabel('Tempo')).toHaveValue('5000');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const ring = page.getByTestId('approach-ring');
  await expect(ring).toBeVisible({ timeout: 5000 });
  const first = Number(await ring.getAttribute('rx'));
  await page.waitForTimeout(500);
  await expect.poll(async () => Number(await ring.getAttribute('rx'))).toBeLessThan(first);
  await page.screenshot({ path: `${screenshotDir}/game-timed.png` });
  await expect(page.getByTestId('outcome-0')).toHaveAttribute('data-outcome', 'unheard', { timeout: 10000 });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByTestId('game-status')).toHaveText('Your zones are set');
});


test('lesson selection locks unsupported words and asks for each extra personal vowel', async ({ page }) => {
  test.setTimeout(60000);
  await installSyntheticMicrophone(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Game', exact: true }).click();
  await warmUp(page);
  await expect(page.getByLabel('Lesson', { exact: true })).toBeVisible();
  await page.getByLabel('Lesson', { exact: true }).selectOption('nasals');
  await expect(page.getByTestId('lesson-lock')).toContainText('Nasal endings');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
  await page.getByLabel('Lesson', { exact: true }).selectOption('ladder');
  await expect(page.getByRole('button', { name: 'Set lesson zones' })).toBeVisible();
  await page.getByRole('button', { name: 'Set lesson zones' }).click();
  await expect(page.getByRole('list', { name: 'Warm-up sounds' })).toHaveText('eeesheepihbitehbetabat');
  await expect(page.getByTestId('game-status')).toHaveText('Hold eee', { timeout: 10000 });
  await say(page, 'ee');
  await expect(page.getByTestId('game-status')).toHaveText('Next: ih', { timeout: 10000 });
  await say(page, null);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByLabel('Lesson', { exact: true }).selectOption('sweep');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByTestId('game-word')).toHaveAttribute('aria-label', 'Word: we');
  await expect(page.getByTestId('game-progress')).toHaveText('1 / 5');
  await expect(page.getByTestId('game-word')).toContainText('letter cue · not scored');
});


test('extra personal calibrations and every available lesson play through the microphone pipeline', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await installSyntheticMicrophone(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Game', exact: true }).click();
  await warmUp(page);
  const status = page.getByTestId('game-status');
  const selector = page.getByLabel('Lesson', { exact: true });
  const baseEe = await page.getByTestId('zone-ee').locator('polygon').getAttribute('points');

  const collect = async (sounds: readonly [Sound, string][]) => {
    await page.getByRole('button', { name: 'Set lesson zones' }).click();
    for (let index = 0; index < sounds.length; index++) {
      const [vowel, label] = sounds[index];
      await expect(status).toHaveText(`Hold ${label}`, { timeout: 12000 });
      await say(page, vowel);
      if (index < sounds.length - 1) await expect(status).toHaveText(`Next: ${sounds[index + 1][1]}`, { timeout: 10000 });
      else await expect(status).toHaveText('Your zones are set', { timeout: 10000 });
      await say(page, null);
    }
  };
  const finishWord = async (word: string, from: Sound, to?: Sound) => {
    await expect(status).toHaveText(`Say “${word}”`, { timeout: 10000 });
    await say(page, from);
    if (to) {
      await page.waitForTimeout(450);
      await say(page, to);
    }
    await expect(status).not.toHaveText(new RegExp(`^(Say “${word}”|Hold |Glide )`), { timeout: 6000 });
    await say(page, null);
  };

  await selector.selectOption('ladder');
  await collect([['ee', 'eee'], ['ih', 'ih'], ['eh', 'eh'], ['ae', 'a']]);
  for (const vowel of ['ee', 'ih', 'eh', 'ae']) await expect(page.getByTestId(`zone-${vowel}`)).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/game-ladder-ready.png`, fullPage: true });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await finishWord('beat', 'ee');
  await finishWord('bit', 'ih');
  await finishWord('bet', 'eh');
  await finishWord('bat', 'ae');
  await expect(status).toHaveText('4 of 4 zones hit');
  await page.screenshot({ path: `${screenshotDir}/game-ladder-results.png`, fullPage: true });
  await page.getByRole('button', { name: 'Choose lesson' }).click();
  await expect(page.locator('.game-last-result')).toHaveText('Last round: 4 zones hit · 0 not heard clearly.');

  await selector.selectOption('boy');
  await collect([['aw', 'aw'], ['ee', 'eee']]);
  await page.screenshot({ path: `${screenshotDir}/game-boy-ready.png`, fullPage: true });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await finishWord('boy', 'aw', 'ee');
  await expect(status).toHaveText('1 of 1 zones hit');
  await page.getByRole('button', { name: 'Choose lesson' }).click();

  await selector.selectOption('starter');
  await expect(page.getByTestId('zone-ee').locator('polygon')).toHaveAttribute('points', baseEe!);
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await page.getByRole('button', { name: 'Game', exact: true }).click();
  await selector.selectOption('ladder');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await selector.selectOption('glides');
  await page.screenshot({ path: `${screenshotDir}/game-glides-ready.png`, fullPage: true });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await finishWord('hi', 'ah', 'ee');
  await finishWord('buy', 'ah', 'ee');
  await finishWord('how', 'ah', 'oo');
  await expect(page.getByRole('note')).toContainText('Nasal humming');
  await page.screenshot({ path: `${screenshotDir}/game-now-caveat.png`, fullPage: true });
  await finishWord('now', 'ah', 'oo');
  await expect(status).toHaveText('4 of 4 zones hit');
  await page.getByRole('button', { name: 'Choose lesson' }).click();

  await selector.selectOption('sweep');
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${screenshotDir}/game-sweep-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Play', exact: true }).focus();
  await page.keyboard.press('Enter');
  await finishWord('we', 'oo', 'ee');
  await finishWord('key', 'ee');
  await finishWord('coo', 'oo');
  await finishWord('tea', 'ee');
  await finishWord('two', 'oo');
  await expect(status).toHaveText('5 of 5 zones hit');
  await page.getByRole('button', { name: 'Choose lesson' }).click();
  await selector.selectOption('nasals');
  await page.screenshot({ path: `${screenshotDir}/game-nasals-locked.png`, fullPage: true });
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});


test('the ready game can release the microphone while retaining its personal zones', async ({ page }) => {
  test.setTimeout(30000);
  await installSyntheticMicrophone(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Game', exact: true }).click();
  await warmUp(page);
  await expect(page.getByRole('button', { name: 'Turn off microphone' })).toBeVisible();
  await page.getByRole('button', { name: 'Turn off microphone' }).click();
  await expect(page.getByRole('button', { name: 'Turn off microphone' })).toHaveCount(0);
  await expect(page.getByTestId('zone-ee')).toBeVisible();
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Finish', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
});
