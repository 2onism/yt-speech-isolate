/**
 * WebCodecs AudioDecoder for YouTube stereo A_OPUS (WebM SimpleBlock).
 *
 *   FAIL: { codec:'opus', sampleRate, numberOfChannels, description: OpusHead }
 *         W3C Opus registration treats description-set chunks as Ogg packets.
 *   FAIL: passing a Cluster element (1F43B675) as EncodedAudioChunk data.
 *   OK:   { codec:'opus', sampleRate:48000, numberOfChannels:2 }  // NO description
 *         EncodedAudioChunk.data = SimpleBlock payload = raw Opus packet.
 * Chrome does not require description for channels <= 2.
 */

const PREFIX = "[yt-isolate]";

function hexHead(u8, n) {
  n = n || 16;
  if (!u8) return "";
  const len = Math.min(n, u8.length);
  const out = new Array(len);
  for (let i = 0; i < len; i++) out[i] = (u8[i] < 16 ? "0" : "") + u8[i].toString(16);
  return out.join(" ");
}

export class OpusDecoder {
  constructor(onChunk, onError) {
    this.onChunk = onChunk;
    this.onError = onError;
    this.decoder = null;
    this.ok = false;
    this.state = "init";
    this.configUsed = null;
    this.errors = 0;
    this.framesOut = 0;
    this._lastPacket = null;
  }

  configure(cfg) {
    if (this.decoder) return;
    if (typeof AudioDecoder === "undefined") {
      this.state = "error";
      console.log(PREFIX, "[DECODER] AudioDecoder not available");
      return;
    }
    const config = {
      codec: "opus",
      sampleRate: (cfg && cfg.sampleRate) || 48000,
      numberOfChannels: (cfg && cfg.numberOfChannels) || 2
    };
    this.configUsed = {
      codec: config.codec,
      sampleRate: config.sampleRate,
      numberOfChannels: config.numberOfChannels,
      hasDescription: false
    };
    const self = this;
    try {
      this.decoder = new AudioDecoder({
        output: function (audioData) { self._onAudioData(audioData); },
        error: function (err) {
          self.errors++;
          self.ok = false;
          self.state = "error";
          const lp = self._lastPacket;
          console.log(PREFIX, "[DECODER] error " + String(err && err.message || err), {
            config: self.configUsed,
            pts: lp && lp.ptsSec,
            length: lp && lp.data && lp.data.length,
            hex16: lp && lp.data ? hexHead(lp.data, 16) : ""
          });
          if (self.onError) self.onError(err);
        }
      });
      this.decoder.configure(config);
      this.ok = true;
      this.state = "ok";
      console.log(PREFIX, "[DECODER] configured WITHOUT description (raw Opus packets)", config);
    } catch (e) {
      this.ok = false;
      this.state = "error";
      console.log(PREFIX, "[DECODER] configure threw " + String(e && e.message || e), config);
      this.close();
    }
  }

  decode(pkt) {
    if (!this.decoder || !pkt || !pkt.data) return;
    this._lastPacket = pkt;
    const ts = Math.round(pkt.ptsSec * 1e6);
    try {
      this.decoder.decode(new EncodedAudioChunk({
        type: "key",
        timestamp: ts,
        data: pkt.data
      }));
    } catch (e) {
      this.errors++;
      console.log(PREFIX, "[DECODER] decode threw", {
        pts: pkt.ptsSec,
        length: pkt.data.length,
        hex16: hexHead(pkt.data, 16),
        error: String(e && e.message || e)
      });
    }
  }

  _onAudioData(audioData) {
    try {
      const frames = audioData.numberOfFrames;
      const channels = audioData.numberOfChannels;
      const sampleRate = audioData.sampleRate;
      const ptsSec = (audioData.timestamp || 0) / 1e6;
      const pcm = new Float32Array(frames * channels);
      let ok = false;
      try {
        audioData.copyTo(pcm, { planeIndex: 0, format: "f32" });
        ok = true;
      } catch (e1) {
        try {
          const tmp = new Float32Array(frames);
          for (let ch = 0; ch < channels; ch++) {
            audioData.copyTo(tmp, { planeIndex: ch, format: "f32-planar" });
            for (let i = 0; i < frames; i++) pcm[i * channels + ch] = tmp[i];
          }
          ok = true;
        } catch (e2) {
          console.log(PREFIX, "[PCM] copyTo failed", String(e2 && e2.message || e2));
        }
      }
      if (!ok) return;
      const durationSec = frames / sampleRate;
      this.framesOut++;
      this.ok = true;
      if (this.state !== "ok") this.state = "ok";
      if (this.onChunk) {
        this.onChunk({ pcm, sampleRate, channels, ptsSec, durationSec });
      }
    } catch (e) {
      console.log(PREFIX, "[PCM] output handler", String(e && e.message || e));
    } finally {
      try { audioData.close(); } catch (e) {}
    }
  }

  close() {
    if (this.decoder) {
      try { this.decoder.close(); } catch (e) {}
      this.decoder = null;
    }
    this.ok = false;
  }

  reset() {
    this.close();
    this.state = "init";
    this.configUsed = null;
  }
}
