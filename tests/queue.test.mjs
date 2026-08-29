import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_LOOKAHEAD_SEC,
  TARGET_LOOKAHEAD_SEC,
  MAX_LOOKAHEAD_SEC,
  lookaheadSec,
  shouldRunMl,
  mlIsPriority,
  takeMlBatch
} from "../src/queue/lookahead.js";

test("lookahead constants", () => {
  assert.equal(MIN_LOOKAHEAD_SEC, 8);
  assert.equal(TARGET_LOOKAHEAD_SEC, 20);
  assert.equal(MAX_LOOKAHEAD_SEC, 30);
});

test("stop ML when processedEnd - currentTime > 30s", () => {
  assert.equal(shouldRunMl(40, 5), false);
  assert.equal(shouldRunMl(35, 5), false);
  assert.equal(shouldRunMl(34.9, 5), true);
  assert.equal(shouldRunMl(20, 5), true);
  assert.equal(lookaheadSec(40, 5), 35);
});

test("prioritize ML when lookahead < 8s", () => {
  assert.equal(mlIsPriority(12, 5), true);
  assert.equal(mlIsPriority(13, 5), false);
  assert.equal(mlIsPriority(5, 5), true);
});

test("takeMlBatch stops once the 30s cap would be exceeded", () => {
  const decoded = [];
  for (let i = 0; i < 50; i++) {
    decoded.push({ ptsSec: i, durationSec: 1 });
  }
  const r = takeMlBatch(decoded, 0, 0, 0, 100);
  assert.ok(r.batch.length > 0);
  const last = r.batch[r.batch.length - 1];
  const pe = last.ptsSec + last.durationSec;
  assert.ok(pe <= MAX_LOOKAHEAD_SEC, "processed end " + pe + " should stay at or under cap");
  const r2 = takeMlBatch(decoded, r.cursor, pe, 0, 100);
  assert.equal(r2.batch.length, 0);
  assert.equal(r2.stopped, true);
});
