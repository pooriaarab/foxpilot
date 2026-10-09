// Bundles one app from apps/<app>/ into dist/<app>/, as its app.config.mjs says.
// Usage: node scripts/build.mjs [app] [--watch]. The default app is foxpilot.
import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const app = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "foxpilot";
const appDir = join(root, "apps", app);
if (!existsSync(join(appDir, "app.config.mjs"))) throw new Error(`No app at ${appDir} (it needs app.config.mjs).`);
const { default: config } = await import(pathToFileURL(join(appDir, "app.config.mjs")).href);
const dist = join(root, "dist", app);

// ONNX Runtime's wasm must ship inside the extension (MV3 blocks remote code).
const transformersDir = realpathSync(join(root, "packages/core/node_modules/@huggingface/transformers"));
const ortDist = join(transformersDir, "../../onnxruntime-web/dist");
if (config.model && !existsSync(ortDist)) throw new Error(`onnxruntime-web not found at ${ortDist}`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(appDir, "public"), dist, { recursive: true });
if (config.model) {
  mkdirSync(join(dist, "ort"));
  for (const file of readdirSync(ortDist)) {
    if (/^ort-wasm-simd-threaded\.asyncify\.(mjs|wasm)$/.test(file)) cpSync(join(ortDist, file), join(dist, "ort", file));
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
  absWorkingDir: appDir,
  alias: { "@huggingface/transformers": join(transformersDir, "dist/transformers.web.js") },
};
for (const [name, entry] of Object.entries(config.entries)) {
  const { in: source, ...options } = typeof entry === "string" ? { in: entry } : entry;
  const build = { ...common, ...options, entryPoints: { [name]: source } };
  if (watch) await (await esbuild.context(build)).watch();
  else await esbuild.build(build);
}
if (!watch) console.log(`built ${dist}`);
