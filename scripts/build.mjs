// Bundles the extension into dist/. Pass --watch to rebuild on change.
import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const watch = process.argv.includes("--watch");
// GLINER=2.5-small builds the extension on gliner2.5-small (#88) from export/export_gliner25.py output.
const gliner = process.env.GLINER ?? "multi-v1";
if (gliner !== "multi-v1" && gliner !== "2.5-small") throw new Error(`GLINER must be multi-v1 or 2.5-small, not ${gliner}`);
const small = join(root, "dist-model-25");
if (gliner === "2.5-small" && !existsSync(join(small, "onnx/model_quantized.onnx"))) throw new Error(`run export/export_gliner25.py first: no ${small}`);

// ONNX Runtime's wasm must ship inside the extension (MV3 blocks remote code).
const transformersDir = realpathSync(join(root, "node_modules/@huggingface/transformers"));
const ortDist = join(transformersDir, "../../onnxruntime-web/dist");
if (!existsSync(ortDist)) throw new Error(`onnxruntime-web not found at ${ortDist}`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "ort"), { recursive: true });
cpSync(join(root, "public"), dist, { recursive: true });
for (const file of readdirSync(ortDist)) {
  if (/^ort-wasm-simd-threaded\.asyncify\.(mjs|wasm)$/.test(file)) cpSync(join(ortDist, file), join(dist, "ort", file));
}
if (gliner === "2.5-small") {
  for (const file of ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"]) {
    mkdirSync(dirname(join(dist, "models/gliner2.5-small-v1", file)), { recursive: true });
    cpSync(join(small, file), join(dist, "models/gliner2.5-small-v1", file));
  }
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
  define: { __GLINER__: JSON.stringify(gliner) },
};
// kit.js is injected into pages with scripting.executeScript({files}), so it is a plain script, not a module.
const entries = [
  { entryPoints: { sidepanel: "src/panel/sidepanel.ts" } },
  { entryPoints: { background: "src/background/background.ts" } },
  { entryPoints: { kit: "src/agent/kit.ts" }, format: "iife" },
];
for (const entry of entries) {
  const config = { ...common, ...entry };
  if (watch) await (await esbuild.context(config)).watch();
  else await esbuild.build(config);
}
if (!watch) console.log(`built ${dist}`);
