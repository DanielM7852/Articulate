import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('reference check saves 3 s of 48 kHz mono audio as a local download', async ({ page }) => {
  await page.goto('/?check');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('button', { name: 'Save 3 s · eee' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^articulate-eee-.*\.wav$/);
  const wav = readFileSync((await download.path())!);
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.readUInt32LE(24)).toBe(48000);
  expect(wav.readUInt16LE(22)).toBe(1);
  const seconds = wav.readUInt32LE(40) / 2 / 48000;
  expect(seconds).toBeGreaterThan(2.8);
  expect(seconds).toBeLessThan(3.3);
  await expect(page.getByRole('button', { name: 'Save 3 s · eee' })).toBeEnabled();
});
