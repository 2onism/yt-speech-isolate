import { Separator, downmixMono, upmix } from "./types.js";

export class DeepFilterNet3Separator extends Separator {
  constructor(opts) {
    super();
    opts = opts || {};
    this.wasmUrl = opts.wasmUrl || "";
    this.modelUrl = opts.modelUrl || "";
    this.attenLim = opts.attenLim == null ? 50 : opts.attenLim;
    this.handle = 0;
    this.frameLength = 0;
    this.remainder = new Float32Array(0);
    this.outRemain = new Float32Array(0);
    this.ready = false;
    this.loadMs = 0;
    this.postFilterBeta = opts.postFilterBeta == null ? 0.02 : opts.postFilterBeta;
  }

  async init() {
    const t0 = nowMs();
    const glue = await import("./df3/df.js");
    const wasmBytes = await fetchBuf(this.wasmUrl);
    const modelBytes = await fetchBuf(this.modelUrl);
    await glue.default({ module_or_path: wasmBytes });
    this._df = glue;
    this.handle = glue.df_create(new Uint8Array(modelBytes), this.attenLim);
    this.frameLength = glue.df_get_frame_length(this.handle);
    if (this.postFilterBeta == null) this.postFilterBeta = 0.02;
    glue.df_set_post_filter_beta(this.handle, this.postFilterBeta);
    this.ready = true;
    this.loadMs = nowMs() - t0;
  }

  async process(chunk) {
    if (!this.ready || !this.handle || !chunk || !chunk.pcm) return chunk;
    const glue = this._df;
    const monoIn = downmixMono(chunk);
    const combined = new Float32Array(this.remainder.length + monoIn.length);
    combined.set(this.remainder);
    combined.set(monoIn, this.remainder.length);
    const fl = this.frameLength;
    const nFrames = Math.floor(combined.length / fl);
    const processed = new Float32Array(nFrames * fl);
    let po = 0;
    for (let f = 0; f < nFrames; f++) {
      const frame = combined.subarray(f * fl, (f + 1) * fl);
      const out = glue.df_process_frame(this.handle, frame);
      processed.set(out, po);
      po += out.length;
    }
    this.remainder = combined.subarray(nFrames * fl);
    const allOut = new Float32Array(this.outRemain.length + processed.length);
    allOut.set(this.outRemain);
    allOut.set(processed, this.outRemain.length);
    const need = monoIn.length;
    let monoOut;
    if (allOut.length >= need) {
      monoOut = allOut.subarray(0, need);
      this.outRemain = allOut.subarray(need);
    } else {
      monoOut = new Float32Array(need);
      monoOut.set(allOut);
      this.outRemain = new Float32Array(0);
    }
    return {
      pcm: upmix(monoOut, chunk.channels || 1),
      sampleRate: chunk.sampleRate,
      channels: chunk.channels,
      ptsSec: chunk.ptsSec,
      durationSec: chunk.durationSec
    };
  }

  get info() {
    return {
      id: "deepfilternet3",
      name: "DeepFilterNet3",
      license: "Apache-2.0 OR MIT",
      backend: "wasm",
      sampleRate: 48000
    };
  }

  dispose() {
    this.handle = 0;
    this.ready = false;
    this.remainder = new Float32Array(0);
    this.outRemain = new Float32Array(0);
  }
}

function nowMs() {
  return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
}

async function fetchBuf(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("fetch " + url + " " + res.status);
  return res.arrayBuffer();
}
