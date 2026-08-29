
const PREFIX = "[yt-isolate]";
let engine = null;
const clients = new Set();
let creating = null;
let lastStatus = null;
const engineQueue = [];

async function ensureOffscreen() {
  if (engine) return;
  try {
    if (chrome.runtime.getContexts) {
      const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      // A surviving offscreen doc after SW death has a dead port. Recreate it.
      if (existing && existing.length) {
        try { await chrome.offscreen.closeDocument(); } catch (e) {}
      }
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

function sendToEngine(msg) {
  if (engine) {
    try { engine.postMessage(msg); } catch (e) {}
    return;
  }
  engineQueue.push(msg);
  ensureOffscreen();
}

function broadcast(msg) {
  if (!msg) return;
  if (msg.type === "ready" || msg.type === "model-error") lastStatus = msg;
  clients.forEach(function (c) {
    try { c.postMessage(msg); } catch (e) {}
  });
}

function flushEngineQueue() {
  if (!engine) return;
  const q = engineQueue.splice(0, engineQueue.length);
  for (let i = 0; i < q.length; i++) {
    try { engine.postMessage(q[i]); } catch (e) {}
  }
}

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name === "ml-engine") {
    engine = port;
    console.log(PREFIX, "ml-engine connected, queued", engineQueue.length);
    port.onMessage.addListener(broadcast);
    port.onDisconnect.addListener(function () {
      if (engine === port) engine = null;
      console.log(PREFIX, "ml-engine disconnected");
    });
    flushEngineQueue();
    return;
  }
  if (port.name === "ml-client") {
    clients.add(port);
    ensureOffscreen();
    if (lastStatus) {
      try { port.postMessage(lastStatus); } catch (e) {}
    }
    port.onMessage.addListener(sendToEngine);
    port.onDisconnect.addListener(function () { clients.delete(port); });
  }
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;
  if (msg.type === "YT_ISOLATE_ENSURE_OFFSCREEN") {
    ensureOffscreen().then(function () { sendResponse({ ok: true }); });
    return true;
  }
  if (msg.type === "YT_ISOLATE_STATS") {
    chrome.runtime.sendMessage(msg).catch(function () {});
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
