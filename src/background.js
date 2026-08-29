
const PREFIX = "[yt-isolate]";
let engine = null;
const clients = new Set();
let creating = null;

async function ensureOffscreen() {
  try {
    if (chrome.runtime.getContexts) {
      const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      if (existing && existing.length) return;
    }
  } catch (e) {}
  if (creating) return creating;
  creating = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS"],
    justification: "Run DeepFilterNet3 WASM off the YouTube page"
  }).catch(function (e) {
    console.log(PREFIX, "offscreen create failed", String(e && e.message || e));
  }).finally(function () { creating = null; });
  return creating;
}

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name === "ml-engine") {
    engine = port;
    port.onMessage.addListener(function (msg) {
      clients.forEach(function (c) {
        try { c.postMessage(msg); } catch (e) {}
      });
    });
    port.onDisconnect.addListener(function () { engine = null; });
    return;
  }
  if (port.name === "ml-client") {
    clients.add(port);
    ensureOffscreen();
    port.onMessage.addListener(function (msg) {
      if (engine) {
        try { engine.postMessage(msg); } catch (e) {}
      }
    });
    port.onDisconnect.addListener(function () { clients.delete(port); });
  }
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;
  if (msg.type === "YT_ISOLATE_ENSURE_OFFSCREEN") {
    ensureOffscreen().then(function () { sendResponse({ ok: true }); });
    return true;
  }
  if (msg.type === "YT_ISOLATE_ISOLATED_READY") {
    console.log(PREFIX, "isolated ready", msg.href, sender.tab && sender.tab.id);
    ensureOffscreen();
  }
  sendResponse({ ok: true });
  return true;
});

ensureOffscreen();
console.log(PREFIX, "service worker started");
