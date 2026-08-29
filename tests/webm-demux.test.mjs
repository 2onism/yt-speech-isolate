import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebmOpusDemuxer } from "../src/demux/webm-opus.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INIT_PATH = join(ROOT, "captures/opus-init.webm");
const INIT_HEX = join(ROOT, "captures/opus-init.hex");
function loadInit() {
  try { return new Uint8Array(readFileSync(INIT_PATH)); }
  catch (e) {
    return Uint8Array.from(Buffer.from(readFileSync(INIT_HEX, "utf8").trim(), "hex"));
  }
}

function encodeSize(n) {
  if (n < 127) return Uint8Array.of(0x80 | n);
  if (n < 16383) return Uint8Array.of(0x40 | ((n >> 8) & 0x3f), n & 0xff);
  if (n < 2097151) return Uint8Array.of(0x20 | ((n >> 16) & 0x1f), (n >> 8) & 0xff, n & 0xff);
  throw new Error("size too big");
}

function concatBytes(parts) {
  let len = 0;
  for (let i = 0; i < parts.length; i++) len += parts[i].length;
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], o);
    o += parts[i].length;
  }
  return out;
}

function makeCluster(clusterTc, relTc, track, payload) {
  const trackVint = Uint8Array.of(0x80 | (track & 0x7f));
  const rel = Uint8Array.of((relTc >> 8) & 0xff, relTc & 0xff);
  const flags = Uint8Array.of(0x00);
  const block = concatBytes([trackVint, rel, flags, payload]);
  const simple = concatBytes([Uint8Array.of(0xa3), encodeSize(block.length), block]);
  let tcBytes;
  if (clusterTc < 256) {
    tcBytes = concatBytes([Uint8Array.of(0xe7), encodeSize(1), Uint8Array.of(clusterTc)]);
  } else {
    tcBytes = concatBytes([
      Uint8Array.of(0xe7),
      encodeSize(2),
      Uint8Array.of((clusterTc >> 8) & 0xff, clusterTc & 0xff)
    ]);
  }
  const clusterPayload = concatBytes([tcBytes, simple]);
  return concatBytes([
    Uint8Array.of(0x1f, 0x43, 0xb6, 0x75),
    encodeSize(clusterPayload.length),
    clusterPayload
  ]);
}

test("init fixture yields opus config with OpusHead", () => {
  const init = loadInit();
  assert.equal(init.length, 266);
  assert.equal(init[0], 0x1a);
  assert.equal(init[1], 0x45);
  assert.equal(init[2], 0xdf);
  assert.equal(init[3], 0xa3);

  const d = new WebmOpusDemuxer();
  const r = d.push(init);
  const cfg = d.config;
  assert.ok(cfg, "config should be set after init");
  assert.equal(cfg.codec, "opus");
  assert.ok(cfg.numberOfChannels >= 1);
  assert.equal(cfg.sampleRate, 48000);
  assert.ok(cfg.description, "description (OpusHead bytes) should be captured");
  const desc = new Uint8Array(cfg.description);
  const sig = Buffer.from(desc.subarray(0, 8)).toString("ascii");
  assert.equal(sig, "OpusHead");
  assert.equal(r.packets.length, 0, "init has no SimpleBlocks");
});

test("init still parses when sliced into 16-byte MSE-like chunks", () => {
  const init = loadInit();
  const d = new WebmOpusDemuxer();
  for (let i = 0; i < init.length; i += 16) {
    d.push(init.subarray(i, Math.min(i + 16, init.length)));
  }
  const cfg = d.config;
  assert.ok(cfg);
  assert.equal(cfg.codec, "opus");
  assert.equal(cfg.numberOfChannels, 2);
  assert.equal(cfg.sampleRate, 48000);
  const desc = new Uint8Array(cfg.description);
  assert.equal(Buffer.from(desc.subarray(0, 8)).toString("ascii"), "OpusHead");
});

test("synthetic Cluster+SimpleBlock emits one packet at expected pts", () => {
  const init = loadInit();
  const d = new WebmOpusDemuxer();
  d.push(init);
  const opusPacket = Uint8Array.of(0xfc, 0x00, 0x01, 0x02, 0x03);
  const cluster = makeCluster(1000, 0, 1, opusPacket);
  const r = d.push(cluster);
  assert.ok(r.packets.length >= 1, "expected at least one packet, got " + r.packets.length);
  const pkt = r.packets[0];
  assert.equal(pkt.data.length, opusPacket.length);
  assert.equal(pkt.data[0], 0xfc);
  assert.ok(Math.abs(pkt.ptsSec - 1.0) < 1e-9, "ptsSec=" + pkt.ptsSec);
  assert.ok(d.copiedEndSec >= 1.0);
});

test("cluster spanning two pushes still emits the packet", () => {
  const init = loadInit();
  const d = new WebmOpusDemuxer();
  d.push(init);
  const payload = Uint8Array.of(0xaa, 0xbb, 0xcc, 0xdd);
  const cluster = makeCluster(2000, 5, 1, payload);
  const mid = Math.floor(cluster.length / 2);
  const r1 = d.push(cluster.subarray(0, mid));
  const r2 = d.push(cluster.subarray(mid));
  const packets = r1.packets.concat(r2.packets);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].data[0], 0xaa);
  assert.ok(Math.abs(packets[0].ptsSec - 2.005) < 1e-9, "pts=" + packets[0].ptsSec);
});

test("new EBML after init signals reset", () => {
  const init = loadInit();
  const d = new WebmOpusDemuxer();
  d.push(init);
  const r = d.push(init);
  assert.equal(r.reset, true);
  assert.ok(d.config);
  assert.equal(d.config.codec, "opus");
});
