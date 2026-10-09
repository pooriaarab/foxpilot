// Bundles one app from apps/<app>/ into dist/<app>/, as its app.config.mjs says.
// Usage: node scripts/build.mjs [app] [--watch]. The default app is foxpilot.
import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { models } from "../packages/core/src/model/models.ts";
import { fetchModel } from "./fetch-model.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const app = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "foxpilot";
const appDir = join(root, "apps", app);
if (!existsSync(join(appDir, "app.config.mjs"))) throw new Error(`No app at ${appDir} (it needs app.config.mjs).`);
const { default: config } = await import(pathToFileURL(join(appDir, "app.config.mjs")).href);
const dist = join(root, "dist", app);
if (config.model && !Object.hasOwn(models, config.model)) {
  throw new Error(`${app}: model "${config.model}" is not in packages/core/src/model/models.ts. Known: ${Object.keys(models).join(", ")}.`);
}
const model = config.model ? { name: config.model, ...models[config.model] } : null;
// AMO refuses an upload over 200 MB (200 * 1000 * 1000 bytes: MAX_UPLOAD_SIZE in
// mozilla/addons-server src/olympia/lib/settings_base.py; "The maximum file size
// accepted is 200 MB" in extensionworkshop.com/documentation/publish/submitting-an-add-on/).
// The .xpi is a zip of dist/<app>, and ONNX weights barely compress, so the check uses the unzipped size.
const AMO_MAX_BYTES = 200 * 1000 * 1000;

// A listed app updates through AMO, so its manifest must not set update_url.
const amoFile = join(appDir, "listing", "amo.json");
if (existsSync(amoFile) && JSON.parse(readFileSync(amoFile, "utf8")).channel === "listed") {
  const manifest = JSON.parse(readFileSync(join(appDir, "public", "manifest.json"), "utf8"));
  if (manifest.browser_specific_settings?.gecko?.update_url) {
    throw new Error(`${app} is listed, so its manifest must not set gecko.update_url.`);
  }
}

// ONNX Runtime's wasm must ship inside the extension (MV3 blocks remote code).
const transformersDir = realpathSync(join(root, "packages/core/node_modules/@huggingface/transformers"));
const ortDist = join(transformersDir, "../../onnxruntime-web/dist");
if (config.model && !existsSync(ortDist)) throw new Error(`onnxruntime-web not found at ${ortDist}`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(appDir, "public"), dist, { recursive: true });
if (model) {
  mkdirSync(join(dist, "ort"));
  for (const file of readdirSync(ortDist)) {
    if (/^ort-wasm-simd-threaded\.asyncify\.(mjs|wasm)$/.test(file)) cpSync(join(ortDist, file), join(dist, "ort", file));
  }
}
// A bundled model ships in the .xpi from the sha256-checked cache, so the app makes no network request for it.
if (model?.delivery === "bundle") {
  const cache = await fetchModel(model.name);
  for (const file of Object.keys(model.files)) {
    mkdirSync(dirname(join(dist, "models", model.name, file)), { recursive: true });
    cpSync(join(cache, file), join(dist, "models", model.name, file));
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
  // The app's models.ts entry, plus its name; see packages/core/src/model/load.ts.
  define: { __MODEL__: JSON.stringify(model) },
};
for (const [name, entry] of Object.entries(config.entries)) {
  const { in: source, ...options } = typeof entry === "string" ? { in: entry } : entry;
  const build = { ...common, ...options, entryPoints: { [name]: source } };
  if (watch) await (await esbuild.context(build)).watch();
  else await esbuild.build(build);
}
if (!watch) {
  const size = (dir) =>
    readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => sum + (e.isDirectory() ? size(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0);
  const bytes = size(dist);
  if (bytes > AMO_MAX_BYTES) throw new Error(`${dist} is ${bytes} bytes; AMO accepts at most ${AMO_MAX_BYTES}.`);
  console.log(`built ${dist} (${(bytes / 1e6).toFixed(1)} MB)`);
}
