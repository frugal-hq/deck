// A silent tail makes Whisper invent text (Test 8), so a recording is cut to its voiced part before it is sent.
// frugal: an energy gate on the ends only; whisper.cpp's Silero VAD (a separate model) is the upgrade if background noise gets through.
export function trimSilence(samples, rate, { frameMs = 20, padMs = 250, floor = 0.01 } = {}) {
  const frame = Math.max(1, Math.round((rate * frameMs) / 1000));
  const levels = [];
  for (let start = 0; start < samples.length; start += frame) {
    const end = Math.min(start + frame, samples.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    levels.push(Math.sqrt(sum / (end - start)));
  }
  const peak = levels.reduce((max, level) => Math.max(max, level), 0);
  const gate = Math.max(floor, peak * 0.1);
  const first = levels.findIndex((level) => level >= gate);
  if (first === -1) return new Float32Array(0);
  const last = levels.findLastIndex((level) => level >= gate);
  const pad = Math.round((rate * padMs) / 1000);
  return samples.slice(Math.max(0, first * frame - pad), Math.min(samples.length, (last + 1) * frame + pad));
}

// 16-bit PCM mono WAV, the format whisper-cli reads.
export function encodeWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
  });
  return buffer;
}

export function joinChunks(chunks) {
  const samples = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return samples;
}
