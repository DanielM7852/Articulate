import { readFileSync } from 'node:fs';

export interface Phone { start: number; end: number; phoneme: string; group?: string }
export interface Reference { timeMs: number; f1: number; f2: number; f3: number }

export function phoneGroup(phone: string): string | null {
  const p = phone.replace(/[012]$/, '');
  if (['AA','AE','AH','AO','AW','AY','EH','ER','EY','IH','IY','OW','OY','UH','UW'].includes(p)) return 'vowel';
  if (['M','N','NG'].includes(p)) return 'nasal';
  if (['V','Z','ZH','DH'].includes(p)) return 'voiced-fricative';
  if (['F','S','SH','TH','HH'].includes(p)) return 'unvoiced-fricative';
  if (['P','B','T','D','K','G'].includes(p)) return 'stop';
  if (['W','Y','R','L'].includes(p)) return 'glide-liquid';
  if (['CH','JH'].includes(p)) return 'affricate';
  return null;
}

/** Full 50-ms window, not merely its center, must fit inside one aligned phone. */
export function labelFrame(phones: Phone[], startMs: number, endMs: number) {
  const phone = phones.find(p => startMs >= p.start * 1000 - 1e-7 && endMs <= p.end * 1000 + 1e-7);
  const group = phone && (phone.group ?? phoneGroup(phone.phoneme));
  return phone && group ? { ...phone, group } : null;
}

export function referenceAt(refs: Reference[], timeMs: number): Omit<Reference, 'timeMs'> | null {
  if (!refs.length || timeMs < refs[0].timeMs || timeMs > refs.at(-1)!.timeMs) return null;
  const right = refs.findIndex(r => r.timeMs >= timeMs);
  const a = refs[Math.max(0, right - 1)], b = refs[right];
  if (a.f1 <= 0 || a.f2 <= 0 || b.f1 <= 0 || b.f2 <= 0) return null;
  const mix = a.timeMs === b.timeMs ? 0 : (timeMs-a.timeMs)/(b.timeMs-a.timeMs);
  return { f1:a.f1+(b.f1-a.f1)*mix, f2:a.f2+(b.f2-a.f2)*mix, f3:a.f3>0&&b.f3>0?a.f3+(b.f3-a.f3)*mix:0 };
}

export function readWav(path: string) {
  const bytes=readFileSync(path);
  if (bytes.toString('ascii',0,4)!=='RIFF' || bytes.toString('ascii',8,12)!=='WAVE') throw new Error(`Not a WAV: ${path}`);
  let rate=0, channels=0, bits=0, format=0, data: Buffer | undefined;
  for(let p=12;p+8<=bytes.length;){
    const id=bytes.toString('ascii',p,p+4), length=bytes.readUInt32LE(p+4), start=p+8;
    if(start+length>bytes.length) throw new Error(`Truncated WAV: ${path}`);
    if(id==='fmt '){ format=bytes.readUInt16LE(start); channels=bytes.readUInt16LE(start+2); rate=bytes.readUInt32LE(start+4); bits=bytes.readUInt16LE(start+14); }
    if(id==='data') data=bytes.subarray(start,start+length);
    p=start+length+(length%2);
  }
  if(format!==1 || channels!==1 || bits!==16 || !data || rate!==48000) throw new Error(`Require 48k mono PCM16: ${path}`);
  return {rate,samples:Float32Array.from({length:data.length/2},(_,i)=>data!.readInt16LE(i*2)/32768)};
}

export function rms(samples: Float32Array) {
  return Math.sqrt(samples.reduce((sum,v)=>sum+v*v,0)/samples.length);
}

/** Noise is scaled to annotated active-speech RMS. No limiter, gain normalization, or clipping. */
export function mixAtSnr(speech: Float32Array, noise: Float32Array, snr: number, speechRms: number, offset: number) {
  const segment = Float32Array.from(speech,(_,i)=>noise[(i+offset)%noise.length]);
  const noiseRms=rms(segment), gain=speechRms/(10**(snr/20)*noiseRms);
  const samples=Float32Array.from(speech,(v,i)=>v+gain*segment[i]);
  return {samples,achievedSnrDb:20*Math.log10(speechRms/(noiseRms*gain)),overRange:samples.reduce((n,v)=>n+(Math.abs(v)>1?1:0),0)};
}

export function median(values: number[]): number | null {
  if(!values.length) return null;
  const s=[...values].sort((a,b)=>a-b), mid=s.length>>1;
  return s.length%2?s[mid]:(s[mid-1]+s[mid])/2;
}
