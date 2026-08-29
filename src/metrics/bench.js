/** RTF = wall/audio. Also loadMs, backend, queues, late, decodeErrors. */

export class Bench {
  constructor() {
    this.wallMs = 0;
    this.audioSec = 0;
    this.loadMs = 0;
    this.backend = "none";
    this.late = 0;
    this.decodeErrors = 0;
    this.startedAt = 0;
    this.logged10s = false;
    this.frames = 0;
  }

  startLoad() {
    this._loadT0 = nowMs();
  }

  endLoad(backend) {
    this.loadMs = nowMs() - (this._loadT0 || nowMs());
    if (backend) this.backend = backend;
  }

  recordProcess(wallMs, audioSec) {
    this.wallMs += wallMs;
    this.audioSec += audioSec;
    this.frames++;
    if (!this.startedAt) this.startedAt = nowMs();
  }

  get rtf() {
    if (this.audioSec <= 0) return 0;
    return this.wallMs / 1000 / this.audioSec;
  }

  /** After 10s of processing, log once. Returns the line or null. */
  maybeLogOnce() {
    if (this.logged10s) return null;
    if (this.audioSec < 10) return null;
    this.logged10s = true;
    const wallSec = this.wallMs / 1000;
    const line =
      "processed " + this.audioSec.toFixed(2) + "s audio in " +
      wallSec.toFixed(2) + "s RTF=" + this.rtf.toFixed(3) +
      " backend=" + this.backend + " loadMs=" + this.loadMs.toFixed(0);
    return line;
  }

  snapshot() {
    return {
      rtf: this.rtf,
      loadMs: this.loadMs,
      backend: this.backend,
      late: this.late,
      decodeErrors: this.decodeErrors,
      audioSec: this.audioSec,
      wallMs: this.wallMs,
      frames: this.frames
    };
  }
}

function nowMs() {
  if (typeof performance !== "undefined" && performance.now) return performance.now();
  return Date.now();
}
