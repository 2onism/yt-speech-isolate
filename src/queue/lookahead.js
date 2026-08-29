/** Lookahead / backpressure policy. Pure functions — unit-tested in Node. */

export const MIN_LOOKAHEAD_SEC = 8;
export const TARGET_LOOKAHEAD_SEC = 20;
export const MAX_LOOKAHEAD_SEC = 30;

export function lookaheadSec(processedEnd, currentTime) {
  const pe = processedEnd == null ? 0 : processedEnd;
  const ct = currentTime == null ? 0 : currentTime;
  const v = pe - ct;
  return v > 0 ? v : 0;
}

/** Stop ML when processedEnd - currentTime > 30s. */
export function shouldRunMl(processedEnd, currentTime) {
  return lookaheadSec(processedEnd, currentTime) < MAX_LOOKAHEAD_SEC;
}

/** If lookahead < 8s, prioritize ML. */
export function mlIsPriority(processedEnd, currentTime) {
  return lookaheadSec(processedEnd, currentTime) < MIN_LOOKAHEAD_SEC;
}

/**
 * Pull decoded chunks into the ML input queue while under the cap.
 * @param {{ ptsSec: number, durationSec: number }[]} decoded
 * @param {number} cursor index into decoded of next unsent chunk
 * @param {number} processedEnd
 * @param {number} currentTime
 * @returns {{ cursor: number, batch: any[], stopped: boolean }}
 */
export function takeMlBatch(decoded, cursor, processedEnd, currentTime, maxBatch = 8) {
  const batch = [];
  if (!shouldRunMl(processedEnd, currentTime)) {
    return { cursor, batch, stopped: true };
  }
  let pe = processedEnd == null ? 0 : processedEnd;
  let i = cursor;
  while (i < decoded.length && batch.length < maxBatch) {
    if (!shouldRunMl(pe, currentTime)) break;
    const c = decoded[i];
    batch.push(c);
    pe = Math.max(pe, (c.ptsSec || 0) + (c.durationSec || 0));
    i++;
  }
  return { cursor: i, batch, stopped: batch.length === 0 && !shouldRunMl(processedEnd, currentTime) };
}
