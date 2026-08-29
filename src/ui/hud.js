const HUD_ID = "yt-isolate-hud";

export function ensureHud(onCmd) {
  let el = document.getElementById(HUD_ID);
  if (el) return el;
  const parent = document.documentElement;
  if (!parent) return null;
  el = document.createElement("div");
  el.id = HUD_ID;
  el.innerHTML =
    '<div class="yti-title">YT Speech Isolate ' +
    '<button type="button" data-cmd="on">ON</button>' +
    '<button type="button" data-cmd="off">OFF</button></div>' +
    '<div class="yti-row yti-status"><span class="yti-dot"></span><span class="yti-status-text">Idle</span></div>' +
    '<div class="yti-row">Lookahead: <span class="yti-look">0.0s</span></div>' +
    '<div class="yti-row">Processed: <span class="yti-proc">0.0s</span></div>' +
    '<div class="yti-row">Model: <span class="yti-model">DeepFilterNet3</span></div>' +
    '<div class="yti-row">Mode: ' +
    '<button type="button" data-cmd="mode" data-mode="isolated">Isolated</button> ' +
    '<button type="button" data-cmd="mode" data-mode="original">Original</button></div>' +
    '<div class="yti-hint"></div>' +
    '<div class="yti-debug">Debug: —</div>';
  parent.appendChild(el);
  el.addEventListener("click", function (ev) {
    const btn = ev.target.closest("button");
    if (!btn) return;
    const cmd = btn.getAttribute("data-cmd");
    if (!cmd) return;
    onCmd({ cmd: cmd, mode: btn.getAttribute("data-mode") });
  });
  return el;
}

export function updateHud(stats) {
  const el = document.getElementById(HUD_ID);
  if (!el || !stats) return;
  const status = stats.status || "idle";
  const label = statusLabel(status);
  const dot = el.querySelector(".yti-dot");
  const st = el.querySelector(".yti-status-text");
  if (st) st.textContent = label;
  if (dot) {
    dot.classList.toggle("ok", status === "processing");
    dot.classList.toggle("bad", status === "drm" || status === "unsupported" || status === "model-error");
  }
  const look = el.querySelector(".yti-look");
  if (look) look.textContent = (stats.lookahead || 0).toFixed(1) + "s";
  const proc = el.querySelector(".yti-proc");
  if (proc) proc.textContent = (stats.processedSec || stats.processedEnd || 0).toFixed(1) + "s";
  const model = el.querySelector(".yti-model");
  if (model) model.textContent = (stats.model && stats.model.name) || "DeepFilterNet3";
  const q = stats.queues || { d: 0, m: 0, p: 0 };
  const dbg = el.querySelector(".yti-debug");
  if (dbg) {
    dbg.textContent =
      "Debug: RTF=" + (stats.rtf || 0).toFixed(2) +
      " backend=" + (stats.backend || "?") +
      " queues=" + q.d + "/" + q.m + "/" + q.p +
      " late=" + (stats.late || 0) +
      (stats.audioCodec ? " codec=" + stats.audioCodec : "");
  }
  const onBtn = el.querySelector('button[data-cmd="on"]');
  const offBtn = el.querySelector('button[data-cmd="off"]');
  if (onBtn) onBtn.classList.toggle("yti-on", !!stats.enabled);
  if (offBtn) offBtn.classList.toggle("yti-off", !stats.enabled);

  const hint = el.querySelector(".yti-hint");
  if (hint) {
    if (stats.enabled && stats.audioCtx && stats.audioCtx !== "running") {
      hint.textContent = "Click the video once to start processed audio (Chrome blocks sound until a page click).";
    } else {
      hint.textContent = "";
    }
  }
  el.querySelectorAll('button[data-cmd="mode"]').forEach(function (b) {
    b.classList.toggle("yti-active", b.getAttribute("data-mode") === stats.mode);
  });
}

function statusLabel(status) {
  switch (status) {
    case "processing": return "Processing";
    case "idle": return "Idle";
    case "drm": return "DRM blocked";
    case "unsupported": return "MSE worker unsupported";
    case "unsupported-codec": return "AAC audio (not Opus) — left YouTube unmuted";
    case "model-loading": return "Model loading";
    case "model-error": return "Model error (gain fallback)";
    default: return String(status);
  }
}
