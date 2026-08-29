import { updateHud } from "./ui/hud.js";

function setHint(text) {
  const hint = document.querySelector(".yti-hint");
  if (hint) hint.textContent = text || "";
}

function sendToTab(msg, onRes) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      setHint("Open a YouTube watch tab, then click this icon.");
      return;
    }
    const url = tab.url || "";
    if (!/youtube\.com|youtube-nocookie\.com/.test(url)) {
      setHint("Open a YouTube watch tab, then click this icon.");
      return;
    }
    chrome.tabs.sendMessage(tab.id, msg).then(function (res) {
      if (onRes) onRes(res, tab);
    }).catch(function () {
      setHint("Reload the YouTube tab after loading the extension.");
    });
  });
}

function poll() {
  sendToTab({ type: "YT_ISOLATE_GET_STATS" }, function (res) {
    if (res && res.stats) updateHud(res.stats);
  });
}

document.addEventListener("click", function (ev) {
  const btn = ev.target.closest("button");
  if (!btn) return;
  const cmd = btn.getAttribute("data-cmd");
  if (!cmd) return;
  sendToTab({ type: "YT_ISOLATE_POPUP_CMD", cmd: cmd, mode: btn.getAttribute("data-mode") });
});

chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || msg.type !== "YT_ISOLATE_STATS") return;
  if (msg.stats) updateHud(msg.stats);
});

poll();
setInterval(poll, 500);
