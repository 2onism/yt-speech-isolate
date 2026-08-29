import { Separator } from "./types.js";

/** Passthrough / gain. Tests, A/B original, and ML-load fallback. */
export class GainSeparator extends Separator {
  constructor(gain = 1) {
    super();
    this.gain = gain;
  }

  async init() {}

  async process(chunk) {
    if (!chunk || !chunk.pcm) return chunk;
    const g = this.gain;
    if (g === 1) {
      return {
        pcm: chunk.pcm,
        sampleRate: chunk.sampleRate,
        channels: chunk.channels,
        ptsSec: chunk.ptsSec,
        durationSec: chunk.durationSec
      };
    }
    const pcm = new Float32Array(chunk.pcm.length);
    for (let i = 0; i < pcm.length; i++) pcm[i] = chunk.pcm[i] * g;
    return {
      pcm,
      sampleRate: chunk.sampleRate,
      channels: chunk.channels,
      ptsSec: chunk.ptsSec,
      durationSec: chunk.durationSec
    };
  }

  get info() {
    return {
      id: "gain",
      name: this.gain === 1 ? "Identity" : "Gain " + this.gain,
      license: "MIT",
      backend: "cpu",
      sampleRate: 48000
    };
  }
}
