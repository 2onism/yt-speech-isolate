/**
 * Isolated world: HUD + chrome.runtime port to offscreen ML worker.
 */
import { ensureHud, updateHud } from "./ui/hud.js";

const PREFIX = "[yt-isolate]";
let port = null;

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
  port.onDisconnect.addListener(function () {
    port = null;
  });
  try {
    chrome.runtime.sendMessage({ type: "YT_ISOLATE_ENSURE_OFFSCREEN" });
  } catch (e) {}
  return port;
}

function onCmd(cmd) {
  postToMain({ type: "YT_ISOLATE_CMD", cmd: cmd.cmd, mode: cmd.mode });
}

window.addEventListener("message", function (ev) {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || typeof d.type !== "string") return;
  if (d.type === "YT_ISOLATE_STATS") {
    updateHud(d.stats);
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

function bootHud() { ensureHud(onCmd); }
if (document.documentElement) bootHud();
else document.addEventListener("DOMContentLoaded", bootHud);

ensurePort();
try {
  chrome.runtime.sendMessage({ type: "YT_ISOLATE_ISOLATED_READY", href: location.href });
} catch (e) {}
