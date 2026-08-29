# Technical notes

## Pipeline

1. MSE hooks in MAIN at document_start wrap addSourceBuffer and appendBuffer.
2. Demux reassembles slices into EBML and emits raw Opus from SimpleBlocks.
3. Decode uses WebCodecs AudioDecoder with codec opus, 48000 Hz, 2 channels,
   and no description. A description selects Ogg mode and YouTube stereo fails.
4. Queue: ML runs while processedEnd minus currentTime is under 30s.
   Below 8s is priority. Target about 20s.
5. Separator runs in an extension Worker. MAIN never runs the model.
6. Playback mutes the video when ON and schedules AudioBufferSourceNodes
   against video.currentTime.

## AudioDecoder

YouTube audio is stereo A_OPUS in WebM SimpleBlocks.

- description set: chunks treated as Ogg, decode fails
- description omitted: raw Opus packets, decode succeeds

## Status

- Processing: ON, decoding / ML running
- Idle: OFF
- DRM blocked: video.mediaKeys set
- MSE worker unsupported: workersCreated > 0 and no MAIN addSourceBuffer
- Model loading: Worker loading WASM + ONNX from extension URLs
- Model error: DFN3 failed; GainSeparator 0.2 fallback

## Metrics

Every 1s: currentTime, ytBuffered, copied, decoded, mlIn, processed,
playback, lookahead, RTF.

After 10s of ML audio, one log of processed seconds, wall seconds, RTF,
backend, loadMs.

## Permissions

YouTube host permissions only. No googlevideo, no debugger, no webRequest.
Worker, WASM, and models are web_accessible_resources.

## Architecture

```mermaid
flowchart LR
  YT[YouTube MSE] --> HOOK[MAIN hooks]
  HOOK --> DEMUX[WebM Opus demux]
  DEMUX --> DEC[AudioDecoder]
  DEC --> PCM[PCM buffer]
  PCM --> W[Extension Worker]
  W --> DFN3[DeepFilterNet3]
  DFN3 --> CLK[AudioContext clock]
```

Load unpacked target is dist/. Sources live under src/. Tests under tests/.
