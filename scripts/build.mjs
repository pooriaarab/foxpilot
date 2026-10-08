// Bundles the extension into dist/. Pass --watch to rebuild on change.
import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const watch = process.argv.includes("--watch");

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

// snapshot.js runs inside the page via Runtime.evaluate, so it is bundled as a string.
const snapshotAsText = {
  name: "snapshot-as-text",
  setup(build) {
    build.onLoad({ filter: /snapshot\.js$/ }, (args) => ({ contents: readFileSync(args.path, "utf8"), loader: "text" }));
  },
};

const common = {
  bundle: true,
  format: "esm",
  target: "firefox157",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
  outdir: dist,
  absWorkingDir: root,
  plugins: [snapshotAsText],
  alias: { "@huggingface/transformers": join(transformersDir, "dist/transformers.web.js") },
};
const entries = [{ sidepanel: "src/panel/sidepanel.ts" }, { background: "src/background/background.ts" }];
for (const entryPoints of entries) {
  const config = { ...common, entryPoints };
  if (watch) await (await esbuild.context(config)).watch();
  else await esbuild.build(config);
}
if (!watch) console.log(`built ${dist}`);
