// Parity with the Python gliner2 library on export/reference.json.
// Needs the exported model in dist-model/ (python export/export_onnx.py).
import { readFileSync, existsSync } from "node:fs";
import { env } from "@huggingface/transformers";
import { describe, expect, it } from "vitest";
import { Gliner2, type Labels } from "../src/model/gliner2";

type Case = {
  kind: "extract" | "classify";
  text: string;
  labels: Labels;
  tensors: { input_ids: number[]; word_positions: number[]; schema_positions: number[][] };
  result: { entities?: Record<string, { text: string; confidence: number }[]> } & Record<string, unknown>;
};

const ROOT = new URL("..", import.meta.url).pathname;
const ref = JSON.parse(readFileSync(`${ROOT}export/reference.json`, "utf8")) as { cases: Case[] };
const have = existsSync(`${ROOT}dist-model/onnx/model.onnx`);

env.allowRemoteModels = false;
env.localModelPath = ROOT;

describe.skipIf(!have)("GLiNER2 JS runtime vs Python", () => {
  let model: Gliner2;
  const dtype = (process.env.DTYPE as "fp32" | "fp16") ?? "fp32";

  it("loads", async () => {
    model = await Gliner2.load("dist-model", { device: "cpu", dtype });
  }, 300_000);

  it("encodes every call to the exact token ids and positions", () => {
    for (const c of ref.cases) {
      const task = c.kind === "extract"
        ? { name: "entities", marker: "[E]" as const, labels: c.labels }
        : { name: "referenced", marker: "[L]" as const, labels: c.labels };
      const encoded = model.encode(c.text, task);
      expect(encoded.inputIds, c.text).toEqual(c.tensors.input_ids);
      expect(encoded.wordPositions, c.text).toEqual(c.tensors.word_positions);
      expect(encoded.schemaPositions, c.text).toEqual(c.tensors.schema_positions[0]);
    }
  });

  it("matches extraction and classification results", async () => {
    const tol = dtype === "fp16" ? 5e-3 : 1e-4;
    for (const c of ref.cases) {
      if (c.kind === "extract") {
        const got = await model.extractEntities(c.text, c.labels);
        for (const [name, want] of Object.entries(c.result.entities ?? {})) {
          expect(got[name]!.map((e) => e.text), `${c.text} / ${name}`).toEqual(want.map((e) => e.text));
          got[name]!.forEach((e, i) => expect(Math.abs(e.confidence - want[i]!.confidence)).toBeLessThan(tol));
        }
      } else {
        const got = await model.classify(c.text, "referenced", c.labels);
        const want = c.result as Record<string, number>;
        const best = (r: Record<string, number>) => Object.entries(r).sort((a, b) => b[1] - a[1])[0]![0];
        expect(best(got), c.text).toBe(best(want));
        for (const label of Object.keys(want)) expect(Math.abs(got[label]! - want[label]!)).toBeLessThan(tol);
      }
    }
  }, 300_000);
});
