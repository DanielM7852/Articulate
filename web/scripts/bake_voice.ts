// Prebake the fixed scripted lines (src/audio/bakedLines.ts) into public/voice/ so they play without TTS credits.
//
//   cd web && npx tsx scripts/bake_voice.ts [--force] [--retime]
//   --retime rewrites part-sound phonemes/words in the existing manifest from durationS, without calling Cartesia.
//
// Reads CARTESIA_API_KEY (and optionally CARTESIA_VOICE_ID / CARTESIA_MODEL_ID / CARTESIA_VERSION) from the
// environment. Settings mirror the live path: backend/app/config.py (model sonic-3.6, version 2026-08-14, default voice
// Ella) and the WebSocket request in src/audio/teacher.ts (pcm_f32le @ 24000, word + phoneme timestamps, language en).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PART_SOUND_LINES, PART_SOUNDS } from '../src/game/ghost/partSounds';
import { BAKED_LINES } from '../src/audio/bakedLines';
import { phonemesFromBlock, wordsFromBlock, type BakedEntry, type BakedManifest } from '../src/audio/bakedVoice';
import { ipaSymbols, spreadPhonemes } from '../src/audio/partPhonemes';
import { encodeWav16 } from '../src/audio/attemptAudio';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'voice');
const SAMPLE_RATE = 24000;
const DEFAULT_VOICE = '2a12b36c-7f9b-4c3a-9f7a-72731b15323a'; // backend cartesia_default_voice_id (Ella)
const WS_URL = 'wss://api.cartesia.ai/tts/websocket';

const apiKey = process.env.CARTESIA_API_KEY || '';
const voiceId = process.env.CARTESIA_VOICE_ID || DEFAULT_VOICE;
const modelId = process.env.CARTESIA_MODEL_ID || 'sonic-3.6';
const version = process.env.CARTESIA_VERSION || '2026-08-14';
const force = process.argv.includes('--force');
const retime = process.argv.includes('--retime');

const PART_SET = new Set<string>(PART_SOUND_LINES);
/** Part sounds whose IPA only comes out right with a trailing consonant (isolated vowels drift): the consonant is cut off at the first closure. */
const CUT_AT_CLOSURE = new Set<string>(['<<æ|t>>']);

const rmsDb = (x: Float32Array, from: number, to: number) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return 20 * Math.log10(Math.max(1e-9, Math.sqrt(s / Math.max(1, to - from))));
};

/** Part sounds are triggered on an animation phase, so the audio must start at ~0: trim leading silence to ~20 ms and
 *  trailing silence to ~80 ms, shift the timestamps to match, and peak-normalise (Cartesia isolated sounds are quiet). */
function polishPartSound(text: string, input: Float32Array, entry: Omit<BakedEntry, 'file'>) {
  let samples = input;
  const frame = Math.round(SAMPLE_RATE * 0.01);
  if (CUT_AT_CLOSURE.has(text)) {
    let peak = -200;
    let onsetF = -1;
    for (let f = 0; (f + 1) * frame <= samples.length; f++) {
      const d = rmsDb(samples, f * frame, (f + 1) * frame);
      if (onsetF < 0 && d > -35) onsetF = f;
      if (onsetF >= 0) peak = Math.max(peak, d);
    }
    for (let f = Math.max(0, onsetF) + 3; (f + 2) * frame <= samples.length; f++) {
      if (rmsDb(samples, f * frame, (f + 1) * frame) < peak - 20 && rmsDb(samples, (f + 1) * frame, (f + 2) * frame) < peak - 20) {
        samples = samples.slice(0, f * frame);
        const fade = Math.min(samples.length, Math.round(SAMPLE_RATE * 0.02));
        for (let i = 0; i < fade; i++) samples[samples.length - 1 - i] *= i / fade;
        break;
      }
    }
  }
  const thr = Math.pow(10, -35 / 20);
  let first = -1;
  let last = -1;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    if (a > thr) { if (first < 0) first = i; last = i; }
  }
  if (first < 0) return { samples, entry };
  const start = Math.max(0, first - Math.round(SAMPLE_RATE * 0.02));
  const end = Math.min(samples.length, last + 1 + Math.round(SAMPLE_RATE * 0.08));
  const gain = Math.min(5.6, Math.pow(10, -3 / 20) / Math.max(peak, 1e-6)); // peak to about -3 dBFS, at most +15 dB
  const out = new Float32Array(end - start);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, samples[start + i] * gain));
  const shift = start / SAMPLE_RATE;
  const dur = out.length / SAMPLE_RATE;
  const clip = (t: number) => +Math.max(0, Math.min(dur, t - shift)).toFixed(3);
  return {
    samples: out,
    entry: {
      durationS: +dur.toFixed(3),
      words: entry.words.map((w) => ({ ...w, start: clip(w.start), end: clip(w.end) })),
      phonemes: entry.phonemes.map((p) => ({ ...p, start: clip(p.start), end: clip(p.end) })),
    },
  };
}

const CAPTION_OF = new Map<string, string>(Object.values(PART_SOUNDS).flatMap((parts) => Object.values(parts).map((s) => [s.say, s.caption] as [string, string])));
/** Plain-text part sounds: symbols Cartesia may return for them, and the fixed fallback. */
const PLAIN_PART: Record<string, { ok: Set<string>; fixed: string[] }> = {
  eee: { ok: new Set(['i', 'iː', 'ɪ']), fixed: ['i'] },
  rrr: { ok: new Set(['ɹ', 'r', 'ɚ', 'ɝ']), fixed: ['ɹ'] },
  nt: { ok: new Set(['n', 't']), fixed: ['n', 't'] },
};
const ONSET_S = 0.02;
const TAIL_PAD_S = 0.08;

/** Replace a part sound's phonemes/words with ones derived from what it actually says (see partPhonemes.ts). */
function retimePart(text: string, e: Omit<BakedEntry, 'file'>): Omit<BakedEntry, 'file'> {
  const end = +Math.max(ONSET_S, e.durationS - TAIL_PAD_S).toFixed(3);
  const words = [{ text: CAPTION_OF.get(text) ?? text, start: ONSET_S, end }];
  let symbols = ipaSymbols(text);
  if (!symbols) {
    const plain = PLAIN_PART[text];
    const got = e.phonemes.map((p) => p.p);
    if (plain && got.length && got.every((s) => plain.ok.has(s))) return { ...e, words };
    symbols = plain ? plain.fixed : got;
  }
  const phonemes = spreadPhonemes(symbols, ONSET_S, end, CUT_AT_CLOSURE.has(text) ? { cut: 1 } : {});
  return { ...e, words, phonemes };
}

const slugOf = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 10);

function synth(text: string): Promise<{ samples: Float32Array; entry: Omit<BakedEntry, 'file'> }> {
  return new Promise((resolve, reject) => {
    const url = `${WS_URL}?cartesia_version=${encodeURIComponent(version)}&api_key=${encodeURIComponent(apiKey)}`;
    const ws = new WebSocket(url);
    const contextId = crypto.randomUUID();
    const parts: Buffer[] = [];
    const words: BakedEntry['words'] = [];
    const phonemes: BakedEntry['phonemes'] = [];
    const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('timeout')); }, 60_000);
    const finish = () => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      const bytes = Buffer.concat(parts);
      const whole = bytes.length - (bytes.length % 4);
      const view = new DataView(bytes.buffer, bytes.byteOffset, whole);
      const samples = new Float32Array(whole / 4);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getFloat32(i * 4, true);
      resolve({ samples, entry: { durationS: +(samples.length / SAMPLE_RATE).toFixed(3), words, phonemes } });
    };
    ws.onopen = () => ws.send(JSON.stringify({
      model_id: modelId,
      transcript: text,
      voice: { mode: 'id', id: voiceId },
      output_format: { container: 'raw', encoding: 'pcm_f32le', sample_rate: SAMPLE_RATE },
      context_id: contextId,
      language: 'en',
      add_timestamps: true,
      add_phoneme_timestamps: true,
      continue: false,
    }));
    ws.onerror = () => { clearTimeout(timer); reject(new Error('websocket error')); };
    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (typeof msg.context_id === 'string' && msg.context_id !== contextId) return;
      switch (msg.type) {
        case 'chunk':
          if (typeof msg.data === 'string') parts.push(Buffer.from(msg.data, 'base64'));
          if (msg.done === true) finish();
          break;
        case 'timestamps': words.push(...wordsFromBlock(msg.word_timestamps)); break;
        case 'phoneme_timestamps': phonemes.push(...phonemesFromBlock(msg.phoneme_timestamps)); break;
        case 'done': finish(); break;
        case 'error': clearTimeout(timer); reject(new Error(String(msg.message ?? msg.title ?? 'cartesia error'))); break;
      }
    };
  });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const manifestPath = join(OUT, 'manifest.json');
  let manifest: BakedManifest = {};
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BakedManifest; } catch { /* first run */ }
  if (retime) {
    let n = 0;
    for (const text of PART_SOUND_LINES) {
      if (!manifest[text]) continue;
      const { file, ...rest } = manifest[text];
      manifest[text] = { file, ...retimePart(text, rest) };
      n++;
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`retimed ${n} part sounds`);
    return;
  }
  const next: BakedManifest = {};
  let baked = 0;
  for (const text of BAKED_LINES) {
    const slug = slugOf(text);
    const file = `/voice/${slug}.wav`;
    const prior = manifest[text];
    if (!force && prior && prior.file === file && existsSync(join(OUT, `${slug}.wav`))) {
      next[text] = prior;
      console.log(`skip  ${slug}  ${text.slice(0, 50)}`);
      continue;
    }
    if (!apiKey) throw new Error('CARTESIA_API_KEY is not set.');
    const raw = await synth(text);
    const isPart = PART_SET.has(text);
    // Part sounds are inline IPA, for which Cartesia may return no word timestamps; audio is enough there.
    if (!raw.samples.length || (!isPart && (!raw.entry.words.length || !raw.entry.phonemes.length))) throw new Error(`empty result for: ${text}`);
    const polished = isPart ? polishPartSound(text, raw.samples, raw.entry) : raw;
    const samples = polished.samples;
    const entry = isPart ? retimePart(text, polished.entry) : polished.entry;
    writeFileSync(join(OUT, `${slug}.wav`), encodeWav16(samples, SAMPLE_RATE));
    next[text] = { file, ...entry };
    baked++;
    console.log(`baked ${slug}  ${entry.durationS}s  words=${entry.words.length} phonemes=${entry.phonemes.length}`);
  }
  writeFileSync(manifestPath, JSON.stringify(next, null, 2) + '\n');
  console.log(`done: ${baked} baked, ${BAKED_LINES.length - baked} unchanged`);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
