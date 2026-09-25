// WebGPU timing for the agent's calls. Served by bench/serve.mjs.
import { env } from "@huggingface/transformers";
import { Gliner2 } from "../src/model/gliner2";

type Case = { kind: "extract" | "classify"; text: string; labels: Record<string, string> };

env.allowRemoteModels = false;
env.allowLocalModels = true; // off by default in browsers
env.localModelPath = "/";

const log = (line: string) => {
  (document.getElementById("log") as HTMLElement).textContent += line + "\n";
  console.log(line);
};

async function main() {
  const ref = (await (await fetch("/export/reference.json")).json()) as { cases: Case[] };
  const dtype = (new URLSearchParams(location.search).get("dtype") ?? "fp16") as "fp16" | "fp32";
  let t = performance.now();
  const model = await Gliner2.load("dist-model", { device: "webgpu", dtype });
  log(`load ${Math.round(performance.now() - t)} ms (webgpu, ${dtype})`);

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
  const got = await model.extractEntities(extract[0]!.text, extract[0]!.labels);
  log(`check: ${JSON.stringify(Object.fromEntries(Object.entries(got).filter(([, v]) => v.length).map(([k, v]) => [k, v.map((e) => e.text)])))}`);
  log("DONE");
}

main().catch((error) => log(`ERROR ${error?.stack ?? error}`));
