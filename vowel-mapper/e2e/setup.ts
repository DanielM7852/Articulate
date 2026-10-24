import { mkdirSync, writeFileSync } from 'node:fs';
import { vowelSignal } from '../tests/signals';

export default function setup() {
  const sampleRate = 48000;
  const vowels = [[300, 2300, 3000], [750, 1200, 2600], [350, 800, 2400]];
  const chunks = vowels.map((formants) => vowelSignal({ formants, sampleRate, seconds: 2 }));
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const wav = Buffer.alloc(44 + length * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(length * 2, 40);
  let offset = 44;
  for (const chunk of chunks) for (const value of chunk) {
    wav.writeInt16LE(Math.round(value * 32767), offset);
    offset += 2;
  }
  mkdirSync('node_modules/.cache', { recursive: true });
  writeFileSync('node_modules/.cache/microphone.wav', wav);
}
