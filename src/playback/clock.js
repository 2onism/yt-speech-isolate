/**
 * AudioContext clocked to video.currentTime. Mutes YouTube when enabled.
 */

const PREFIX = "[yt-isolate]";
const SCHEDULE_HORIZON_SEC = 3;

export class PcmClock {
  constructor(pipeline) {
    this.pipeline = pipeline;
    this.ctx = null;
    this.video = null;
    this.scheduled = new Set();
    this.sources = [];
    this._bound = false;
    this._muteIv = null;
    this._tickIv = null;
    this.playingPts = 0;
    this.enabled = false;
    this._onPlay = this._onPlay.bind(this);
    this._onPause = this._onPause.bind(this);
    this._onSeek = this._onSeek.bind(this);
    this._onWaiting = this._onWaiting.bind(this);
    this._onPlaying = this._onPlaying.bind(this);
    this._forceMute = this._forceMute.bind(this);
    this._tick = this._tick.bind(this);
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) {
      this._stopAll();
      try { if (this.video) this.video.muted = false; } catch (e) {}
    } else {
      this._forceMute();
      this._tick();
    }
  }

  _ensureCtx() {
    if (this.ctx) return this.ctx;
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) {
        console.log(PREFIX, "[CLOCK] no AudioContext");
        return null;
      }
      this.ctx = new AC({ latencyHint: "interactive" });
    } catch (e) {
      console.log(PREFIX, "[CLOCK] AudioContext create failed", String(e && e.message || e));
    }
    return this.ctx;
  }

  bind(video) {
    if (!video) return;
    if (this.video === video && this._bound) return;
    this.unbind();
    this.video = video;
    this._bound = true;
    this._ensureCtx();
    video.addEventListener("play", this._onPlay);
    video.addEventListener("pause", this._onPause);
    video.addEventListener("seeking", this._onSeek);
    video.addEventListener("seeked", this._onSeek);
    video.addEventListener("ratechange", this._onSeek);
    video.addEventListener("emptied", this._onSeek);
    video.addEventListener("waiting", this._onWaiting);
    video.addEventListener("playing", this._onPlaying);
    video.addEventListener("volumechange", this._forceMute);
    this._muteIv = setInterval(this._forceMute, 250);
    this._tickIv = setInterval(this._tick, 100);
    if (this.enabled) this._forceMute();
    if (!video.paused) this._onPlay();
    console.log(PREFIX, "[CLOCK] bound to video");
  }

  unbind() {
    const video = this.video;
    if (video && this._bound) {
      try {
        video.removeEventListener("play", this._onPlay);
        video.removeEventListener("pause", this._onPause);
        video.removeEventListener("seeking", this._onSeek);
        video.removeEventListener("seeked", this._onSeek);
        video.removeEventListener("ratechange", this._onSeek);
        video.removeEventListener("emptied", this._onSeek);
        video.removeEventListener("waiting", this._onWaiting);
        video.removeEventListener("playing", this._onPlaying);
        video.removeEventListener("volumechange", this._forceMute);
      } catch (e) {}
    }
    if (this._muteIv) { clearInterval(this._muteIv); this._muteIv = null; }
    if (this._tickIv) { clearInterval(this._tickIv); this._tickIv = null; }
    this._stopAll();
    this.video = null;
    this._bound = false;
  }

  _forceMute() {
    if (!this.enabled) return;
    try { if (this.video) this.video.muted = true; } catch (e) {}
  }

  _onPlay() {
    if (this.enabled) this._forceMute();
    const ctx = this._ensureCtx();
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(function (e) {
        console.log(PREFIX, "[CLOCK] resume failed", String(e && e.message || e));
      });
    }
    this._tick();
  }

  _onPause() {
    if (this.enabled) this._forceMute();
    if (this.ctx && this.ctx.state === "running") this.ctx.suspend().catch(function () {});
  }

  _onWaiting() {
    if (this.ctx && this.ctx.state === "running") this.ctx.suspend().catch(function () {});
  }

  _onPlaying() {
    if (this.enabled) this._forceMute();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(function () {});
  }

  _onSeek() {
    if (this.enabled) this._forceMute();
    this._stopAll();
    this._tick();
  }

  _stopAll() {
    for (let i = 0; i < this.sources.length; i++) {
      try { this.sources[i].stop(); } catch (e) {}
      try { this.sources[i].disconnect(); } catch (e) {}
    }
    this.sources = [];
    this.scheduled.clear();
  }

  _tick() {
    const video = this.video;
    if (!video) return;
    if (this.enabled) this._forceMute();
    const t = video.currentTime || 0;
    this.playingPts = t;
    this.pipeline.onClockTick(t);
    if (!this.enabled) return;
    if (video.paused) return;
    const ctx = this._ensureCtx();
    if (!ctx || ctx.state === "closed") return;
    let rate = video.playbackRate;
    if (!(rate > 0)) rate = 0.01;
    const ctxT = ctx.currentTime;
    const chunks = this.pipeline.chunksForPlayback(t - 0.05, t + SCHEDULE_HORIZON_SEC);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const key = Math.round(chunk.ptsSec * 1e6);
      if (this.scheduled.has(key)) continue;
      const end = chunk.ptsSec + chunk.durationSec;
      if (end <= t) continue;
      let offset = 0;
      let when;
      if (chunk.ptsSec >= t) {
        when = ctxT + (chunk.ptsSec - t) / rate;
        offset = 0;
      } else {
        when = ctxT;
        offset = t - chunk.ptsSec;
      }
      if (when < ctxT - 0.02) continue;
      if (this._startChunk(chunk, Math.max(when, ctxT), offset, rate)) {
        this.scheduled.add(key);
      }
    }
  }

  _startChunk(chunk, when, offsetInto, rate) {
    const ctx = this.ctx;
    if (!ctx || !chunk || !chunk.pcm) return false;
    const channels = chunk.channels || 1;
    const frames = Math.floor(chunk.pcm.length / channels);
    if (frames <= 0) return false;
    try {
      const buf = ctx.createBuffer(channels, frames, chunk.sampleRate || 48000);
      if (channels === 1) {
        buf.copyToChannel(chunk.pcm, 0);
      } else {
        for (let ch = 0; ch < channels; ch++) {
          const dest = buf.getChannelData(ch);
          for (let i = 0; i < frames; i++) dest[i] = chunk.pcm[i * channels + ch];
        }
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      src.connect(ctx.destination);
      const self = this;
      src.onended = function () {
        const ix = self.sources.indexOf(src);
        if (ix >= 0) self.sources.splice(ix, 1);
      };
      if (offsetInto > 0) src.start(when, offsetInto);
      else src.start(when);
      this.sources.push(src);
      return true;
    } catch (e) {
      console.log(PREFIX, "[CLOCK] start chunk failed", String(e && e.message || e));
      return false;
    }
  }
}
