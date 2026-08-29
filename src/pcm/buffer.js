/** PTS-ordered PCM store with trim / range query. */

export class PcmBuffer {
  constructor() {
    this.chunks = [];
    this.startSec = null;
    this.endSec = null;
  }

  push(chunk) {
    if (!chunk || !chunk.pcm) return;
    this.chunks.push(chunk);
    if (this.startSec == null || chunk.ptsSec < this.startSec) this.startSec = chunk.ptsSec;
    const end = chunk.ptsSec + (chunk.durationSec || 0);
    if (this.endSec == null || end > this.endSec) this.endSec = end;
  }

  trim(videoTime, keepBehindSec, keepAheadSec) {
    const lo = (videoTime || 0) - keepBehindSec;
    const hi = (videoTime || 0) + keepAheadSec;
    const kept = [];
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      const end = c.ptsSec + (c.durationSec || 0);
      if (end < lo) continue;
      if (c.ptsSec > hi) continue;
      kept.push(c);
    }
    this.chunks = kept;
    if (!kept.length) {
      this.startSec = null;
      this.endSec = null;
      return;
    }
    this.startSec = kept[0].ptsSec;
    const last = kept[kept.length - 1];
    this.endSec = last.ptsSec + (last.durationSec || 0);
  }

  inRange(from, to) {
    const out = [];
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      const end = c.ptsSec + (c.durationSec || 0);
      if (end > from && c.ptsSec < to) out.push(c);
    }
    return out;
  }

  clear() {
    this.chunks = [];
    this.startSec = null;
    this.endSec = null;
  }

  get length() { return this.chunks.length; }
}
