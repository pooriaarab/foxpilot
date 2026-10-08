// Finds where GLiNER2's per-call time goes, in a real browser. Writes
// bench/results/<browser>-<ts>.{json,md}. Experiments:
//   shape  same shape against new shape (webgpu fp16, webgpu fp32, wasm fp32)
//   E1     per-call ms against token count: compute, or a fixed per-call cost
//   E2     multi-threaded wasm on a cross-origin isolated page
//   E3     ONNX Runtime WebGPU session options: outputs on the GPU, graph capture
//   E4     the same page in Playwright Chromium, as a control
//   #88    gliner2.5-small (webgpu fp16, wasm q8) from dist-model-25 (export/export_gliner25.py)
// Usage: pnpm bench:firefox [--browser chromium]   Env: FIREFOX (binary path).
import * as esbuild from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import puppeteer from "puppeteer";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const flag = process.argv.indexOf("--browser");
const BROWSER = flag > 0 ? process.argv[flag + 1] : "firefox";
const FIREFOX = process.env.FIREFOX ?? "/Applications/Firefox.app/Contents/MacOS/firefox";
const RUNS = [
  { name: "webgpu fp16", q: "device=webgpu&dtype=fp16&tests=shape" },
  { name: "webgpu fp32", q: "device=webgpu&dtype=fp32&tests=shape,sweep,split" },
  { name: "webgpu fp32 gpu-out", q: "device=webgpu&dtype=fp32&session=gpu-out&tests=sweep,split" },
  { name: "webgpu fp32 graph", q: "device=webgpu&dtype=fp32&session=graph&tests=split" },
  { name: "wasm fp32", q: "device=wasm&dtype=fp32&tests=shape,sweep" },
  { name: "wasm fp32 isolated 4 threads", q: "device=wasm&dtype=fp32&threads=4&coi=1&tests=sweep" },
  { name: "wasm fp32 isolated max threads", q: "device=wasm&dtype=fp32&threads=max&coi=1&tests=sweep" },
  { name: "gliner2.5-small webgpu fp16", q: "model=2.5-small&device=webgpu&dtype=fp16&tests=shape,sweep,split" },
  { name: "gliner2.5-small wasm q8", q: "model=2.5-small&device=wasm&dtype=q8&tests=shape,sweep" },
];
const SMALL = join(root, "dist-model-25");
if (!existsSync(SMALL)) console.warn(`No ${SMALL}: the gliner2.5-small runs fail. Run export/export_gliner25.py first.`);
if (BROWSER !== "firefox" && BROWSER !== "chromium") {
  console.error(`--browser must be firefox or chromium, not ${BROWSER}.`);
  process.exit(2);
}
if (BROWSER === "firefox" && !existsSync(FIREFOX)) {
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
// localhost is a secure context, which WebGPU needs. The page is cross-origin
// isolated only with ?coi=1. Scripts and workers always carry the headers,
// because an isolated page's workers need them.
const ISOLATE = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  // Model files for the gliner2.5-small runs, read on demand.
  const model = url.pathname.match(/^\/models\/gliner2\.5-small-v1\/([\w./-]+)$/)?.[1];
  if (model && !model.includes("..") && existsSync(join(SMALL, model))) return void res.writeHead(200).end(readFileSync(join(SMALL, model)));
  const hit = files[url.pathname];
  if (!hit) return void (console.warn(`  404 ${url.pathname}`), res.writeHead(404).end());
  const isolate = url.pathname !== "/" || url.searchParams.has("coi");
  res.writeHead(200, { "content-type": hit[0], ...(isolate ? ISOLATE : {}) }).end(hit[1]);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://localhost:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), "foxpilot-bench-"));
// WebGPU needs a headed browser. Chromium on macOS runs WebGPU on Metal; no Vulkan flag.
const browser =
  BROWSER === "firefox"
    ? await puppeteer.launch({
        browser: "firefox",
        executablePath: FIREFOX,
        headless: false,
        userDataDir: profile,
        args: ["-remote-allow-system-access"],
        defaultViewport: null,
      })
    : await chromium.launch({ headless: false, args: ["--enable-unsafe-webgpu"] });
const version = `${BROWSER} ${await browser.version()}`;
const results = [];
try {
  for (const { name, q } of RUNS) {
    console.log(`running ${name} ...`);
    const page = await browser.newPage();
    page.goto(`${origin}/?${q}`, { timeout: 0 }).catch(() => {});
    const deadline = Date.now() + 15 * 60_000;
    let r;
    while (!r && Date.now() < deadline) {
      r = await page.evaluate(() => window.__result).catch(() => undefined);
      if (!r) await new Promise((res) => setTimeout(res, 500));
    }
    results.push({ name, tests: q, ...(r ?? { error: "timed out" }) });
    console.log(r?.error ? `  ERROR ${r.error.split("\n")[0]}` : `  ${headline(results.at(-1))?.toFixed(0)} ms per call`);
    await page.close();
  }
} finally {
  await browser.close().catch(() => {});
  server.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
}

/** One per-call ms for a run: split total, else same-shape median, else the 128-token sweep point. */
function headline(r) {
  return r?.split?.totalMs ?? r?.shape?.sameWarm.median ?? r?.sweep?.find((s) => s.target === 128)?.totalMs;
}
const ms = (x) => (x === undefined ? "-" : x.toFixed(0));
const err = (e) => `error: ${e.split("\n")[0].replace(/\|/g, "/").slice(0, 160)}`;
const byName = (name) => results.find((r) => r.name === name && !r.error);
const at = (r, target) => r?.sweep?.find((s) => s.target === target && !s.error)?.totalMs;
/**
 * Least squares ms per token over a run's sweep points, and the fixed share:
 * the smallest call (target 0) as a part of a 128-token call.
 */
function fit(r) {
  const pts = (r?.sweep ?? []).filter((s) => !s.error);
  if (pts.length < 2 || !at(r, 0) || !at(r, 128)) return undefined;
  const mx = pts.reduce((a, s) => a + s.tokens, 0) / pts.length;
  const my = pts.reduce((a, s) => a + s.totalMs, 0) / pts.length;
  const perToken = pts.reduce((a, s) => a + (s.tokens - mx) * (s.totalMs - my), 0) / pts.reduce((a, s) => a + (s.tokens - mx) ** 2, 0);
  return { smallest: pts[0], perToken, fixedShare: at(r, 0) / at(r, 128) };
}

const ran = (test) => results.filter((r) => r.tests.includes(test));
const shapeRows = ran("shape").map((r) =>
  r.error
    ? `| ${r.name} | ${err(r.error)} | | | | | | |`
    : `| ${r.name} | ${ms(r.loadMs)} | ${ms(r.shape.sameColdMs)} | ${ms(r.shape.sameWarm.median)} | ${ms(r.shape.newFirstMs)} | ${ms(r.shape.new.median)} | ${(r.shape.new.median / r.shape.sameWarm.median).toFixed(1)}x |`,
);
const sweepRuns = ran("sweep");
const targets = sweepRuns.find((r) => r.sweep)?.sweep.map((s) => s.target) ?? [];
const sweepRows = sweepRuns.map((r) => {
  if (r.error) return `| ${r.name} | ${err(r.error)} | |${targets.map(() => " |").join("")} | |`;
  const f = fit(r);
  const cells = r.sweep.map((s) => (s.error ? err(s.error) : `${ms(s.totalMs)} (${s.tokens} t)`));
  return `| ${r.name} | ${r.crossOriginIsolated} | ${r.numThreads ?? "-"} | ${cells.join(" | ")} | ${f ? f.perToken.toFixed(2) : "-"} | ${f ? `${(f.fixedShare * 100).toFixed(0)}%` : "-"} |`;
});
const splitRuns = ran("split");
const base = byName("webgpu fp32")?.split;
const splitRows = splitRuns.map((r) =>
  r.error
    ? `| ${r.name} | ${err(r.error)} | | | | | |`
    : `| ${r.name} | ${ms(r.split.encodeMs)} | ${ms(r.split.runMs)} | ${ms(r.split.readMs)} | ${ms(r.split.totalMs)} | ${ms(r.split.coldMs)} | ${base ? `${(base.totalMs / r.split.totalMs).toFixed(2)}x` : "-"} |`,
);

// E4: in a Chromium run, set the newest Firefox result beside this one.
const out = join(root, "bench/results");
const lastFirefox = readdirSync(existsSync(out) ? out : root).filter((f) => /^firefox-.*\.json$/.test(f)).sort().at(-1);
const firefox = BROWSER === "chromium" && lastFirefox ? JSON.parse(readFileSync(join(out, lastFirefox), "utf8")) : undefined;
const controlRows = firefox
  ? RUNS.map(({ name }) => {
      const f = firefox.results.find((r) => r.name === name);
      const c = results.find((r) => r.name === name);
      const [fm, cm] = [headline(f), headline(c)];
      return `| ${name} | ${f?.error ? err(f.error) : ms(fm)} | ${c?.error ? err(c.error) : ms(cm)} | ${fm && cm ? `${(fm / cm).toFixed(1)}x` : "-"} |`;
    })
  : [];

// What this means: the largest measured win, and whether fixed cost dominates.
const wins = [];
const add = (name, from, to) => from && to && wins.push({ name, from, to, x: from / to });
add("outputs on the GPU, read back cls_logits only (E3)", base?.totalMs, byName("webgpu fp32 gpu-out")?.split?.totalMs);
add("WebGPU graph capture (E3)", base?.totalMs, byName("webgpu fp32 graph")?.split?.totalMs);
add("fp16 instead of fp32 on webgpu", byName("webgpu fp32")?.shape?.sameWarm.median, byName("webgpu fp16")?.shape?.sameWarm.median);
for (const n of ["wasm fp32 isolated 4 threads", "wasm fp32 isolated max threads"]) {
  add(`${n.replace("wasm fp32 isolated ", "")} on isolated wasm, at 128 tokens (E2)`, at(byName("wasm fp32"), 128), at(byName(n), 128));
}
const best = wins.sort((a, b) => b.x - a.x)[0];
const gpuFit = fit(byName("webgpu fp32"));
const ffGpu = headline(firefox?.results.find((r) => r.name === "webgpu fp32" && !r.error));
const gpuOut = byName("webgpu fp32 gpu-out")?.split;
const meaning = [
  best ? `Largest measured win: ${best.name}, ${ms(best.from)} ms to ${ms(best.to)} ms per call (${best.x.toFixed(2)}x).` : "No win was measured.",
  gpuFit
    ? `On webgpu fp32 the smallest call (${gpuFit.smallest.tokens} tokens) takes ${ms(gpuFit.smallest.totalMs)} ms, ${(gpuFit.fixedShare * 100).toFixed(0)}% of a 128-token call, and each token adds ${gpuFit.perToken.toFixed(2)} ms. So ${gpuFit.fixedShare > 0.5 ? "a fixed per-call overhead dominates, not compute" : "compute dominates, not a fixed per-call overhead"}.`
    : "The webgpu fp32 sweep did not run, so the fixed cost is unknown.",
  best?.name.includes("(E2)") ? "Firefox extension pages cannot be cross-origin isolated today (see E2), so the extension cannot take this win as is." : "",
  ffGpu && headline(byName("webgpu fp32")) ? `On webgpu fp32, Firefox takes ${ms(ffGpu)} ms and Chromium ${ms(headline(byName("webgpu fp32")))} ms per call (E4).` : "",
  gpuOut ? `With outputs on the GPU, reading back cls_logits alone takes ${ms(gpuOut.readMs)} of ${ms(gpuOut.totalMs)} ms (GPU to CPU readback, gpuweb#4432).` : "",
].filter(Boolean).join(" ");

const md = [
  `# Where GLiNER2's per-call time goes: ${version}`,
  ``,
  `Model onnx-community/gliner2-multi-v1-agent-ONNX; gliner2.5-small rows use dist-model-25 (#88). Times are ms per call. hardwareConcurrency ${results.find((r) => r.hardwareConcurrency)?.hardwareConcurrency ?? "-"}.`,
  ``,
  `## What this means`,
  ``,
  meaning,
  ``,
  `## Same shape against new shape (classify)`,
  ``,
  `Same shape: the identical input 10 times after one cold call. New shape: a different label count, so a different token count, on every call.`,
  ``,
  `| run | load | cold (first call) | same shape, median | new shape, first | new shape, median | new / same |`,
  `| --- | --- | --- | --- | --- | --- | --- |`,
  ...shapeRows,
  ``,
  `## E1 and E2: per-call ms against token count`,
  ``,
  `Median of 5 raw calls after one warm-up call, encode to cls_logits on the CPU. Target 0 is empty text with one label. ms/token is a least-squares slope. Fixed share is the smallest call as a part of the 128-token call.`,
  ``,
  `| run | crossOriginIsolated | wasm threads | ${targets.map((t) => `${t} tokens`).join(" | ")} | ms/token | fixed share |`,
  `| --- | --- | --- | ${targets.map(() => "---").join(" | ")} | --- | --- |`,
  ...sweepRows,
  ``,
  `Extension pages (research, not measured): Firefox does not support the \`cross_origin_embedder_policy\` and \`cross_origin_opener_policy\` manifest keys; it warns "An unexpected property was found" ([bug 1750654](https://bugzilla.mozilla.org/show_bug.cgi?id=1750654), open). Extension pages are not cross-origin isolated, so threaded wasm is off in the sidebar. Only privileged extensions get SharedArrayBuffer ([bug 1673477](https://bugzilla.mozilla.org/show_bug.cgi?id=1673477), reopened; [bug 1674383](https://bugzilla.mozilla.org/show_bug.cgi?id=1674383)). Mozilla suggests COOP/COEP for manifest \`sandbox\` pages as a possible first step ([bug 1673477 comment, 2026-07-16](https://bugzilla.mozilla.org/show_bug.cgi?id=1673477); [WECG #1039](https://github.com/w3c/webextensions/issues/1039)). Chrome supports both keys ([docs](https://developer.chrome.com/docs/extensions/reference/manifest/cross-origin-embedder-policy)).`,
  ``,
  `## E3: one call cut into parts (fixed 20-label input)`,
  ``,
  `encode: tokenize and build tensors. run: the model call; with outputs on the CPU it includes the readback of all three outputs. read: cls_logits to the CPU (only gpu-buffer outputs need it). Graph capture reuses one set of GPU input tensors.`,
  ``,
  `| run | encode | run | read | total, median | cold | speedup vs webgpu fp32 |`,
  `| --- | --- | --- | --- | --- | --- | --- |`,
  ...splitRows,
  ``,
  `## E4: Chromium control`,
  ``,
  ...(BROWSER === "firefox"
    ? ["Run `pnpm bench:firefox --browser chromium` after this run. That report sets these numbers beside Chromium's."]
    : firefox
      ? [`Firefox numbers from bench/results/${lastFirefox} (${firefox.browser}).`, ``, `| run | Firefox ms | Chromium ms | Firefox / Chromium |`, `| --- | --- | --- | --- |`, ...controlRows]
      : ["No Firefox result in bench/results. Run `pnpm bench:firefox` first."]),
  ``,
].join("\n");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${BROWSER}-${stamp}.json`), JSON.stringify({ browser: version, results }, null, 1));
writeFileSync(join(out, `${BROWSER}-${stamp}.md`), md);
console.log(md);
console.log(`wrote bench/results/${BROWSER}-${stamp}.{json,md}`);
