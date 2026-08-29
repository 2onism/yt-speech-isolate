/**
 * Extension Worker: DeepFilterNet3 (or Gain fallback). Never runs on YT main thread.
 */
import { DeepFilterNet3Separator } from "./separator/deepfilternet3.js";
import { GainSeparator } from "./separator/gain.js";

let sep = null;
let fallback = new GainSeparator(0.2);
let usingFallback = false;
let port = null;
let bootPromise = null;
let bootDone = false;

function assetUrl(rel) {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
      return chrome.runtime.getURL(rel);
    }
  } catch (e) {}
  return rel;
}

async function boot(cfg) {
  const wasmUrl = (cfg && cfg.wasmUrl) || assetUrl("assets/df_bg.wasm");
  const modelUrl = (cfg && cfg.modelUrl) || assetUrl("models/DeepFilterNet3_onnx.tar.gz");
  try {
    sep = new DeepFilterNet3Separator({ wasmUrl, modelUrl, attenLim: 50 });
    await sep.init();
    usingFallback = false;
    post({
      type: "ready",
      info: sep.info,
      loadMs: sep.loadMs,
      frameLength: sep.frameLength
    });
  } catch (err) {
    usingFallback = true;
    await fallback.init();
    post({
      type: "model-error",
      error: String(err && err.message || err),
      info: fallback.info
    });
  }
}

function post(msg, transfer) {
  const p = port || self;
  try {
    if (transfer) p.postMessage(msg, transfer);
    else p.postMessage(msg);
  } catch (e) {
    try { p.postMessage(msg); } catch (e2) {}
  }
}

async function onMsg(ev) {
  const data = ev.data;
  if (!data) return;
  if (data.type === "init") {
    if (!bootPromise) bootPromise = boot(data);
    await bootPromise;
    bootDone = true;
    return;
  }
  if (!bootDone) {
    if (bootPromise) await bootPromise;
    else {
      bootPromise = boot(data.type === "init" ? data : null);
      await bootPromise;
    }
    bootDone = true;
  }
  if (data.type === "port") {
    return;
  }
  if (data.type === "reset") {
    if (sep) sep.dispose();
    if (usingFallback) await fallback.init();
    else if (sep) {
      sep.remainder = new Float32Array(0);
      sep.outRemain = new Float32Array(0);
    }
    return;
  }
  if (data.type === "process") {
    const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    const s = usingFallback || !sep ? fallback : sep;
    let out;
    try {
      out = await s.process(data.chunk);
    } catch (e) {
      out = await fallback.process(data.chunk);
    }
    const t1 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    post({ type: "processed", chunk: out, wallMs: t1 - t0 });
  }
}

self.onmessage = function (ev) {
  const data = ev.data;
  if (data && data.type === "connect" && ev.ports && ev.ports[0]) {
    port = ev.ports[0];
    port.onmessage = onMsg;
    port.start && port.start();
    return;
  }
  onMsg(ev);
};
