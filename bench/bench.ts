// GLiNER2 timing in the browser: same-shape against new-shape calls.
// Bundled and served by bench/run.mjs, which passes ?device=&dtype=.
import { env } from "@huggingface/transformers";
import { Gliner2 } from "../src/model/gliner2";

const MODEL = "onnx-community/gliner2-multi-v1-agent-ONNX";
const SAME_CALLS = 10;
const NEW_CALLS = 10;

const params = new URLSearchParams(location.search);
const device = (params.get("device") ?? "webgpu") as "webgpu" | "wasm";
const dtype = (params.get("dtype") ?? "fp16") as "fp16" | "fp32";

env.useWasmCache = false;
env.backends.onnx.wasm!.wasmPaths = {
  mjs: `${location.origin}/ort/ort-wasm-simd-threaded.asyncify.mjs`,
  wasm: `${location.origin}/ort/ort-wasm-simd-threaded.asyncify.wasm`,
};

const TEXT = "Find a one-way ticket from New York to San Francisco on October 9, 2026.";
const labelsOf = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`control ${i}: ${i % 2 ? "Departure date" : "Where to"} field`, ""]));
const stats = (ms: number[]) => {
  const sorted = [...ms].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, min: sorted[0]!, max: sorted.at(-1)!, mean: ms.reduce((a, b) => a + b, 0) / ms.length };
};

async function main() {
  const result: Record<string, unknown> = { model: MODEL, device, dtype, userAgent: navigator.userAgent };
  const t = performance.now();
  const model = await Gliner2.load(MODEL, { device, dtype });
  result.loadMs = performance.now() - t;
  const tokens = (labels: Record<string, string>) =>
    (model as unknown as { encode: (t: string, o: object) => { inputIds: number[] } }).encode(TEXT, { name: "referenced", marker: "[L]", labels }).inputIds.length;
  const call = async (labels: Record<string, string>) => {
    const s = performance.now();
    await model.classify(TEXT, "referenced", labels);
    return performance.now() - s;
  };

  // Same shape: one cold call, then the identical input again.
  const same = labelsOf(20);
  const sameTokens = tokens(same);
  const sameCold = await call(same);
  const sameWarm: number[] = [];
  for (let i = 0; i < SAME_CALLS; i++) sameWarm.push(await call(same));

  // New shape: a label count that no earlier call used, so the token count differs each time.
  const newMs: number[] = [];
  const newTokens: number[] = [];
  const seen = new Set([sameTokens]);
  for (let n = 21; newMs.length < NEW_CALLS && n < 200; n++) {
    const labels = labelsOf(n);
    const size = tokens(labels);
    if (seen.has(size)) continue;
    seen.add(size);
    newTokens.push(size);
    newMs.push(await call(labels));
  }
  Object.assign(result, {
    sameTokens,
    sameColdMs: sameCold,
    sameWarmMs: sameWarm,
    sameWarm: stats(sameWarm),
    newTokens,
    newMs,
    new: stats(newMs),
    newFirstMs: newMs[0],
  });
  return result;
}

main().then(
  (result) => ((window as unknown as { __result: unknown }).__result = result),
  (error) => ((window as unknown as { __result: unknown }).__result = { device, dtype, error: String(error?.stack ?? error) }),
);
