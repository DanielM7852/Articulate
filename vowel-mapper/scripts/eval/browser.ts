/** Real public speech through Chromium's fake device -> real capture/worklet/worker/UI. */
import { chromium, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const args=process.argv.slice(2), option=(name:string)=>args[args.indexOf(name)+1];
if(!args.includes('--data-dir')||!args.includes('--url')||!args.includes('--screenshots')) throw new Error('Required --data-dir --url --screenshots');
const data=resolve(option('--data-dir')), directory=resolve(option('--screenshots')), url=option('--url');
mkdirSync(directory,{recursive:true});
// Repeat a real vowel nucleus to keep a stationary sound visible; no synthesis.
execFileSync('ffmpeg',['-v','error','-nostdin','-y','-i',resolve(data,'m01iy.wav'),'-ss','0.15','-t','0.15','-ar','48000','-ac','1',resolve(data,'held-vowel-excerpt.wav')]);
execFileSync('ffmpeg',['-v','error','-nostdin','-y','-stream_loop','19','-i',resolve(data,'held-vowel-excerpt.wav'),'-c:a','pcm_s16le',resolve(data,'held-vowel-repeat.wav')]);
const fixtures=[
  {name:'held-vowel',file:'held-vowel-repeat.wav',wait:2200,description:'Repeated 150ms excerpt of Hillenbrand m01iy; repetition is artificial, source speech is real.'},
  {name:'hvd-word',file:'m01uw.wav',wait:3500,description:'Original h-V-d who’d word, Hillenbrand m01uw; Chromium repeats the file.'},
  {name:'natural-nasal-sentence',file:'777-126732-0071.wav',wait:4200,description:'LibriSpeech natural sentence: mister verloc was fully responsive now. Includes M/N and voiced fricatives; no phone identity is inferred by UI.'},
  {name:'natural-glide',file:'m01ei.wav',wait:3500,description:'Original Hillenbrand hayed /eɪ/ h-V-d word. This is not a scripted ee-ah-oo glide.'},
];
const report=[];
for(const fixture of fixtures){
  const browser=await chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${resolve(data,fixture.file)}`]});
  try{
    const context=await browser.newContext({permissions:['microphone'],viewport:{width:1280,height:1120}});
    const page=await context.newPage(), errors:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    await page.getByRole('button',{name:'Start',exact:true}).click();
    await expect.poll(async()=>Number(await page.getByTestId('accepted-frames').textContent()),{timeout:15000}).toBeGreaterThan(2);
    await page.waitForTimeout(fixture.wait);
    await page.getByRole('button',{name:'Finish',exact:true}).click();
    await expect(page.getByTestId('tracking-status')).toHaveText('Trace held');
    await page.locator('summary').filter({hasText:'Tracking details'}).click();
    const accepted=Number(await page.getByTestId('accepted-frames').textContent());
    const cursor=page.getByTestId('cursor');
    const position={f1:await cursor.getAttribute('data-f1'),f2:await cursor.getAttribute('data-f2')};
    const screenshot=resolve(directory,fixture.name+'.png');
    await page.screenshot({path:screenshot,fullPage:true});
    expect(errors).toEqual([]);
    report.push({...fixture,accepted,position,screenshot,errors});
    if(fixture.name==='natural-nasal-sentence'){
      await page.getByRole('checkbox',{name:'Consonant cue preview'}).check();
      await page.screenshot({path:resolve(directory,'consonant-cue-preview.png'),fullPage:true});
      await page.setViewportSize({width:320,height:1000});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:resolve(directory,'consonant-cue-mobile.png'),fullPage:true});
    }
    console.log(fixture.name,accepted,position);
  } finally {await browser.close();}
}
writeFileSync(resolve(directory,'browser-results.json'),JSON.stringify({url,manifestPresent:!!readFileSync(resolve(data,'manifest.json')),fixtures:report},null,2));
