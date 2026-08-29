/**
 * Decode -> ML -> processed. minLookahead 8s, target 20s, max 30s.
 * ML runs in an extension Worker via MessagePort; MAIN only posts PCM.
 */
import { OpusDecoder } from "../decode/opus-decoder.js";
import { PcmBuffer } from "../pcm/buffer.js";
import { PcmClock } from "../playback/clock.js";
import { Bench } from "../metrics/bench.js";
import {
  MIN_LOOKAHEAD_SEC,
  TARGET_LOOKAHEAD_SEC,
  MAX_LOOKAHEAD_SEC,
  lookaheadSec,
  shouldRunMl,
  mlIsPriority
} from "./lookahead.js";

export {
  MIN_LOOKAHEAD_SEC,
  TARGET_LOOKAHEAD_SEC,
  MAX_LOOKAHEAD_SEC,
  lookaheadSec,
  shouldRunMl,
  mlIsPriority
};

const PREFIX = "[yt-isolate]";
const KEEP_BEHIND_SEC = 2;
const KEEP_AHEAD_SEC = 45;

export class IsolatePipeline {
  constructor() {
    const self = this;
    this.original = new PcmBuffer();
    this.processed = new PcmBuffer();
    this.pendingPackets = [];
    this._waitingForConfig = [];
    this.decoder = new OpusDecoder(
      function (chunk) { self._onDecoded(chunk); },
      function () { self.bench.decodeErrors = self.decoder.errors; }
    );
    this.clock = new PcmClock(this);
    this.bench = new Bench();
    this.packetsIn = 0;
    this.mlBusy = false;
    this.mlIn = 0;
    this._inflight = null;
    this._mlSentAt = 0;
    this.mlSink = null;
    this.enabled = false;
    this.mode = "isolated";
    this.status = "idle";
    this.emeSkip = false;
    this.audioCodec = "";
    this.audioMime = "";
    this.modelInfo = { id: "deepfilternet3", name: "DeepFilterNet3", license: "Apache-2.0 OR MIT", backend: "wasm", sampleRate: 48000 };
    this.videoTime = 0;
    this._config = null;
    this.addSourceBufferCount = 0;
    this.workersCreated = 0;
    this._logIv = null;
  }

  setMlSink(fn) {
    this.mlSink = fn;
    if (this.status === "idle") this.status = "model-loading";
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.clock.setEnabled(this.enabled);
    if (this.enabled && this.status === "idle") this.status = "processing";
    if (!this.enabled) this.status = "idle";
  }

  setMode(mode) {
    this.mode = mode === "original" ? "original" : "isolated";
    this.clock._stopAll();
  }

  setVideo(video) {
    this.clock.bind(video);
  }

  markEme(on) {
    this.emeSkip = !!on;
    if (on) {
      this.status = "drm";
      this.decoder.state = "skip-eme";
      console.log(PREFIX, "[DECODER] video.mediaKeys set — skip decode (encrypted)");
    }
  }

  resetAll() {
    this.decoder.reset();
    this.original.clear();
    this.processed.clear();
    this.pendingPackets = [];
    this._waitingForConfig = [];
    this.packetsIn = 0;
    this.mlBusy = false;
    this.mlIn = 0;
    this._inflight = null;
    this._mlSentAt = 0;
    this._config = null;
    this.clock._stopAll();
    this.bench = new Bench();
    if (this.mlSink) {
      try { this.mlSink({ type: "reset" }); } catch (e) {}
    }
    console.log(PREFIX, "[PCM] full reset (navigation / new video)");
  }

  resetDecoder() {
    this.decoder.reset();
    this._waitingForConfig = [];
    this.clock._stopAll();
    console.log(PREFIX, "[DECODER] new init — decoder reset");
  }

  pushPackets(result) {
    if (!result) return;
    if (result.reset) this.resetDecoder();
    const info = result.info || {};
    if (info.config) this._config = info.config;
    if (this.emeSkip) return;
    const packets = result.packets || [];
    if (!this.decoder.decoder && this._config) this.decoder.configure(this._config);
    for (let i = 0; i < packets.length; i++) {
      this.packetsIn++;
      const pkt = packets[i];
      if (!this.decoder.decoder) {
        this._waitingForConfig.push(pkt);
        continue;
      }
      this._maybeDecode(pkt);
    }
    if (this.decoder.decoder && this._waitingForConfig.length) {
      const queued = this._waitingForConfig;
      this._waitingForConfig = [];
      for (let q = 0; q < queued.length; q++) this._maybeDecode(queued[q]);
    }
  }

  _maybeDecode(pkt) {
    if (pkt.ptsSec > (this.videoTime || 0) + KEEP_AHEAD_SEC) {
      this.pendingPackets.push(pkt);
      return;
    }
    this.decoder.decode(pkt);
  }

  drainPending(videoTime) {
    this.videoTime = videoTime || 0;
    if (!this.decoder.decoder || !this.pendingPackets.length) return;
    const keep = [];
    for (let i = 0; i < this.pendingPackets.length; i++) {
      const p = this.pendingPackets[i];
      if (p.ptsSec <= this.videoTime + KEEP_AHEAD_SEC) this.decoder.decode(p);
      else keep.push(p);
    }
    this.pendingPackets = keep;
  }

  onClockTick(t) {
    this.videoTime = t || 0;
    this.original.trim(t, KEEP_BEHIND_SEC, KEEP_AHEAD_SEC);
    this.processed.trim(t, KEEP_BEHIND_SEC, KEEP_AHEAD_SEC);
    this.drainPending(t);
    this._unstickMl();
    this._pumpMl();
  }

  _unstickMl() {
    if (!this.mlBusy) return;
    const age = Date.now() - (this._mlSentAt || 0);
    if (age < 4000) return;
    console.log(PREFIX, "[ML] process timed out after", age, "ms — retry");
    if (this._inflight) this._inflight._mlSent = false;
    this.mlBusy = false;
    this._inflight = null;
  }

  chunksForPlayback(from, to) {
    if (this.mode === "original") return this.original.inRange(from, to);
    const iso = this.processed.inRange(from, to);
    if (iso.length) return iso;
    const orig = this.original.inRange(from, to);
    if (orig.length) this.bench.late++;
    return orig;
  }

  _onDecoded(chunk) {
    this.original.push(chunk);
    this._pumpMl();
  }

  _pumpMl() {
    if (!this.enabled || this.emeSkip) return;
    if (this.status === "unsupported" || this.status === "drm" || this.status === "unsupported-codec") return;
    if (this.status === "model-loading") return;
    if (!this.mlSink || this.mlBusy) return;
    const ct = this.videoTime || 0;
    const pe = this.processed.endSec == null ? 0 : this.processed.endSec;
    if (!shouldRunMl(pe, ct)) return;
    const chunks = this.original.chunks;
    let chunk = null;
    for (let i = 0; i < chunks.length; i++) {
      if (!chunks[i]._mlSent) { chunk = chunks[i]; break; }
    }
    if (!chunk) return;
    chunk._mlSent = true;
    this.mlBusy = true;
    this._inflight = chunk;
    this._mlSentAt = Date.now();
    this.mlIn++;
    const pcmCopy = chunk.pcm.slice();
    const msg = {
      type: "process",
      chunk: {
        pcm: pcmCopy,
        sampleRate: chunk.sampleRate,
        channels: chunk.channels,
        ptsSec: chunk.ptsSec,
        durationSec: chunk.durationSec
      },
      priority: mlIsPriority(pe, ct)
    };
    try {
      this.mlSink(msg);
    } catch (e) {
      console.log(PREFIX, "[ML] sink post failed", String(e && e.message || e));
      this.mlBusy = false;
      chunk._mlSent = false;
    }
  }

  _onMlMessage(data) {
    if (!data) return;
    if (data.type === "ready") {
      this.modelInfo = data.info || this.modelInfo;
      this.bench.endLoad(data.info && data.info.backend || "wasm");
      this.bench.loadMs = data.loadMs || this.bench.loadMs;
      if (this.status === "model-loading" || this.status === "idle") {
        this.status = this.enabled ? "processing" : "idle";
      }
      return;
    }
    if (data.type === "model-error") {
      this.status = "model-error";
      this.modelInfo = data.info || { id: "gain", name: "Identity fallback", license: "MIT", backend: "cpu", sampleRate: 48000 };
      this.bench.backend = "cpu-fallback";
      console.log(PREFIX, "[ML] model-error, identity/gain fallback", data.error);
      return;
    }
    if (data.type === "processed") {
      const chunk = data.chunk;
      this.processed.push(chunk);
      this.mlBusy = false;
      this._inflight = null;
      if (data.wallMs && chunk) this.bench.recordProcess(data.wallMs, chunk.durationSec || 0);
      const line = this.bench.maybeLogOnce();
      if (line) console.log(PREFIX, line);
      if (this.enabled && this.status !== "drm" && this.status !== "unsupported" && this.status !== "unsupported-codec" && this.status !== "model-error") {
        this.status = "processing";
      }
      this._pumpMl();
    }
  }

  stats() {
    const ct = this.videoTime || 0;
    const pe = this.processed.endSec || 0;
    const de = this.original.endSec || 0;
    return {
      decodedStart: this.original.startSec || 0,
      decodedEnd: de,
      processedStart: this.processed.startSec || 0,
      processedEnd: pe,
      packetsIn: this.packetsIn,
      framesOut: this.decoder.framesOut,
      decodeErrors: this.decoder.errors,
      decoder: this.decoder.state,
      decoderOk: this.decoder.ok,
      pcmChunks: this.original.length,
      processedChunks: this.processed.length,
      pending: this.pendingPackets.length,
      mlIn: this.mlIn,
      emeSkip: this.emeSkip,
      configUsed: this.decoder.configUsed,
      lookahead: lookaheadSec(pe, ct),
      rtf: this.bench.rtf,
      loadMs: this.bench.loadMs,
      backend: this.bench.backend,
      late: this.bench.late,
      mode: this.mode,
      status: this.status,
      audioCodec: this.audioCodec,
      audioMime: this.audioMime,
      model: this.modelInfo,
      enabled: this.enabled,
      queues: {
        d: this.original.length,
        m: this.mlBusy ? 1 : 0,
        p: this.processed.length
      }
    };
  }
}
