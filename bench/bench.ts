// GLiNER2 timing in the browser. Bundled and served by bench/run.mjs, which passes
// ?device=&dtype=&tests= and, for some runs, &threads=&session=.
// Tests: shape (same against new shape), sweep (ms against token count),
// split (one call cut into encode / run / read back).
import { env, Tensor } from "@huggingface/transformers";
import { Gliner2 } from "../src/model/gliner2";
import type { Labels } from "../src/model/gliner2";

const MODEL = "onnx-community/gliner2-multi-v1-agent-ONNX";
const SAME_CALLS = 10;
const NEW_CALLS = 10;
const SWEEP_CALLS = 5;
/** Target token counts. 0 is the smallest input: empty text and one label. */
const SWEEP = [0, 32, 64, 128, 256, 512];
/** ONNX Runtime session options for each session preset. */
const SESSIONS: Record<string, Record<string, unknown>> = {
  default: {},
  "gpu-out": { preferredOutputLocation: "gpu-buffer" },
  graph: { preferredOutputLocation: "gpu-buffer", enableGraphCapture: true },
};

const params = new URLSearchParams(location.search);
const device = (params.get("device") ?? "webgpu") as "webgpu" | "wasm";
const dtype = (params.get("dtype") ?? "fp16") as "fp16" | "fp32";
const session = params.get("session") ?? "default";
const tests = (params.get("tests") ?? "shape").split(",");
const threads = params.get("threads");

env.useWasmCache = false;
const wasm = env.backends.onnx.wasm as { wasmPaths: unknown; numThreads?: number };
wasm.wasmPaths = {
  mjs: `${location.origin}/ort/ort-wasm-simd-threaded.asyncify.mjs`,
  wasm: `${location.origin}/ort/ort-wasm-simd-threaded.asyncify.wasm`,
};
// ONNX Runtime reads numThreads once, when it creates the first session.
if (threads) wasm.numThreads = threads === "max" ? navigator.hardwareConcurrency : Number(threads);

const TEXT = "Find a one-way ticket from New York to San Francisco on October 9, 2026.";
const FILL = ["flights", "from", "boston", "to", "denver", "on", "monday", "morning"];
const labelsOf = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`control ${i}: ${i % 2 ? "Departure date" : "Where to"} field`, ""]));
const stats = (ms: number[]) => {
  const sorted = [...ms].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, min: sorted[0]!, max: sorted.at(-1)!, mean: ms.reduce((a, b) => a + b, 0) / ms.length };
};

type OrtTensor = { location: string; getData(): Promise<unknown>; dispose(): void };
type GpuDevice = {
  createBuffer(d: { size: number; usage: number }): unknown;
  queue: { writeBuffer(b: unknown, offset: number, data: BigInt64Array): void };
};
type Feeds = Record<string, Tensor>;
const ortOf = (t: Tensor) => (t as unknown as { ort_tensor: OrtTensor }).ort_tensor;
const long = (values: number[]) => new Tensor("int64", BigInt64Array.from(values, BigInt), [1, values.length]);

/** The same tensor in a GPU buffer, which graph capture needs for every input. */
function gpuLong(gpu: GpuDevice, values: number[]): Tensor {
  const data = BigInt64Array.from(values, BigInt);
  // STORAGE | COPY_SRC | COPY_DST
  const buffer = gpu.createBuffer({ size: data.byteLength, usage: 0x80 | 0x04 | 0x08 });
  gpu.queue.writeBuffer(buffer, 0, data);
  const Ort = ortOf(long([0])).constructor as unknown as { fromGpuBuffer(b: unknown, o: object): unknown };
  return new (Tensor as unknown as new (t: unknown) => Tensor)(Ort.fromGpuBuffer(buffer, { dataType: "int64", dims: [1, values.length] }));
}

async function main() {
  const result: Record<string, unknown> = {
    model: MODEL,
    device,
    dtype,
    session,
    userAgent: navigator.userAgent,
    crossOriginIsolated: self.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    hardwareConcurrency: navigator.hardwareConcurrency,
  };
  const t = performance.now();
  const model = await Gliner2.load(MODEL, { device, dtype, session_options: SESSIONS[session] });
  result.loadMs = performance.now() - t;
  result.numThreads = wasm.numThreads;
  const encode = (text: string, labels: Labels) => model.encode(text, { name: "referenced", marker: "[L]", labels });
  const tokens = (text: string, labels: Labels) => encode(text, labels).inputIds.length;
  const call = async (labels: Labels) => {
    const s = performance.now();
    await model.classify(TEXT, "referenced", labels);
    return performance.now() - s;
  };

  // One raw model call, as Gliner2.run does it, cut into its parts. Only
  // cls_logits is read back, because classify uses only that output.
  const inner = (model as unknown as { model: (feeds: Feeds) => Promise<Record<string, Tensor>> }).model;
  const feedsOf = (text: string, labels: Labels, make = long): Feeds => {
    const e = encode(text, labels);
    return {
      input_ids: make(e.inputIds),
      attention_mask: make(new Array<number>(e.inputIds.length).fill(1)),
      word_positions: make(e.wordPositions),
      schema_positions: make(e.schemaPositions),
    };
  };
  const parts = async (input: () => Feeds) => {
    const t0 = performance.now();
    const feeds = input();
    const t1 = performance.now();
    const out = await inner(feeds);
    const t2 = performance.now();
    const cls = ortOf(out.cls_logits!);
    if (cls.location === "gpu-buffer") await cls.getData();
    else void out.cls_logits!.data;
    const t3 = performance.now();
    for (const o of Object.values(out)) if (ortOf(o).location === "gpu-buffer") ortOf(o).dispose();
    return { encodeMs: t1 - t0, runMs: t2 - t1, readMs: t3 - t2, totalMs: t3 - t0 };
  };
  const medians = (rows: Awaited<ReturnType<typeof parts>>[]) =>
    Object.fromEntries((["encodeMs", "runMs", "readMs", "totalMs"] as const).map((k) => [k, stats(rows.map((r) => r[k])).median]));

  if (tests.includes("shape")) {
    // Same shape: one cold call, then the identical input again.
    const same = labelsOf(20);
    const sameTokens = tokens(TEXT, same);
    const sameCold = await call(same);
    const sameWarm: number[] = [];
    for (let i = 0; i < SAME_CALLS; i++) sameWarm.push(await call(same));

    // New shape: a label count that no earlier call used, so the token count differs each time.
    const newMs: number[] = [];
    const newTokens: number[] = [];
    const seen = new Set([sameTokens]);
    for (let n = 21; newMs.length < NEW_CALLS && n < 200; n++) {
      const labels = labelsOf(n);
      const size = tokens(TEXT, labels);
      if (seen.has(size)) continue;
      seen.add(size);
      newTokens.push(size);
      newMs.push(await call(labels));
    }
    result.shape = { sameTokens, sameColdMs: sameCold, sameWarmMs: sameWarm, sameWarm: stats(sameWarm), newTokens, newMs, new: stats(newMs), newFirstMs: newMs[0] };
  }

  if (tests.includes("sweep")) {
    // Per-call ms against token count: about one label per 24 tokens, then text words up to the target.
    const sweep = [];
    for (const target of SWEEP) {
      const labels = target ? labelsOf(Math.max(1, Math.round(target / 24))) : { a: "" };
      let text = "";
      for (let i = 0; target && tokens(text, labels) < target; i++) text += `${text ? " " : ""}${FILL[i % FILL.length]}`;
      const size = tokens(text, labels);
      try {
        await parts(() => feedsOf(text, labels));
        const rows = [];
        for (let i = 0; i < SWEEP_CALLS; i++) rows.push(await parts(() => feedsOf(text, labels)));
        sweep.push({ target, tokens: size, ...medians(rows) });
      } catch (error) {
        sweep.push({ target, tokens: size, error: String(error) });
      }
    }
    result.sweep = sweep;
  }

  if (tests.includes("split")) {
    // One fixed input. Graph capture needs static shapes and GPU inputs, so it reuses one set of GPU tensors.
    const labels = labelsOf(20);
    const gpu = (env.backends.onnx as { webgpu?: { device?: GpuDevice } }).webgpu?.device;
    const fixed = session === "graph" && gpu ? feedsOf(TEXT, labels, (v) => gpuLong(gpu, v)) : undefined;
    const input = () => fixed ?? feedsOf(TEXT, labels);
    const cold = await parts(input);
    const rows = [];
    for (let i = 0; i < SAME_CALLS; i++) rows.push(await parts(input));
    result.split = { tokens: tokens(TEXT, labels), coldMs: cold.totalMs, ...medians(rows) };
  }
  return result;
}

main().then(
  (result) => ((window as unknown as { __result: unknown }).__result = result),
  (error) => ((window as unknown as { __result: unknown }).__result = { device, dtype, session, error: String(error?.stack ?? error) }),
);
