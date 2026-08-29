/**
 * Separator contract.
 * @typedef {{ pcm: Float32Array, sampleRate: number, channels: number, ptsSec: number, durationSec: number }} AudioChunk
 */
export class Separator {
  async init() {}
  async process(chunk) { return chunk; }
  get info() {
    return { id: "base", name: "Separator", license: "MIT", backend: "none", sampleRate: 48000 };
  }
  dispose() {}
}
export function cloneChunk(chunk) {
  return { pcm: chunk.pcm.slice(), sampleRate: chunk.sampleRate, channels: chunk.channels, ptsSec: chunk.ptsSec, durationSec: chunk.durationSec };
}
export function downmixMono(chunk) {
  const ch = chunk.channels || 1;
  if (ch === 1) return chunk.pcm;
  const frames = Math.floor(chunk.pcm.length / ch);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += chunk.pcm[i * ch + c];
    mono[i] = s / ch;
  }
  return mono;
}
export function upmix(mono, channels) {
  const ch = channels || 1;
  if (ch === 1) return mono;
  const out = new Float32Array(mono.length * ch);
  for (let i = 0; i < mono.length; i++) {
    for (let c = 0; c < ch; c++) out[i * ch + c] = mono[i];
  }
  return out;
}
