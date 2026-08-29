
const PREFIX = "[yt-isolate-offscreen]";
const worker = new Worker(chrome.runtime.getURL("worker.js"));
const bg = chrome.runtime.connect({ name: "ml-engine" });

worker.onerror = function (ev) {
  console.log(PREFIX, "worker error", String(ev && ev.message || ev));
  bg.postMessage({ type: "model-error", error: String(ev && ev.message || ev) });
};
worker.onmessage = function (ev) {
  if (ev.data) bg.postMessage(ev.data);
};
bg.onMessage.addListener(function (msg) {
  if (!msg) return;
  try { worker.postMessage(msg); } catch (e) {
    console.log(PREFIX, "forward to worker failed", String(e));
  }
});
worker.postMessage({
  type: "init",
  wasmUrl: chrome.runtime.getURL("assets/df_bg.wasm"),
  modelUrl: chrome.runtime.getURL("models/DeepFilterNet3_onnx.tar.gz")
});
console.log(PREFIX, "started");
