import { test } from "node:test";
import assert from "node:assert/strict";
import { GainSeparator } from "../src/separator/gain.js";

function chunk(vals, pts) {
  return {
    pcm: Float32Array.from(vals),
    sampleRate: 48000,
    channels: 1,
    ptsSec: pts,
    durationSec: vals.length / 48000
  };
}

test("GainSeparator gain=1 is identity (same ptsSec, same samples)", async () => {
  const s = new GainSeparator(1);
  await s.init();
  const inn = chunk([0.2, -0.5, 1, 0], 12.5);
  const out = await s.process(inn);
  assert.equal(out.ptsSec, 12.5);
  assert.equal(out.sampleRate, 48000);
  assert.equal(out.channels, 1);
  assert.equal(out.pcm.length, inn.pcm.length);
  for (let i = 0; i < inn.pcm.length; i++) assert.equal(out.pcm[i], inn.pcm[i]);
  assert.equal(s.info.id, "gain");
  s.dispose();
});

test("GainSeparator gain=0.5 scales samples and keeps ptsSec", async () => {
  const s = new GainSeparator(0.5);
  await s.init();
  const inn = chunk([1, -1, 0.4], 3);
  const out = await s.process(inn);
  assert.equal(out.ptsSec, 3);
  assert.equal(out.pcm[0], 0.5);
  assert.equal(out.pcm[1], -0.5);
  assert.ok(Math.abs(out.pcm[2] - 0.2) < 1e-6);
});
