# YT Speech Isolate

Manifest V3 Chrome extension that copies YouTube’s **future** MSE audio on the MAIN thread, demuxes WebM/Opus, decodes with WebCodecs `AudioDecoder`, applies **DeepFilterNet3**, mutes the video element, and plays the processed PCM from an `AudioContext` clocked to `video.currentTime`.

This is a lookahead proof: at ~30s, `processed` end should be tens of seconds **ahead** of `currentTime`.

Does **not** use `chrome.debugger`, CDP, ffmpeg.wasm, a local server, or an external server.

## Load unpacked

1. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `dist/` folder (not the repo root).
2. Open a YouTube **VOD** watch page. Reload the watch page **after** the extension is loaded (hooks are `document_start`; a late reload misses nothing).
3. Click the toolbar icon. Controls live in the **popup** (nothing is drawn on the YouTube page). Press **ON**, Isolated. Chrome may still need one click on the video itself to unlock `AudioContext`.
4. Open DevTools console (**MAIN** world, the default page context) and watch lines starting with `[yt-isolate]`.
5. At ~30s, `lookahead` should be tens of seconds; `processed` end should be `>> currentTime`. At 60s you should still hear the quiet processed track in sync.

## What the log line means

Every 500ms the page prints a single line, for example:

```
[yt-isolate] currentTime=30.20 buffered=0.00→118.40 copied=0.00→105.70 decoded=0.00→105.70 processed=0.00→105.70 playing=30.20 lookahead=75.50s decoder=ok workers=0
```

| Field | Meaning |
|---|---|
| `currentTime` | `HTMLVideoElement.currentTime` |
| `buffered` | media-element buffered range |
| `copied` | PTS range of Opus packets demuxed from `appendBuffer` |
| `decoded` / `processed` | PCM after `AudioDecoder` + gain 0.2 |
| `lookahead` | `processedEnd - currentTime` (the proof) |
| `decoder` | `ok` / `init` / `error` / `skip-eme` |
| `workers` | `Worker`/`SharedWorker` constructors seen |

The toolbar popup repeats this (lookahead, processed, model, RTF). There is no on-page overlay.

Console helpers (MAIN world):

```js
__ytIsolate.stats()
__ytIsolate.dumpMeta()
```

## Failure tags

Logs are prefixed `[yt-isolate] [STAGE]`. Stages: `HOOK` | `WEBM` | `OPUS` | `DECODER` | `PCM` | `CLOCK`.

If `video.mediaKeys` is set, we log and skip decode (encrypted). Normal VOD is clear.

## Decoder config (do not “fix” this)

YouTube audio is stereo `A_OPUS` in WebM SimpleBlocks (raw Opus packets).

W3C Opus WebCodecs registration:

- If `AudioDecoderConfig.description` is **set**, chunks are treated as **Ogg** packets → stereo YouTube **fails**.
- If `description` is **omitted**, chunks are raw Opus packets (SimpleBlock payload).

Configure `{ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }` with **no description**. Never pass OpusHead.

## Tests

From the project root (no build step):

```
node --test test/webm-demux.test.mjs
```

Uses the live-captured 266-byte init at `captures/opus-init.webm` (EBML + DocType `webm` + `A_OPUS` + `OpusHead`).
