// verify() on captured Google Flights snapshots, with the real model on CPU.
import { existsSync, readFileSync } from "node:fs";
import { env } from "@huggingface/transformers";
import { beforeAll, describe, expect, it } from "vitest";
import { requirements, type Part } from "../src/agent/controller";
import type { HistoryEntry, Page } from "../src/agent/types";
import { verify } from "../src/agent/verify";
import { Gliner2 } from "@foxpilot/core/model/gliner2";

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

  it("checks the travel mode is the selected one, not just on the page", async () => {
    const goal = "Get walking directions from Marymoor Park to Blazing Bagels Redmond";
    const mapsParts = await requirements(goal, model);
    const page = (walking: boolean): Page => ({
      url: "https://maps.example.test/dir", title: "Marymoor Park to Blazing Bagels - Google Maps", marker: 0, page_key: [], guards: {},
      text: "Walking 21 min 1.1 miles via NE Marymoor Way and 176th Ave NE. Mostly flat. Details",
      actions: [
        { id: "d", kind: "click", label: "Driving", role: "radio", node: 1, document_id: 1, checked: String(!walking) },
        { id: "w", kind: "click", label: "Walking", role: "radio", node: 2, document_id: 1, checked: String(walking) },
        { id: "s", kind: "fill", label: "Starting point Marymoor Park, 6046 West Lake Sammamish Pkwy NE", role: "combobox", node: 3, document_id: 1, value: "Marymoor Park, 6046 West Lake Sammamish Pkwy NE, Redmond, WA 98052" },
        { id: "t", kind: "fill", label: "Destination Blazing Bagels, 6975 176th Ave NE #365", role: "combobox", node: 4, document_id: 1, value: "Blazing Bagels, 6975 176th Ave NE #365, Redmond, WA 98052" },
      ],
    });
    const walking = await verify(model, page(true), mapsParts, []);
    expect(walking.checks.find((c) => c.part === "Get walking directions")).toMatchObject({ ok: true, evidence: "Walking" });
    expect(walking.verified).toBe(true);
    const driving = await verify(model, page(false), mapsParts, []);
    expect(driving.checks.find((c) => c.part === "Get walking directions")?.ok).toBe(false);
    expect(driving.verified).toBe(false);
  }, 60_000);
});
