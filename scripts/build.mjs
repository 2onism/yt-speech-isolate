#!/usr/bin/env node
import * as esbuild from "esbuild";
import { mkdir, copyFile, readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const VENDOR = join(ROOT, "vendor", "deepfilternet3");

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", cwd: ROOT });
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(cmd + " " + code)));
  });
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function hashFile(p) {
  const buf = await readFile(p);
  return { bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
}

async function main() {
  const wasmSrc = join(VENDOR, "df_bg.wasm");
  const modelSrc = join(VENDOR, "DeepFilterNet3_onnx.tar.gz");
  if (!(await exists(wasmSrc)) || !(await exists(modelSrc))) {
    console.log("vendor assets missing — running fetch-model");
    await run(process.execPath, [join(ROOT, "scripts", "fetch-model.mjs")]);
  }

  await mkdir(DIST, { recursive: true });
  await mkdir(join(DIST, "assets"), { recursive: true });
  await mkdir(join(DIST, "models"), { recursive: true });

  const common = {
    bundle: true,
    format: "iife",
    target: ["chrome116"],
    sourcemap: false,
    legalComments: "none",
    logLevel: "info"
  };

  await esbuild.build({
    ...common,
    entryPoints: [join(ROOT, "src/mse/hooks.js")],
    outfile: join(DIST, "hook.js")
  });
  await esbuild.build({
    ...common,
    entryPoints: [join(ROOT, "src/isolated.js")],
    outfile: join(DIST, "isolated.js")
  });
  await esbuild.build({
    ...common,
    entryPoints: [join(ROOT, "src/worker.js")],
    outfile: join(DIST, "worker.js")
  });
  await esbuild.build({
    ...common,
    entryPoints: [join(ROOT, "src/background.js")],
    outfile: join(DIST, "background.js")
  });
  await esbuild.build({
    ...common,
    entryPoints: [join(ROOT, "src/offscreen.js")],
    outfile: join(DIST, "offscreen.js")
  });

  await copyFile(join(ROOT, "src/ui/hud.css"), join(DIST, "hud.css"));
  await copyFile(join(ROOT, "src/offscreen.html"), join(DIST, "offscreen.html"));
  await copyFile(join(ROOT, "src/manifest.json"), join(DIST, "manifest.json"));
  await copyFile(wasmSrc, join(DIST, "assets", "df_bg.wasm"));
  await copyFile(modelSrc, join(DIST, "models", "DeepFilterNet3_onnx.tar.gz"));

  const wasm = await hashFile(join(DIST, "assets", "df_bg.wasm"));
  const model = await hashFile(join(DIST, "models", "DeepFilterNet3_onnx.tar.gz"));
  const hashes =
    wasm.sha256 + "  " + wasm.bytes + "  assets/df_bg.wasm\n" +
    model.sha256 + "  " + model.bytes + "  models/DeepFilterNet3_onnx.tar.gz\n";
  await writeFile(join(DIST, "assets", "HASHES.txt"), hashes);
  console.log("dist hashes:\n" + hashes);
  console.log("build ok ->", DIST);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
