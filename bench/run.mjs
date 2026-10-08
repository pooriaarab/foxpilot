// Times GLiNER2 in real Firefox: same-shape against new-shape calls, for
// webgpu fp16, webgpu fp32 and wasm fp32. Writes bench/results/firefox-<ts>.{json,md}.
// Usage: pnpm bench:firefox   Env: FIREFOX (binary path).
import * as esbuild from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIREFOX = process.env.FIREFOX ?? "/Applications/Firefox.app/Contents/MacOS/firefox";
const CONFIGS = [
  { device: "webgpu", dtype: "fp16" },
  { device: "webgpu", dtype: "fp32" },
  { device: "wasm", dtype: "fp32" },
];
if (!existsSync(FIREFOX)) {
  console.error(`Cannot find Firefox at ${FIREFOX}.`);
  process.exit(2);
}

// Bundle the bench page, and take ONNX Runtime's wasm from node_modules.
const transformersDir = realpathSync(join(root, "node_modules/@huggingface/transformers"));
const ortDist = join(transformersDir, "../../onnxruntime-web/dist");
const site = mkdtempSync(join(tmpdir(), "foxpilot-bench-site-"));
await esbuild.build({
  entryPoints: [join(root, "bench/bench.ts")],
  bundle: true,
  format: "esm",
  target: "firefox157",
  outfile: join(site, "bench.js"),
  logLevel: "warning",
  alias: { "@huggingface/transformers": join(transformersDir, "dist/transformers.web.js") },
});
const files = {
  "/": ["text/html", '<!doctype html><meta charset="utf-8"><title>GLiNER2 bench</title><script type="module" src="/bench.js"></script>'],
  "/bench.js": ["text/javascript", readFileSync(join(site, "bench.js"))],
};
for (const f of readdirSync(ortDist)) {
  if (/^ort-wasm-simd-threaded\.asyncify\.(mjs|wasm)$/.test(f)) {
    files[`/ort/${f}`] = [f.endsWith(".wasm") ? "application/wasm" : "text/javascript", readFileSync(join(ortDist, f))];
  }
}
// localhost is a secure context, which WebGPU needs.
const server = createServer((req, res) => {
  const hit = files[new URL(req.url, "http://x").pathname];
  if (!hit) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": hit[0] }).end(hit[1]);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://localhost:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), "foxpilot-bench-"));
const browser = await puppeteer.launch({
  browser: "firefox",
  executablePath: FIREFOX,
  headless: false, // WebGPU needs a headed Firefox
  userDataDir: profile,
  args: ["-remote-allow-system-access"],
  defaultViewport: null,
});
const firefox = await browser.version();
const results = [];
try {
  for (const { device, dtype } of CONFIGS) {
    console.log(`running ${device} ${dtype} ...`);
    const page = await browser.newPage();
    page.goto(`${origin}/?device=${device}&dtype=${dtype}`, { timeout: 0 }).catch(() => {});
    const deadline = Date.now() + 15 * 60_000;
    let r;
    while (!r && Date.now() < deadline) {
      r = await page.evaluate(() => window.__result).catch(() => undefined);
      if (!r) await new Promise((res) => setTimeout(res, 500));
    }
    results.push(r ?? { device, dtype, error: "timed out" });
    console.log(r?.error ? `  ERROR ${r.error.split("\n")[0]}` : `  same warm median ${r?.sameWarm.median.toFixed(0)} ms, new shape median ${r?.new.median.toFixed(0)} ms`);
    await page.close();
  }
} finally {
  await browser.close().catch(() => {});
  server.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
}

const ms = (x) => (x === undefined ? "-" : x.toFixed(0));
const rows = results.map((r) =>
  r.error
    ? `| ${r.device} | ${r.dtype} | error: ${r.error.split("\n")[0].replace(/\|/g, "/")} | | | | | |`
    : `| ${r.device} | ${r.dtype} | ${ms(r.loadMs)} | ${ms(r.sameColdMs)} | ${ms(r.sameWarm.median)} | ${ms(r.newFirstMs)} | ${ms(r.new.median)} | ${(r.new.median / r.sameWarm.median).toFixed(1)}x |`,
);
const md = [
  `# GLiNER2 in Firefox: same shape against new shape`,
  ``,
  `Firefox ${firefox}. Model onnx-community/gliner2-multi-v1-agent-ONNX. Times are ms per classify call.`,
  `Same shape: the identical input 10 times after one cold call.`,
  `New shape: a different label count, so a different token count, on every call.`,
  ``,
  `| device | dtype | load | cold (first call) | same shape, median | new shape, first | new shape, median | new / same |`,
  `| --- | --- | --- | --- | --- | --- | --- | --- |`,
  ...rows,
  ``,
].join("\n");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(root, "bench/results");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `firefox-${stamp}.json`), JSON.stringify({ firefox, results }, null, 1));
writeFileSync(join(out, `firefox-${stamp}.md`), md);
console.log(md);
console.log(`wrote bench/results/firefox-${stamp}.{json,md}`);
