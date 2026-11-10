import assert from 'node:assert/strict';
import { trimSilence, encodeWav, joinChunks } from '../src/renderer/voice.mjs';

const RATE = 16000;
const tone = (seconds, level) => Float32Array.from({ length: seconds * RATE }, (_, i) => level * Math.sin((2 * Math.PI * 440 * i) / RATE));
const silence = (seconds) => new Float32Array(seconds * RATE);

// Leading and trailing silence goes, with 250 ms of padding on each side.
const trimmed = trimSilence(joinChunks([silence(1), tone(0.5, 0.3), silence(2)]), RATE);
assert.ok(Math.abs(trimmed.length - RATE) <= 320, `trimmed to ${trimmed.length}`);
assert.equal(trimSilence(silence(3), RATE).length, 0);
// Room noise under the floor counts as silence.
assert.equal(trimSilence(tone(1, 0.005), RATE).length, 0);
// A quiet word between loud ones stays.
assert.equal(trimSilence(joinChunks([tone(0.5, 0.3), tone(0.5, 0.05), tone(0.5, 0.3)]), RATE).length, 1.5 * RATE);

const wav = new DataView(encodeWav(Float32Array.from([0, 1, -1, 2]), RATE));
assert.equal(wav.byteLength, 44 + 8);
assert.equal(String.fromCharCode(...new Uint8Array(wav.buffer, 0, 4)), 'RIFF');
assert.equal(wav.getUint32(24, true), RATE);
assert.equal(wav.getUint32(40, true), 8);
assert.deepEqual([0, 1, 2, 3].map((i) => wav.getInt16(44 + i * 2, true)), [0, 32767, -32768, 32767]);
console.log('voice ok');
