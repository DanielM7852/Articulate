import assert from 'node:assert/strict';
import { WAVE_SAMPLES, WAVE_TONES, decodeWave, tonesFrom } from './waveCloud.ts';

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

// Silence (128 everywhere) decodes to zeros.
const silence = decodeWave(b64(new Array(WAVE_SAMPLES).fill(128)));
assert.ok(silence);
assert.equal(silence.length, WAVE_SAMPLES);
assert.ok(silence.every((v) => v === 0));

// Full scale decodes to about +-1.
const full = decodeWave(b64(Array.from({ length: WAVE_SAMPLES }, (_, i) => (i % 2 ? 255 : 0))));
assert.ok(full);
assert.equal(full[0], -1);
assert.ok(Math.abs(full[1] - 1) < 0.01);

// Missing, malformed or wrong-length payloads decode to null.
assert.equal(decodeWave(undefined), null);
assert.equal(decodeWave(42), null);
assert.equal(decodeWave('not base64!'), null);
assert.equal(decodeWave(b64(new Array(64).fill(128))), null);

// The four tones from the navy and mist tokens land within a few levels of dotFace's palette.
const tones = tonesFrom(' #203e68', 'rgb(203, 215, 230)');
assert.ok(tones);
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
tones.forEach((t, i) => rgb(t).forEach((c, j) => assert.ok(Math.abs(c - rgb(WAVE_TONES[i])[j]) <= 10, `${t} vs ${WAVE_TONES[i]}`)));
assert.equal(tonesFrom('', '#cbd7e6'), null);
assert.equal(WAVE_TONES.length, 4);

console.log('waveCloud ok');
