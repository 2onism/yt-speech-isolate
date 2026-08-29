#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "vendor", "deepfilternet3");
const MEZON = "https://cdn.mezon.ai/AI/models/datas/noise_suppression/deepfilternet3";

const ASSETS = [
  {
    name: "df_bg.wasm",
    dest: join(OUT, "df_bg.wasm"),
    urls: [MEZON + "/v3/pkg/df_bg.wasm"]
  },
  {
    name: "DeepFilterNet3_onnx.tar.gz",
    dest: join(OUT, "DeepFilterNet3_onnx.tar.gz"),
    urls: [
      MEZON + "/v3/models/DeepFilterNet3_onnx.tar.gz",
      "https://github.com/Rikorose/DeepFilterNet/raw/main/models/DeepFilterNet3_onnx.tar.gz"
    ]
  }
];

async function download(urls, dest) {
  let lastErr = null;
  for (const url of urls) {
    try {
      process.stdout.write("fetch " + url + "\n");
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) {
        lastErr = new Error(res.status + " " + res.statusText + " for " + url);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) {
        lastErr = new Error("too small (" + buf.length + " B) from " + url);
        continue;
      }
      await writeFile(dest, buf);
      return { url, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("all mirrors failed for " + dest);
}

async function main() {
  const force = process.argv.includes("--force");
  await mkdir(OUT, { recursive: true });
  const report = [];
  for (const a of ASSETS) {
    if (!force) {
      try {
        const st = await stat(a.dest);
        if (st.size > 1024) {
          const buf = await readFile(a.dest);
          const sha = createHash("sha256").update(buf).digest("hex");
          report.push({ name: a.name, bytes: st.size, sha256: sha, url: "(cached)" });
          process.stdout.write("cached " + a.name + " " + st.size + " bytes\n");
          continue;
        }
      } catch (_) {}
    }
    const r = await download(a.urls, a.dest);
    report.push({ name: a.name, bytes: r.bytes, sha256: r.sha256, url: r.url });
    process.stdout.write("wrote " + a.name + " " + r.bytes + " bytes sha256=" + r.sha256 + "\n");
  }
  const hashes = report.map((r) => r.sha256 + "  " + r.bytes + "  " + r.name + "  " + r.url + "\n").join("");
  await writeFile(join(OUT, "HASHES.txt"), hashes);
  console.log("HASHES.txt\n" + hashes);
}

main().catch((e) => {
  console.error("fetch-model failed:", e && e.message || e);
  process.exit(1);
});
