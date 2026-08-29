# YT Speech Isolate

Chrome MV3 extension: intercept YouTube VOD audio ahead of playback, run DeepFilterNet3 locally, mute YouTube, and play processed speech in sync.

No server. No Python. No debugger. No downloader. Audio never leaves the machine.

## Setup

```bash
git clone https://github.com/2onism/yt-speech-isolate.git
cd yt-speech-isolate
npm install
npm test
npm run build
```

Then in Chrome: Extensions, Developer mode, Load unpacked, select `dist/`. Open a non-DRM YouTube VOD, reload the tab, click ON.

## Live test (2026-08-29)

Desktop Chrome, unpacked dist, `dQw4w9WgXcQ`. After ~70s: Processing, DeepFilterNet3, lookahead 29.9s, processed 122.4s, late=0, RTF 0.01.

See docs/MODEL.md and docs/TECHNICAL.md.
