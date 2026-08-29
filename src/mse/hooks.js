/**
 * document_start MAIN-world installer.
 * MUST run at parse time, before any YouTube script, so addSourceBuffer mime
 * and the WebM init (OpusHead) are not missed.
 *
 * MAIN world only: MSE hooks + AudioContext playback + postMessage of PCM.
 * ML lives in an extension Worker (MessagePort).
 */
import { WebmOpusDemuxer } from "../demux/webm-opus.js";
import { IsolatePipeline } from "../queue/pipeline.js";

const PREFIX = "[yt-isolate]";
const root = globalThis;

if (root.__ytIsolate && root.__ytIsolate.__installed) {
  /* already installed */
} else {
  install();
}

function install() {
  const isWindow = (function () {
    try { return typeof Window !== "undefined" && root instanceof Window; } catch (e) { return typeof document !== "undefined"; }
  })();
  const pipeline = new IsolatePipeline();
  const sbMap = typeof WeakMap === "function" ? new WeakMap() : null;
  const audioDemuxers = [];
  let workersCreated = 0;
  let workersWrapped = 0;
  let workersWrapFailed = 0;
  let mainAddSourceBuffer = 0;
  let hookSource = "";
  let videoEl = null;
  let emeLogged = false;
  let origAppend = null;
  let origAdd = null;

  function log() {
    const args = [PREFIX].concat(Array.prototype.slice.call(arguments));
    try { console.log.apply(console, args); } catch (e) {}
  }
  function logStage(stage, msg, extra) {
    if (extra !== undefined) log("[" + stage + "]", msg, extra);
    else log("[" + stage + "]", msg);
  }

  function toU8Copy(data) {
    if (!data) return null;
    try {
      if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
      if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      }
    } catch (e) {
      try {
        if (data instanceof Uint8Array) return data.slice(0);
        if (ArrayBuffer.isView(data)) {
          const v = new Uint8Array(data.byteLength);
          v.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
          return v;
        }
      } catch (e2) {}
    }
    return null;
  }

  function isFtyp(u8) {
    return u8 && u8.length >= 8 &&
      String.fromCharCode(u8[4], u8[5], u8[6], u8[7]) === "ftyp";
  }

  function sniffKind(u8, mime) {
    const m = (mime || "").toLowerCase();
    if (m.indexOf("video/") === 0) return "video";
    if (m.indexOf("audio/") === 0) {
      if (m.indexOf("mp4") >= 0 || m.indexOf("mp4a") >= 0 || m.indexOf("aac") >= 0) return "aac";
      if (m.indexOf("webm") >= 0 || m.indexOf("opus") >= 0) return "audio";
    }
    if (u8 && u8.length >= 4) {
      if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return "audio";
      if (u8[0] === 0x1f && u8[1] === 0x43 && u8[2] === 0xb6 && u8[3] === 0x75) return "audio";
      if (isFtyp(u8)) return m.indexOf("video/") === 0 ? "video" : "aac";
    }
    return "unknown";
  }

  function fmt(n) {
    if (n == null || !isFinite(n)) return "0.00";
    return (Math.round(n * 100) / 100).toFixed(2);
  }

  function rangeOf(el) {
    let a = 0, b = 0;
    try {
      const br = el && el.buffered;
      if (br && br.length) {
        a = br.start(0);
        b = br.end(br.length - 1);
      }
    } catch (e) {}
    return { start: a, end: b };
  }

  function getMeta(sb) {
    if (!sbMap) return null;
    let meta = sbMap.get(sb);
    if (!meta) {
      meta = { mime: "", demuxer: null, kind: null };
      sbMap.set(sb, meta);
    }
    return meta;
  }

  function hookAddSourceBuffer(proto, label) {
    if (!proto || typeof proto.addSourceBuffer !== "function") return;
    if (proto.addSourceBuffer.__ytIsolate) return;
    const orig = proto.addSourceBuffer;
    if (!origAdd) origAdd = orig;
    proto.addSourceBuffer = function (mime) {
      const sb = orig.call(this, mime);
      try {
        mainAddSourceBuffer++;
        pipeline.addSourceBufferCount = mainAddSourceBuffer;
        const meta = getMeta(sb);
        if (meta) {
          meta.mime = String(mime || "");
          const low = meta.mime.toLowerCase();
          if (low.indexOf("audio/") === 0) meta.kind = "audio";
          else if (low.indexOf("video/") === 0) meta.kind = "video";
        }
        try { sb.__ytIsolateMime = String(mime || ""); } catch (e) {}
        logStage("HOOK", "addSourceBuffer " + label, String(mime || ""));
      } catch (e) {
        logStage("HOOK", "addSourceBuffer bookkeeping", String(e && e.message || e));
      }
      return sb;
    };
    proto.addSourceBuffer.__ytIsolate = true;
  }

  function hookAppendBuffer(proto) {
    if (!proto || typeof proto.appendBuffer !== "function") return;
    if (proto.appendBuffer.__ytIsolate) return;
    const orig = proto.appendBuffer;
    origAppend = orig;
    proto.appendBuffer = function (data) {
      let copy = null;
      try { copy = toU8Copy(data); } catch (e) {}
      let ret;
      try {
        ret = orig.call(this, data);
      } catch (e) {
        try { handleAppend(this, copy); } catch (e2) {}
        throw e;
      }
      try { handleAppend(this, copy); } catch (e) {
        logStage("HOOK", "append handler", String(e && e.message || e));
      }
      return ret;
    };
    proto.appendBuffer.__ytIsolate = true;
  }

  function handleAppend(sb, copy) {
    if (!copy || !copy.length) return;
    const meta = getMeta(sb);
    if (!meta) return;
    if (!meta.mime) {
      try { meta.mime = sb.__ytIsolateMime || sb.mimeType || ""; } catch (e) {}
    }
    if (meta.kind === "video") return;
    if (meta.kind !== "audio" && meta.kind !== "aac") {
      meta.kind = sniffKind(copy, meta.mime);
    }
    if (meta.kind === "video") return;
    const low = (meta.mime || "").toLowerCase();
    const aacMime = low.indexOf("mp4") >= 0 || low.indexOf("mp4a") >= 0 || low.indexOf("aac") >= 0;
    if (meta.kind === "aac" || aacMime || isFtyp(copy)) {
      if (low.indexOf("video/") === 0) return;
      meta.kind = "aac";
      pipeline.markCodec("aac", meta.mime || "ftyp");
      return;
    }
    if (meta.kind !== "audio") return;
    if (videoEl && videoEl.mediaKeys && !emeLogged) {
      emeLogged = true;
      pipeline.markEme(true);
      logStage("HOOK", "mediaKeys present — skip decode");
    }
    if (pipeline.emeSkip) return;
    if (!meta.demuxer) {
      meta.demuxer = new WebmOpusDemuxer();
      audioDemuxers.push(meta.demuxer);
      logStage("WEBM", "demuxer attached mime=" + meta.mime);
    }
    const result = meta.demuxer.push(copy);
    pipeline.pushPackets(result);
  }

  function hookMediaSource() {
    try {
      if (typeof MediaSource !== "undefined") hookAddSourceBuffer(MediaSource.prototype, "MediaSource");
    } catch (e) { logStage("HOOK", "MediaSource wrap failed", String(e)); }
    try {
      if (typeof ManagedMediaSource !== "undefined") {
        hookAddSourceBuffer(ManagedMediaSource.prototype, "ManagedMediaSource");
      }
    } catch (e) {}
    try {
      if (typeof SourceBuffer !== "undefined") hookAppendBuffer(SourceBuffer.prototype);
    } catch (e) { logStage("HOOK", "SourceBuffer wrap failed", String(e)); }
  }

  function wrapWorkerUrl(scriptURL, options) {
    const type = (options && options.type) || "";
    let abs;
    try {
      abs = String(new URL(scriptURL, (root.location && root.location.href) || undefined));
    } catch (e) {
      abs = String(scriptURL);
    }
    if (!hookSource) throw new Error("no hook source yet");
    let src;
    if (type === "module") {
      src = hookSource + "\nimport " + JSON.stringify(abs) + ";\n";
    } else {
      src = hookSource + "\ntry { importScripts(" + JSON.stringify(abs) + "); } catch (e) { console.warn('" + PREFIX + " worker importScripts failed', e); }\n";
    }
    const blob = new Blob([src], { type: "text/javascript" });
    return URL.createObjectURL(blob);
  }

  function hookWorkers() {
    function wrapCtor(Orig, name) {
      if (typeof Orig !== "function") return Orig;
      if (Orig.__ytIsolate) return Orig;
      function Wrapped(url, options) {
        workersCreated++;
        pipeline.workersCreated = workersCreated;
        logStage("HOOK", name + " created", String(url));
        let finalUrl = url;
        try {
          finalUrl = wrapWorkerUrl(url, options);
          workersWrapped++;
        } catch (e) {
          workersWrapFailed++;
          logStage("HOOK", "workersWrapFailed " + name, String(e && e.message || e));
          finalUrl = url;
        }
        try {
          return new Orig(finalUrl, options);
        } catch (e2) {
          workersWrapFailed++;
          logStage("HOOK", "workersWrapFailed blob rejected, fallback", String(e2 && e2.message || e2));
          return new Orig(url, options);
        }
      }
      try { Wrapped.prototype = Orig.prototype; } catch (e) {}
      try { Object.setPrototypeOf(Wrapped, Orig); } catch (e) {}
      try { Object.defineProperty(Wrapped, "__ytIsolate", { value: true }); } catch (e) {
        Wrapped.__ytIsolate = true;
      }
      return Wrapped;
    }
    try { if (typeof root.Worker === "function") root.Worker = wrapCtor(root.Worker, "Worker"); } catch (e) {}
    try { if (typeof root.SharedWorker === "function") root.SharedWorker = wrapCtor(root.SharedWorker, "SharedWorker"); } catch (e) {}
  }

  function findVideo() {
    try {
      if (typeof document === "undefined") return null;
      return document.querySelector("video.html5-main-video") ||
        document.querySelector("video.video-stream") ||
        document.querySelector("video");
    } catch (e) {
      return null;
    }
  }

  function bindVideo(v) {
    if (!v || v === videoEl) return;
    videoEl = v;
    pipeline.setVideo(v);
    if (v.mediaKeys) {
      emeLogged = true;
      pipeline.markEme(true);
    }
    logStage("CLOCK", "video found muted=" + v.muted + " src=" + String(v.src || "").slice(0, 48));
  }

  function watchVideo() {
    bindVideo(findVideo());
    try {
      const mo = new MutationObserver(function () {
        if (!videoEl || !videoEl.isConnected) bindVideo(findVideo());
      });
      const rootEl = document.documentElement || document;
      mo.observe(rootEl, { childList: true, subtree: true });
    } catch (e) {}
    setInterval(function () {
      if (!videoEl || !videoEl.isConnected) bindVideo(findVideo());
    }, 2000);
  }

  function onNavigate() {
    logStage("HOOK", "SPA navigation — reset pipeline");
    audioDemuxers.length = 0;
    pipeline.resetAll();
    emeLogged = false;
    videoEl = null;
    bindVideo(findVideo());
  }

  function hookNavigation() {
    try {
      root.addEventListener("yt-navigate-finish", onNavigate, true);
      root.addEventListener("yt-page-data-updated", onNavigate, true);
      document.addEventListener("yt-navigate-finish", onNavigate, true);
      document.addEventListener("spf-done", onNavigate, true);
    } catch (e) {}
  }

  function activeCopied() {
    let start = 0, end = 0;
    for (let i = 0; i < audioDemuxers.length; i++) {
      const d = audioDemuxers[i];
      const s = d.copiedStartSec || 0;
      const e = d.copiedEndSec || 0;
      if (i === 0 || s < start) start = s;
      if (e > end) end = e;
    }
    return { start, end };
  }

  function detectUnsupported() {
    if (workersCreated > 0 && mainAddSourceBuffer === 0) {
      pipeline.markUnsupported();
      return true;
    }
    return false;
  }

  function buildStats() {
    detectUnsupported();
    const v = videoEl || findVideo();
    const ct = v ? (v.currentTime || 0) : 0;
    const buf = rangeOf(v);
    const copied = activeCopied();
    const st = pipeline.stats();
    const processedEnd = st.processedEnd || 0;
    const lookahead = Math.max(0, processedEnd - ct);
    const playing = pipeline.clock.playingPts || ct;
    const q = st.queues || { d: 0, m: 0, p: 0 };
    const line =
      PREFIX +
      " currentTime=" + fmt(ct) +
      " ytBuffered=" + fmt(buf.start) + "\u2192" + fmt(buf.end) +
      " copied=" + fmt(copied.start) + "\u2192" + fmt(copied.end) +
      " decoded=" + fmt(st.decodedStart) + "\u2192" + fmt(st.decodedEnd) +
      " mlIn=" + st.mlIn +
      " processed=" + fmt(st.processedStart) + "\u2192" + fmt(st.processedEnd) +
      " playback=" + fmt(playing) +
      " lookahead=" + fmt(lookahead) + "s" +
      " RTF=" + fmt(st.rtf) +
      " status=" + st.status;
    return {
      line,
      currentTime: ct,
      bufferedStart: buf.start,
      bufferedEnd: buf.end,
      copiedStart: copied.start,
      copiedEnd: copied.end,
      decodedStart: st.decodedStart,
      decodedEnd: st.decodedEnd,
      processedStart: st.processedStart,
      processedEnd: st.processedEnd,
      playing,
      audioCtx: pipeline.clock.ctxState ? pipeline.clock.ctxState() : (pipeline.clock.ctx && pipeline.clock.ctx.state) || "none",
      lookahead,
      decoder: st.decoder,
      workers: workersCreated,
      workersWrapFailed,
      mlIn: st.mlIn,
      rtf: st.rtf,
      backend: st.backend,
      loadMs: st.loadMs,
      late: st.late,
      decodeErrors: st.decodeErrors,
      queues: q,
      status: st.status,
      mode: st.mode,
      audioCodec: st.audioCodec,
      audioMime: st.audioMime,
      model: st.model,
      enabled: st.enabled,
      processedSec: processedEnd
    };
  }

  function emitStats() {
    const s = buildStats();
    try { console.log(s.line); } catch (e) {}
    try {
      if (isWindow) root.postMessage({ type: "YT_ISOLATE_STATS", stats: s, line: s.line }, "*");
    } catch (e) {}
  }

  function listenIsolated() {
    pipeline.setMlSink(function (msg) {
      try { root.postMessage({ type: "YT_ISOLATE_ML_IN", payload: msg }, "*"); } catch (e) {}
    });
    try {
      root.addEventListener("message", function (ev) {
        const d = ev && ev.data;
        if (!d) return;
        if (d.type === "YT_ISOLATE_ML_OUT") {
          pipeline._onMlMessage(d.payload);
          return;
        }
        if (d.type === "YT_ISOLATE_CMD") {
          if (d.cmd === "on") pipeline.setEnabled(true);
          if (d.cmd === "off") pipeline.setEnabled(false);
          if (d.cmd === "mode") pipeline.setMode(d.mode);
        }
      });
    } catch (e) {}
  }

  hookMediaSource();
  hookWorkers();
  listenIsolated();
  hookNavigation();

  if (isWindow && typeof document !== "undefined") {
    if (document.documentElement) watchVideo();
    else document.addEventListener("DOMContentLoaded", watchVideo);
  }

  if (isWindow) setInterval(emitStats, 1000);

  const api = {
    __installed: true,
    stats: function () { return buildStats(); },
    dumpMeta: function () {
      let cfg = null;
      try { cfg = audioDemuxers.length ? audioDemuxers[audioDemuxers.length - 1].config : null; } catch (e) {}
      return {
        demuxers: audioDemuxers.length,
        workersCreated,
        workersWrapped,
        workersWrapFailed,
        mainAddSourceBuffer,
        emeSkip: pipeline.emeSkip,
        decoderConfigUsed: pipeline.decoder.configUsed,
        demuxerConfig: cfg ? {
          codec: cfg.codec,
          sampleRate: cfg.sampleRate,
          numberOfChannels: cfg.numberOfChannels,
          descriptionBytes: cfg.description ? cfg.description.byteLength : 0
        } : null,
        pipeline: pipeline.stats()
      };
    },
    setEnabled: function (on) { pipeline.setEnabled(on); },
    setMode: function (m) { pipeline.setMode(m); },
    pipeline
  };

  try {
    Object.defineProperty(root, "__ytIsolate", {
      value: api,
      configurable: true,
      enumerable: false,
      writable: true
    });
  } catch (e) {
    root.__ytIsolate = api;
  }

  logStage("HOOK", "installed (MAIN document_start)");
}
