// verify() on captured Google Flights snapshots, with the real model on CPU.
import { existsSync, readFileSync } from "node:fs";
import { env } from "@huggingface/transformers";
import { beforeAll, describe, expect, it } from "vitest";
import { requirements, type Part } from "../src/agent/controller";
import type { HistoryEntry, Page } from "../src/agent/types";
import { verify } from "../src/agent/verify";
import { Gliner2 } from "../src/model/gliner2";

const ROOT = new URL("..", import.meta.url).pathname;
const have = existsSync(`${ROOT}dist-model/onnx/model.onnx`);
env.allowRemoteModels = false;
env.localModelPath = ROOT;

const GOAL = "Find a one-way ticket from New York to San Francisco on October 9, 2026.";
const load = (name: string) => (JSON.parse(readFileSync(`${ROOT}tests/fixtures/${name}.json`, "utf8")) as { state: Page }).state;

describe.skipIf(!have)("verify", () => {
  let model: Gliner2;
  let parts: Part[];
  beforeAll(async () => {
    model = await Gliner2.load("dist-model", { device: "cpu", dtype: "fp32" });
    parts = await requirements(GOAL, model);
  }, 300_000);

  const filled = (doc: number | undefined): HistoryEntry[] => [
    { action: "Where from?", node: 16, document_id: doc, kind: "fill", form: 13, text: "New York" },
    { action: "Departure", node: 18, document_id: doc, kind: "fill", form: 13, text: "2026-10-09" },
  ];

  it("passes when the form shows every part and was sent", async () => {
    const page = load("flights-resend");
    const doc = page.actions[0]!.document_id;
    const verdict = await verify(model, page, parts, [...filled(doc), { action: "Search", node: 99, document_id: doc, kind: "click", form: 13 }]);
    expect(verdict.checks.map((c) => [c.part, c.ok])).toEqual([
      ["Find a one-way ticket", true], ["from New York", true], ["to San Francisco", true], ["on October 9, 2026", true],
    ]);
    expect(verdict.verified).toBe(true);
  }, 60_000);

  it("fails a form that was filled but never sent", async () => {
    const page = load("flights-resend");
    const verdict = await verify(model, page, parts, filled(page.actions[0]!.document_id));
    expect(verdict.checks.find((c) => c.part === "Search sent")?.ok).toBe(false);
    expect(verdict.verified).toBe(false);
  }, 60_000);

  it("reads the form, not tracked-price cards beside it", async () => {
    // Round trip from Seattle, next to cards saying "One way trip from New York…".
    const verdict = await verify(model, load("flights-tracked"), parts, []);
    const ok = Object.fromEntries(verdict.checks.map((c) => [c.part, c.ok]));
    expect(ok["Find a one-way ticket"]).toBe(false);
    expect(ok["from New York"]).toBe(false);
    expect(verdict.verified).toBe(false);
  }, 60_000);

  it("flags a captcha page", async () => {
    const page: Page = { ...load("flights-resend"), title: "Google", text: "Our systems have detected unusual traffic from your computer network. I'm not a robot", actions: [] };
    const verdict = await verify(model, page, parts, []);
    expect(verdict.problem).toBeTruthy();
    expect(verdict.verified).toBe(false);
  }, 60_000);
});
