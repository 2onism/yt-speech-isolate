
const PREFIX = "[yt-isolate-offscreen]";
const worker = new Worker(chrome.runtime.getURL("worker.js"));
let bg = null;

function connectBg() {
  try { if (bg) bg.disconnect(); } catch (e) {}
  bg = chrome.runtime.connect({ name: "ml-engine" });
  bg.onMessage.addListener(function (msg) {
    if (!msg) return;
    try { worker.postMessage(msg); } catch (e) {
      console.log(PREFIX, "forward to worker failed", String(e));
    }
  });
  bg.onDisconnect.addListener(function () {
    console.log(PREFIX, "bg port gone, reconnecting");
    setTimeout(connectBg, 250);
  });
}

worker.onerror = function (ev) {
  console.log(PREFIX, "worker error", String(ev && ev.message || ev));
  try { bg && bg.postMessage({ type: "model-error", error: String(ev && ev.message || ev) }); } catch (e) {}
};
worker.onmessage = function (ev) {
  if (ev.data && bg) {
    try { bg.postMessage(ev.data); } catch (e) {}
  }
};

connectBg();
worker.postMessage({
  type: "init",
  wasmUrl: chrome.runtime.getURL("assets/df_bg.wasm"),
  modelUrl: chrome.runtime.getURL("models/DeepFilterNet3_onnx.tar.gz")
});
console.log(PREFIX, "started");
