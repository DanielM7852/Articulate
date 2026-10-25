// Prebake the fixed scripted lines (src/audio/bakedLines.ts) into public/voice/ so they play without TTS credits.
//
//   cd web && npx tsx scripts/bake_voice.ts [--force]
//
// Reads CARTESIA_API_KEY (and optionally CARTESIA_VOICE_ID / CARTESIA_MODEL_ID / CARTESIA_VERSION) from the
// environment. Settings mirror the live path: backend/app/config.py (model sonic-3.6, version 2026-08-14, default voice
// Ella) and the WebSocket request in src/audio/teacher.ts (pcm_f32le @ 24000, word + phoneme timestamps, language en).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BAKED_LINES } from '../src/audio/bakedLines';
import { phonemesFromBlock, wordsFromBlock, type BakedEntry, type BakedManifest } from '../src/audio/bakedVoice';
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
    const { samples, entry } = await synth(text);
    if (!samples.length || !entry.words.length || !entry.phonemes.length) throw new Error(`empty result for: ${text}`);
    writeFileSync(join(OUT, `${slug}.wav`), encodeWav16(samples, SAMPLE_RATE));
    next[text] = { file, ...entry };
    baked++;
    console.log(`baked ${slug}  ${entry.durationS}s  words=${entry.words.length} phonemes=${entry.phonemes.length}`);
  }
  writeFileSync(manifestPath, JSON.stringify(next, null, 2) + '\n');
  console.log(`done: ${baked} baked, ${BAKED_LINES.length - baked} unchanged`);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
