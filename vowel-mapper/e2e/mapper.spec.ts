import { expect, test } from '@playwright/test';

test('a synthetic microphone drives the real pipeline; Finish releases it and restart clears the trace', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const streams: MediaStream[] = [];
    Object.assign(window, { testStreams: streams });
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      streams.push(stream);
      return stream;
    };
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Finish', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByTestId('tracking-status')).toHaveText('Tracking vowel', { timeout: 15000 });
  await expect(page.getByTestId('cursor')).toBeVisible();
  await expect.poll(async () => Number(await page.getByTestId('accepted-frames').textContent())).toBeGreaterThan(5);
  await expect(page.getByTestId('cue-low-high')).toHaveText(/^-?\d+\.\d dB$/);
  await expect.poll(async () => Math.abs(Number(await page.getByTestId('cursor').getAttribute('data-f2')) - 1200), { timeout: 10000 }).toBeLessThan(160);
  await expect.poll(async () => Math.abs(Number(await page.getByTestId('cursor').getAttribute('data-f2')) - 800), { timeout: 10000 }).toBeLessThan(160);
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(page.getByTestId('tracking-status')).toHaveText('Trace held');
  const count = await page.getByTestId('accepted-frames').textContent();
  await expect(page.getByTestId('cursor')).toBeVisible();
  expect(await page.evaluate(() => {
    const streams = (window as unknown as { testStreams: MediaStream[] }).testStreams;
    return streams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended'));
  })).toBe(true);
  await page.screenshot({ path: 'test-results/mapper-desktop.png', fullPage: true });
  await page.waitForTimeout(250);
  await expect(page.getByTestId('accepted-frames')).toHaveText(count!);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByTestId('accepted-frames')).toHaveText('0');
  await expect(page.getByTestId('tracking-status')).toHaveText('Tracking vowel');
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  expect(errors).toEqual([]);
});

test('permission denial provides a visual recovery path', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByText('Microphone access was blocked.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Finish', exact: true })).toBeDisabled();
});

test('Finish during a pending permission request releases the eventual microphone', async ({ page }) => {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      Object.assign(window, { delayedStream: stream });
      await new Promise((resolve) => setTimeout(resolve, 500));
      return stream;
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByTestId('tracking-status')).toHaveText('Allow microphone access');
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { delayedStream?: MediaStream }).delayedStream))).toBe(true);
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { delayedStream: MediaStream }).delayedStream.getTracks().every((track) => track.readyState === 'ended'))).toBe(true);
  await expect(page.getByTestId('tracking-status')).toHaveText('No trace captured');
});

test('stopping analysis leaves an externally owned stream live', async ({ page }) => {
  test.skip(process.env.MAPPER_PREVIEW === '1', 'Reusable source API is exercised in dev; preview serves only the production bundle.');
  await page.goto('/');
  const result = await page.evaluate(async () => {
    // Exercise the reusable capture API, with a stream owned by the parent app.
    const path = '/src/audio/capture.ts';
    const { createMicrophoneSession } = await import(/* @vite-ignore */ path);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    let frames = 0;
    const session = await createMicrophoneSession({ stream, onFrame: () => { frames++; }, onError: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 300));
    session.stop();
    const live = stream.getAudioTracks()[0].readyState === 'live';
    stream.getTracks().forEach((track) => track.stop());
    return { live, frames };
  });
  expect(result.live).toBe(true);
  expect(result.frames).toBeGreaterThan(0);
});

test('mobile layout stays within the viewport and keyboard controls remain accessible', async ({ page }) => {
  await page.goto('/');
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect.poll(() => page.locator('.axis-ticks text').evaluateAll((labels) => Math.min(...labels.map((label) => label.getBoundingClientRect().height)))).toBeGreaterThanOrEqual(10);
  }
  await page.getByRole('button', { name: 'Start', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tracking-status')).toHaveText('Tracking vowel');
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  await page.screenshot({ path: 'test-results/mapper-mobile.png', fullPage: true });
});

test('stalled audio fades the old cursor and changes the visible tracking status', async ({ page }) => {
  await page.addInitScript(() => {
    const contexts: AudioContext[] = [];
    Object.assign(window, { testContexts: contexts });
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) { super(options); contexts.push(this); }
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByTestId('tracking-status')).toHaveText('Tracking vowel');
  await page.evaluate(async () => {
    const contexts = (window as unknown as { testContexts: AudioContext[] }).testContexts;
    await Promise.all(contexts.map((context) => context.suspend()));
  });
  await expect(page.getByTestId('tracking-status')).toHaveText('Audio paused');
  await expect(page.getByTestId('cursor')).toHaveClass(/is-faded/);
  // No new worker packets are needed to age out either the ribbon or head.
  await expect(page.locator('.vowel-trail')).toHaveCount(0, { timeout: 5000 });
  await expect(page.getByTestId('cursor')).toHaveCount(0);
  await page.evaluate(async () => {
    const contexts = (window as unknown as { testContexts: AudioContext[] }).testContexts;
    await Promise.all(contexts.map((context) => context.resume()));
  });
  await expect(page.getByTestId('tracking-status')).toHaveText('Tracking vowel');
  await expect(page.getByTestId('cursor')).not.toHaveClass(/is-faded/);
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
});
