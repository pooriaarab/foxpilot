// WebGPU timing for the agent's calls. Served by bench/serve.mjs.
import { env } from "@huggingface/transformers";
import { Gliner2 } from "../src/model/gliner2";

type Case = { kind: "extract" | "classify"; text: string; labels: Record<string, string> };

const params = new URLSearchParams(location.search);
// ?model=<hub id> loads from the Hub; default is the local export.
const modelId = params.get("model") ?? "dist-model";
env.allowRemoteModels = modelId !== "dist-model";
env.allowLocalModels = modelId === "dist-model"; // off by default in browsers
env.localModelPath = "/";

const log = (line: string) => {
  (document.getElementById("log") as HTMLElement).textContent += line + "\n";
  console.log(line);
};

async function main() {
  const ref = (await (await fetch("/export/reference.json")).json()) as { cases: Case[] };
  const dtype = (params.get("dtype") ?? "fp16") as "fp16" | "fp32";
  let t = performance.now();
  const model = await Gliner2.load(modelId, { device: "webgpu", dtype });
  log(`load ${Math.round(performance.now() - t)} ms (${modelId}, webgpu, ${dtype})`);

  const extract = ref.cases.filter((c) => c.kind === "extract");
  const classify = ref.cases.filter((c) => c.kind === "classify");
  t = performance.now();
  await model.extractEntities(extract[0]!.text, extract[0]!.labels);
  log(`first call (shader compile) ${Math.round(performance.now() - t)} ms`);

  const time = async (label: string, fn: () => Promise<unknown>, n = 5) => {
    const ms: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = performance.now();
      await fn();
      ms.push(performance.now() - s);
    }
    ms.sort((a, b) => a - b);
    log(`${label.padEnd(44)} median ${ms[Math.floor(n / 2)]!.toFixed(0)} ms  (min ${ms[0]!.toFixed(0)})`);
  };
  for (const c of extract) await time(`extract "${c.text.slice(0, 32)}…"`, () => model.extractEntities(c.text, c.labels));
  for (const c of classify.slice(0, 4)) await time(`classify "${c.text.slice(0, 30)}" (${Object.keys(c.labels).length} labels)`, () => model.classify(c.text, "referenced", c.labels));
  // Label-count sweep: calendar pickers put 40+ long day labels in the schema.
  if (params.get("sweep")) {
    const day = (i: number, price: number) => new Date(Date.UTC(2026, 8, 20 + i)).toUTCString().slice(0, 16) + ` , ${price} US dollars`;
    for (const n of [10, 23, 30, 36, 40, 46, 52, 47, 48, 49, 50, 51, 53, 54]) {
      for (const price of [2, 1275]) {
        const labels = Object.fromEntries(Array.from({ length: n }, (_, i) => [day(i, price), ""]));
        const tokens = (model as unknown as { encode: (t: string, o: object) => { inputIds: number[] } })
          .encode("on the 1st Friday of next month", { name: "referenced", marker: "[L]", labels }).inputIds.length;
        const s = performance.now();
        await model.classify("on the 1st Friday of next month", "referenced", labels);
        const first = performance.now() - s;
        const s2 = performance.now();
        await model.classify("on the 1st Friday of next month", "referenced", labels);
        log(`sweep ${String(n).padStart(2)} labels · ${tokens} tokens · new shape ${first.toFixed(0)} ms · same shape ${(performance.now() - s2).toFixed(0)} ms`);
      }
    }
  }
  const got = await model.extractEntities(extract[0]!.text, extract[0]!.labels);
  log(`check: ${JSON.stringify(Object.fromEntries(Object.entries(got).filter(([, v]) => v.length).map(([k, v]) => [k, v.map((e) => e.text)])))}`);
  log("DONE");
}

main().catch((error) => log(`ERROR ${error?.stack ?? error}`));
