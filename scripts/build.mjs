// Bundles the extension into dist/. Pass --watch to rebuild on change.
import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const watch = process.argv.includes("--watch");

// ONNX Runtime's wasm must ship inside the extension (MV3 blocks remote code).
const transformersDir = realpathSync(join(root, "packages/core/node_modules/@huggingface/transformers"));
const ortDist = join(transformersDir, "../../onnxruntime-web/dist");
if (!existsSync(ortDist)) throw new Error(`onnxruntime-web not found at ${ortDist}`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "ort"), { recursive: true });
cpSync(join(root, "public"), dist, { recursive: true });
for (const file of readdirSync(ortDist)) {
  if (/^ort-wasm-simd-threaded\.asyncify\.(mjs|wasm)$/.test(file)) cpSync(join(ortDist, file), join(dist, "ort", file));
}

const common = {
  bundle: true,
  format: "esm",
  target: "firefox157",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
  outdir: dist,
  absWorkingDir: root,
  alias: { "@huggingface/transformers": join(transformersDir, "dist/transformers.web.js") },
};
// kit.js is injected into pages with scripting.executeScript({files}), so it is a plain script, not a module.
const entries = [
  { entryPoints: { sidepanel: "src/panel/sidepanel.ts" } },
  { entryPoints: { background: "src/background/background.ts" } },
  { entryPoints: { kit: "packages/core/src/page/kit.ts" }, format: "iife" },
];
for (const entry of entries) {
  const config = { ...common, ...entry };
  if (watch) await (await esbuild.context(config)).watch();
  else await esbuild.build(config);
}
if (!watch) console.log(`built ${dist}`);
