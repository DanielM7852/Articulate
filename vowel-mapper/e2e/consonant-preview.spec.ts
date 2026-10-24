import { expect, test } from '@playwright/test';

test('consonant cue prototype stays off by default and never starts the microphone', async ({page}) => {
  await page.goto('/');
  await page.getByText('Tracking details', {exact:false}).first().click();
  const toggle=page.getByRole('checkbox',{name:'Consonant cue preview'});
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId('consonant-cue-lane')).toHaveCount(0);
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('consonant-cue-lane')).toBeVisible();
  await expect(page.getByText('Scripted example only. These cues are not detected from your microphone.')).toBeVisible();
  await expect(page.getByTestId('tracking-status')).toHaveText('Ready when you are');
  await expect(page.getByRole('button',{name:'Finish',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'ween',exact:true}).click();
  await expect(page.getByTestId('consonant-cue-lane')).toContainText('ee');
  for(const width of [320,1280]){
    await page.setViewportSize({width,height:1000});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await toggle.uncheck();
  await expect(page.getByTestId('consonant-cue-lane')).toHaveCount(0);
});
