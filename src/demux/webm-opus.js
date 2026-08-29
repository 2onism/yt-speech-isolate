/**
 * Streaming WebM / Opus demuxer.
 * Reassembles 16KB MSE slices into EBML elements and emits raw Opus packets
 * from SimpleBlock / Block payloads (NOT Cluster elements, NOT Ogg pages).
 */
  var ID = {
    EBML: 0x1A45DFA3,
    Segment: 0x18538067,
    SeekHead: 0x114D9B74,
    Seek: 0x4DBB,
    Info: 0x1549A966,
    TimecodeScale: 0x2AD7B1,
    Duration: 0x4489,
    Tracks: 0x1654AE6B,
    TrackEntry: 0xAE,
    TrackNumber: 0xD7,
    TrackType: 0x83,
    CodecID: 0x86,
    CodecPrivate: 0x63A2,
    CodecDelay: 0x56AA,
    SeekPreRoll: 0x56BB,
    Audio: 0xE1,
    SamplingFrequency: 0xB5,
    Channels: 0x9F,
    BitDepth: 0x6264,
    Language: 0x22B59C,
    DefaultDuration: 0x23E383,
    FlagLacing: 0x9C,
    Cluster: 0x1F43B675,
    Timecode: 0xE7,
    SimpleBlock: 0xA3,
    BlockGroup: 0xA0,
    Block: 0xA1,
    BlockDuration: 0x9B,
    Cues: 0x1C53BB6B,
    Tags: 0x1254C367,
    Chapters: 0x1043A770,
    Void: 0xEC,
    CRC32: 0xBF
  };

  var MASTER = {};
  [
    ID.EBML, ID.Segment, ID.SeekHead, ID.Seek, ID.Info, ID.Tracks, ID.TrackEntry,
    ID.Audio, ID.Cluster, ID.BlockGroup, ID.Cues, ID.Tags, ID.Chapters
  ].forEach(function (id) { MASTER[id] = true; });

  var MAX_LEAF = 8 * 1024 * 1024;
  var MAX_BUF = 16 * 1024 * 1024;

  function readVint(u8, offset, withMarker) {
    if (offset >= u8.length) return null;
    var first = u8[offset];
    if (first === 0) return { error: "invalid vint" };
    var len = 1;
    var mask = 0x80;
    while (len <= 8 && (first & mask) === 0) {
      len++;
      mask >>= 1;
    }
    if (len > 8) return { error: "invalid vint" };
    if (offset + len > u8.length) return null;
    var value = withMarker ? first : (first & (mask - 1));
    for (var i = 1; i < len; i++) {
      value = value * 256 + u8[offset + i];
    }
    var unknown = false;
    if (!withMarker) {
      var allOnes = Math.pow(2, 7 * len) - 1;
      unknown = value === allOnes;
    }
    return { length: len, value: value, unknown: unknown };
  }

  function readUint(u8) {
    var v = 0;
    for (var i = 0; i < u8.length; i++) v = v * 256 + u8[i];
    return v;
  }

  function readFloat(u8) {
    if (u8.length !== 4 && u8.length !== 8) return null;
    var tmp = new Uint8Array(u8.length);
    tmp.set(u8);
    var view = new DataView(tmp.buffer);
    return u8.length === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
  }

  function readInt16BE(u8, offset) {
    var v = (u8[offset] << 8) | u8[offset + 1];
    if (v & 0x8000) v -= 0x10000;
    return v;
  }

  function ascii(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i++) {
      var c = u8[i];
      s += (c >= 32 && c < 127) ? String.fromCharCode(c) : ".";
    }
    return s;
  }

  function parseOpusHead(bytes) {
    if (!bytes || bytes.length < 19) return null;
    var sig = ascii(bytes.subarray(0, 8));
    if (sig !== "OpusHead") return null;
    var sr = (bytes[12] | (bytes[13] << 8) | (bytes[14] << 16) | (bytes[15] << 24)) >>> 0;
    return {
      version: bytes[8],
      channels: bytes[9],
      preSkip: bytes[10] | (bytes[11] << 8),
      inputSampleRate: sr,
      outputGain: (bytes[16] | (bytes[17] << 8)) << 16 >> 16,
      mappingFamily: bytes[18]
    };
  }

  function copyU8(u8) {
    var out = new Uint8Array(u8.length);
    out.set(u8);
    return out;
  }

  function WebmOpusDemuxer() {
    this.reset();
  }

  Object.defineProperty(WebmOpusDemuxer.prototype, "config", {
    get: function () { return this._getConfig(); }
  });
  Object.defineProperty(WebmOpusDemuxer.prototype, "copiedStartSec", {
    get: function () { return this._copiedStart == null ? 0 : this._copiedStart; }
  });
  Object.defineProperty(WebmOpusDemuxer.prototype, "copiedEndSec", {
    get: function () { return this._copiedEnd == null ? 0 : this._copiedEnd; }
  });

  WebmOpusDemuxer.prototype.reset = function () {

    this._buf = new Uint8Array(0);
    this._pos = 0;
    this._stack = [];
    this._timecodeScale = 1000000;
    this._clusterTimecode = 0;
    this._tracks = {};
    this._curTrack = null;
    this._audioTrackNumber = null;
    this._codecId = null;
    this._codecPrivate = null;
    this._sampleRate = 48000;
    this._channels = 2;
    this._defaultDurationNs = 20000000;
    this._copiedStart = null;
    this._copiedEnd = null;
    this._sawEbml = false;
    this._lacingLogged = false;
    this._desyncs = 0;
  };

  WebmOpusDemuxer.prototype._getConfig = function () {
    if (!this._codecId && !this._codecPrivate) return null;
    var desc = null;
    if (this._codecPrivate) {
      desc = this._codecPrivate.buffer.slice(
        this._codecPrivate.byteOffset,
        this._codecPrivate.byteOffset + this._codecPrivate.byteLength
      );
    }
    var codec = "opus";
    if (this._codecId && this._codecId !== "A_OPUS") {
      codec = this._codecId.indexOf("OPUS") >= 0 ? "opus" : this._codecId;
    }
    return {
      codec: codec,
      sampleRate: this._sampleRate || 48000,
      numberOfChannels: this._channels || 2,
      description: desc
    };
  };

  WebmOpusDemuxer.prototype.push = function (chunk) {
    var packets = [];
    var info = {};
    var reset = false;
    var u8 = toU8(chunk);
    if (!u8 || !u8.length) return { packets: packets, info: info, reset: false };

    if (this._buf.length - this._pos + u8.length > MAX_BUF) {
      this._compact();
      if (this._buf.length - this._pos + u8.length > MAX_BUF) {
        this._buf = new Uint8Array(0);
        this._pos = 0;
        this._stack = [];
        this._desyncs++;
      }
    }

    this._append(u8);

    // A brand-new EBML header at the current parse point (quality switch / new init).
    if (this._looksLikeEbml(this._pos) && this._sawEbml) {
      this._resetTrackState();
      reset = true;
      info.reset = true;
    }

    var self = this;
    this._parseLoop(function (pkt) { packets.push(pkt); }, function () {
      reset = true;
      info.reset = true;
    });

    this._compact();

    var cfg = this._getConfig();
    if (cfg) info.config = cfg;
    if (this._audioTrackNumber != null) info.audioTrackNumber = this._audioTrackNumber;
    info.copiedStartSec = this.copiedStartSec;
    info.copiedEndSec = this.copiedEndSec;
    return { packets: packets, info: info, reset: reset };
  };

  WebmOpusDemuxer.prototype._resetTrackState = function () {
    this._stack = [];
    this._timecodeScale = 1000000;
    this._clusterTimecode = 0;
    this._tracks = {};
    this._curTrack = null;
    this._audioTrackNumber = null;
    this._codecId = null;
    this._codecPrivate = null;
    this._sampleRate = 48000;
    this._channels = 2;
    this._defaultDurationNs = 20000000;
    this._copiedStart = null;
    this._copiedEnd = null;
    this._sawEbml = false;
  };

  WebmOpusDemuxer.prototype._append = function (u8) {
    if (this._pos > 0 && this._pos === this._buf.length) {
      this._buf = copyU8(u8);
      this._pos = 0;
      return;
    }
    var nb = new Uint8Array(this._buf.length + u8.length);
    nb.set(this._buf, 0);
    nb.set(u8, this._buf.length);
    this._buf = nb;
  };

  WebmOpusDemuxer.prototype._compact = function () {
    if (this._pos <= 0) return;
    if (this._pos < 4096 && this._buf.length - this._pos > 0) return;
    var keep = this._buf.length - this._pos;
    var nb = new Uint8Array(keep);
    if (keep) nb.set(this._buf.subarray(this._pos));
    for (var i = 0; i < this._stack.length; i++) {
      var fr = this._stack[i];
      if (fr.end !== Infinity) fr.end -= this._pos;
      fr.payloadStart -= this._pos;
    }
    this._buf = nb;
    this._pos = 0;
  };

  WebmOpusDemuxer.prototype._looksLikeEbml = function (offset) {
    var b = this._buf;
    return (
      offset + 4 <= b.length &&
      b[offset] === 0x1a && b[offset + 1] === 0x45 &&
      b[offset + 2] === 0xdf && b[offset + 3] === 0xa3
    );
  };

  WebmOpusDemuxer.prototype._parseLoop = function (onPacket, onReset) {
    var guard = 0;
    while (guard++ < 100000) {
      while (this._stack.length) {
        var top = this._stack[this._stack.length - 1];
        if (!top.unknown && this._pos >= top.end) {
          this._pop();
          continue;
        }
        break;
      }

      var u8 = this._buf;
      var pos = this._pos;
      if (pos >= u8.length) break;

      if (this._stack.length) {
        var parent = this._stack[this._stack.length - 1];
        if (parent.unknown) {
          var peeked = readVint(u8, pos, true);
          if (peeked && !peeked.error) {
            if (this._isUnknownSizeTerminator(parent.id, peeked.value)) {
              this._pop();
              continue;
            }
          }
        } else if (pos >= parent.end) {
          this._pop();
          continue;
        }
      }

      var idv = readVint(u8, pos, true);
      if (!idv) break;
      if (idv.error) {
        this._resync(onReset);
        continue;
      }
      var sizev = readVint(u8, pos + idv.length, false);
      if (!sizev) break;
      if (sizev.error) {
        this._resync(onReset);
        continue;
      }

      var id = idv.value;
      var payloadStart = pos + idv.length + sizev.length;
      var unknown = !!sizev.unknown;
      var payloadSize = unknown ? Infinity : sizev.value;
      var elemEnd = unknown ? Infinity : payloadStart + payloadSize;

      if (this._stack.length) {
        var p = this._stack[this._stack.length - 1];
        if (!p.unknown && payloadStart > p.end) {
          this._pop();
          continue;
        }
      }

      if (id === ID.EBML && this._sawEbml) {
        this._resetTrackState();
        onReset();
      }

      if (MASTER[id]) {
        this._pos = payloadStart;
        this._stack.push({
          id: id,
          end: elemEnd,
          unknown: unknown,
          payloadStart: payloadStart
        });
        this._onMaster(id);
        continue;
      }

      if (unknown) {
        // Unknown-size leaf: scan for Cluster / Segment.
        var scan = this._scanKnown(payloadStart);
        if (scan < 0) break;
        this._handleLeaf(id, u8.subarray(payloadStart, scan), onPacket);
        this._pos = scan;
        continue;
      }

      if (payloadSize > MAX_LEAF) {
        this._desyncs++;
        this._pos = payloadStart;
        this._resync(onReset);
        continue;
      }

      if (elemEnd > u8.length) break;

      this._handleLeaf(id, u8.subarray(payloadStart, elemEnd), onPacket);
      this._pos = elemEnd;
    }
  };

  WebmOpusDemuxer.prototype._onMaster = function (id) {
    if (id === ID.EBML) this._sawEbml = true;
    if (id === ID.TrackEntry) {
      this._curTrack = { number: null, type: null, codecId: null, codecPrivate: null, channels: null, sampleRate: null, defaultDurationNs: null };
    }
    if (id === ID.Cluster) {
      this._clusterTimecode = 0;
    }
  };

  WebmOpusDemuxer.prototype._pop = function () {
    var fr = this._stack.pop();
    if (!fr) return;
    if (fr.id === ID.TrackEntry && this._curTrack) {
      var t = this._curTrack;
      if (t.number != null) this._tracks[t.number] = t;
      if (t.type === 2 || (t.codecId && t.codecId.indexOf("OPUS") >= 0)) {
        this._audioTrackNumber = t.number;
        this._codecId = t.codecId || "A_OPUS";
        if (t.codecPrivate) this._codecPrivate = t.codecPrivate;
        if (t.channels) this._channels = t.channels;
        if (t.sampleRate) this._sampleRate = t.sampleRate;
        if (t.defaultDurationNs) this._defaultDurationNs = t.defaultDurationNs;
        var head = parseOpusHead(this._codecPrivate);
        if (head) {
          if (head.channels) this._channels = head.channels;
          if (head.inputSampleRate) this._sampleRate = head.inputSampleRate;
        }
      }
      this._curTrack = null;
    }
  };

  WebmOpusDemuxer.prototype._handleLeaf = function (id, payload, onPacket) {
    var t = this._curTrack;
    if (id === ID.TimecodeScale) {
      var v = readUint(payload);
      if (v > 0) this._timecodeScale = v;
      return;
    }
    if (id === ID.Timecode) {
      this._clusterTimecode = readUint(payload);
      return;
    }
    if (id === ID.TrackNumber && t) {
      t.number = readUint(payload);
      return;
    }
    if (id === ID.TrackType && t) {
      t.type = readUint(payload);
      return;
    }
    if (id === ID.CodecID && t) {
      t.codecId = ascii(payload);
      return;
    }
    if (id === ID.CodecPrivate && t) {
      t.codecPrivate = copyU8(payload);
      return;
    }
    if (id === ID.Channels && t) {
      t.channels = readUint(payload);
      return;
    }
    if (id === ID.SamplingFrequency && t) {
      var f = readFloat(payload);
      if (f && isFinite(f)) t.sampleRate = Math.round(f);
      return;
    }
    if (id === ID.DefaultDuration && t) {
      t.defaultDurationNs = readUint(payload);
      return;
    }
    if (id === ID.SimpleBlock || id === ID.Block) {
      this._emitBlock(payload, onPacket);
    }
  };

  WebmOpusDemuxer.prototype._emitBlock = function (payload, onPacket) {
    if (!payload || payload.length < 4) return;
    var trackV = readVint(payload, 0, false);
    if (!trackV || trackV.error) return;
    var off = trackV.length;
    if (off + 3 > payload.length) return;
    var trackNum = trackV.value;
    if (this._audioTrackNumber != null && trackNum !== this._audioTrackNumber) return;
    var tr = this._tracks[trackNum];
    if (tr && tr.type != null && tr.type !== 2 && !(tr.codecId && tr.codecId.indexOf("OPUS") >= 0)) {
      return;
    }

    var rel = readInt16BE(payload, off);
    off += 2;
    var flags = payload[off];
    off += 1;
    var lacing = flags & 0x06;
    var ptsSec = (this._clusterTimecode + rel) * this._timecodeScale / 1e9;
    var frames;
    if (lacing === 0) {
      frames = [copyU8(payload.subarray(off))];
    } else {
      frames = this._parseLacing(payload, off, lacing);
      if (!this._lacingLogged) {
        this._lacingLogged = true;
        try {
          console.log("[yt-isolate] [WEBM] laced SimpleBlock lacing=" + lacing + " frames=" + (frames ? frames.length : 0));
        } catch (e) {}
      }
    }
    if (!frames) return;
    var step = (this._defaultDurationNs || 20000000) / 1e9;
    for (var i = 0; i < frames.length; i++) {
      if (!frames[i] || !frames[i].length) continue;
      var p = ptsSec + i * step;
      onPacket({ ptsSec: p, data: frames[i] });
      if (this._copiedStart == null || p < this._copiedStart) this._copiedStart = p;
      var end = p + step;
      if (this._copiedEnd == null || end > this._copiedEnd) this._copiedEnd = end;
    }
  };

  WebmOpusDemuxer.prototype._parseLacing = function (payload, off, lacing) {
    if (off >= payload.length) return null;
    var n = payload[off] + 1;
    off += 1;
    var sizes = new Array(n);
    var i;
    try {
      if (lacing === 0x02) {
        // Xiph
        for (i = 0; i < n - 1; i++) {
          var sz = 0;
          while (off < payload.length) {
            var b = payload[off++];
            sz += b;
            if (b !== 255) break;
          }
          sizes[i] = sz;
        }
      } else if (lacing === 0x06) {
        // EBML
        var first = readVint(payload, off, false);
        if (!first || first.error) return null;
        sizes[0] = first.value;
        off += first.length;
        for (i = 1; i < n - 1; i++) {
          var dv = readVint(payload, off, false);
          if (!dv || dv.error) return null;
          off += dv.length;
          var bias = Math.pow(2, 7 * dv.length - 1) - 1;
          sizes[i] = sizes[i - 1] + (dv.value - bias);
        }
      } else if (lacing === 0x04) {
        var remain0 = payload.length - off;
        if (remain0 % n !== 0) {
          // still try
        }
        var each = Math.floor(remain0 / n);
        for (i = 0; i < n; i++) sizes[i] = each;
        var framesF = [];
        for (i = 0; i < n; i++) {
          framesF.push(copyU8(payload.subarray(off, off + each)));
          off += each;
        }
        return framesF;
      } else {
        return [copyU8(payload.subarray(off))];
      }
      var used = 0;
      for (i = 0; i < n - 1; i++) used += sizes[i];
      sizes[n - 1] = payload.length - off - used;
      var frames = [];
      for (i = 0; i < n; i++) {
        if (sizes[i] < 0 || off + sizes[i] > payload.length) return null;
        frames.push(copyU8(payload.subarray(off, off + sizes[i])));
        off += sizes[i];
      }
      return frames;
    } catch (e) {
      return null;
    }
  };

  WebmOpusDemuxer.prototype._isUnknownSizeTerminator = function (parentId, nextId) {
    if (nextId === ID.EBML || nextId === ID.Segment) return true;
    if (parentId === ID.Cluster) {
      return nextId === ID.Cluster || nextId === ID.Cues || nextId === ID.Tracks ||
        nextId === ID.Info || nextId === ID.SeekHead || nextId === ID.Tags;
    }
    if (parentId === ID.Segment) {
      return nextId === ID.Segment;
    }
    return false;
  };

  WebmOpusDemuxer.prototype._scanKnown = function (from) {
    var b = this._buf;
    for (var i = from; i + 4 <= b.length; i++) {
      if (b[i] === 0x1f && b[i + 1] === 0x43 && b[i + 2] === 0xb6 && b[i + 3] === 0x75) return i;
      if (b[i] === 0x18 && b[i + 1] === 0x53 && b[i + 2] === 0x80 && b[i + 3] === 0x67) return i;
      if (b[i] === 0x1a && b[i + 1] === 0x45 && b[i + 2] === 0xdf && b[i + 3] === 0xa3) return i;
    }
    return -1;
  };

  WebmOpusDemuxer.prototype._resync = function (onReset) {
    var scan = this._scanKnown(this._pos + 1);
    if (scan < 0) {
      if (this._pos < this._buf.length) this._pos = Math.max(this._pos, this._buf.length - 4);
      return;
    }
    this._pos = scan;
    this._stack = [];
    this._desyncs++;
  };

  function toU8(data) {
    if (!data) return null;
    if (data instanceof Uint8Array) {
      if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data;
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
  }

export { WebmOpusDemuxer, parseOpusHead };
