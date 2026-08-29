/**
 * Isolated world: bridge MAIN <-> extension (ML offscreen + popup). No page HUD.
 */
const PREFIX = "[yt-isolate]";
let port = null;
let lastStats = null;

function postToMain(msg) {
  try { window.postMessage(msg, "*"); } catch (e) {}
}

function ensurePort() {
  if (port) return port;
  try {
    port = chrome.runtime.connect({ name: "ml-client" });
  } catch (e) {
    console.log(PREFIX, "runtime.connect failed", String(e && e.message || e));
    postToMain({ type: "YT_ISOLATE_ML_OUT", payload: { type: "model-error", error: String(e && e.message || e) } });
    return null;
  }
  port.onMessage.addListener(function (data) {
    if (data) postToMain({ type: "YT_ISOLATE_ML_OUT", payload: data });
  });
  port.onDisconnect.addListener(function () { port = null; });
  try { chrome.runtime.sendMessage({ type: "YT_ISOLATE_ENSURE_OFFSCREEN" }); } catch (e) {}
  return port;
}

window.addEventListener("message", function (ev) {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || typeof d.type !== "string") return;
  if (d.type === "YT_ISOLATE_STATS") {
    lastStats = d.stats;
    try { chrome.runtime.sendMessage({ type: "YT_ISOLATE_STATS", stats: d.stats }); } catch (e) {}
    return;
  }
  if (d.type === "YT_ISOLATE_ML_IN") {
    const p = ensurePort();
    if (!p || !d.payload) return;
    try { p.postMessage(d.payload); } catch (e) {
      console.log(PREFIX, "forward ML_IN failed", String(e));
    }
  }
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;
  if (msg.type === "YT_ISOLATE_GET_STATS") {
    sendResponse({ ok: true, stats: lastStats });
    try { chrome.runtime.sendMessage({ type: "YT_ISOLATE_STATS", stats: lastStats }); } catch (e) {}
    return;
  }
  if (msg.type === "YT_ISOLATE_POPUP_CMD") {
    postToMain({ type: "YT_ISOLATE_CMD", cmd: msg.cmd, mode: msg.mode });
    sendResponse({ ok: true });
  }
});

ensurePort();
try {
  chrome.runtime.sendMessage({ type: "YT_ISOLATE_ISOLATED_READY", href: location.href });
} catch (e) {}
