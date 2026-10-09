// The TypeScript controller makes the same decisions as gliner2-ultrafast's
// Python controller (tests/oracle.py) on captured real-page snapshots.
import { existsSync, readFileSync } from "node:fs";
import { env } from "@huggingface/transformers";
import { describe, expect, it } from "vitest";
import { choose, requirements, type Part } from "../src/agent/controller";
import type { HistoryEntry, Page } from "../src/agent/types";
import { Gliner2 } from "@foxpilot/core/model/gliner2";

type OracleCase = {
  name: string;
  goal: string;
  history: HistoryEntry[];
  parts: Part[];
  decision: { choice: string; operation: string; target: string | null; requirement: string | null; covered: string[]; commits: boolean; date: string | null; confidence: number };
};

const ROOT = new URL("..", import.meta.url).pathname;
const oracle = existsSync(`${ROOT}tests/fixtures/oracle.json`)
  ? (JSON.parse(readFileSync(`${ROOT}tests/fixtures/oracle.json`, "utf8")) as OracleCase[])
  : [];
const have = oracle.length > 0 && existsSync(`${ROOT}dist-model/onnx/model.onnx`);
env.allowRemoteModels = false;
env.localModelPath = ROOT;

describe.skipIf(!have)("controller vs Python", () => {
  let model: Gliner2;
  it("loads", async () => {
    model = await Gliner2.load("dist-model", { device: "cpu", dtype: "fp32" });
  }, 300_000);

  for (const c of oracle) {
    it(`${c.name}: same requirements and decision`, async () => {
      const state = (JSON.parse(readFileSync(`${ROOT}tests/fixtures/${c.name}.json`, "utf8")) as { state: Page }).state;
      const parts = await requirements(c.goal, model);
      expect(parts).toEqual(c.parts);
      const decision = await choose(model, state, c.history, new Map(), new Set(), parts, new Set());
      const { choice, operation, target, requirement, covered, commits, date } = decision;
      expect({ choice, operation, target, requirement, covered, commits, date }).toEqual({
        choice: c.decision.choice, operation: c.decision.operation, target: c.decision.target,
        requirement: c.decision.requirement, covered: c.decision.covered, commits: c.decision.commits, date: c.decision.date,
      });
      expect(Math.abs(decision.confidence - c.decision.confidence)).toBeLessThan(1e-3);
    }, 120_000);
  }

  // Zipline addition, not in the oracle: an account's tracked-price cards
  // ("One way trip from New York … to Denver.") must not keep the form's ticket
  // type below the floor, which sent a one-way goal off as a round trip.
  it("flights with tracked-price cards: ticket type first", async () => {
    const state = (JSON.parse(readFileSync(`${ROOT}tests/fixtures/flights-tracked.json`, "utf8")) as { state: Page }).state;
    const goal = oracle.find((c) => c.name === "flights-start")!.goal;
    const parts = await requirements(goal, model);
    const decision = await choose(model, state, [], new Map(), new Set(), parts, new Set());
    expect(decision.target).toBe("Change ticket type. Round trip");
    expect(decision.confidence).toBeGreaterThan(0.5);
  }, 120_000);

  // Zipline addition: "Search" was clicked early, then the ticket type changed.
  // The form has something new to send, so Search is pressed again.
  it("flights: search again after the form changed", async () => {
    const state = (JSON.parse(readFileSync(`${ROOT}tests/fixtures/flights-resend.json`, "utf8")) as { state: Page }).state;
    const goal = oracle.find((c) => c.name === "flights-start")!.goal;
    const parts = await requirements(goal, model);
    const doc = state.actions[0]!.document_id;
    const history: HistoryEntry[] = [
      { action: "Where from?", node: 16, document_id: doc, kind: "fill", form: 13, text: "New York", requirement: parts[1]!.text },
      { action: "Search", node: 99, document_id: doc, kind: "click", form: 13 },
      { action: "Change ticket type. Round trip", node: 12, document_id: doc, kind: "click", form: 13 },
      { action: "One way", kind: "click", requirement: parts[0]!.text },
    ];
    const served = new Set(parts.map((p) => p.text));
    const decision = await choose(model, state, history, new Map(), new Set(), parts, served);
    expect(decision.target).toBe("Search");
  }, 120_000);

  it("resolves 'the 1st Friday of next month' to a date part", async () => {
    const parts = await requirements("Book me a flight from New York to San Francisco on the 1st Friday of next month", model, new Date(2026, 8, 25));
    expect(parts.find((p) => p.date)).toMatchObject({ text: "on the 1st Friday of next month", date: "2026-10-02" });
    expect(parts.map((p) => p.values).flat()).toEqual(expect.arrayContaining(["new york", "san francisco"]));
  }, 60_000);

  // Zipline addition: with the calendar open on the wanted day, the date is
  // matched in code and GLiNER2 is not called at all.
  it("clicks the wanted day in an open calendar without model calls", async () => {
    const state = (JSON.parse(readFileSync(`${ROOT}tests/fixtures/flights-calendar.json`, "utf8")) as { state: Page }).state;
    const parts = await requirements("Find a one-way ticket from New York to San Francisco on the 1st Friday of next month", model, new Date(2026, 8, 25));
    const served = new Set(parts.filter((p) => !p.date).map((p) => p.text));
    const refuse = () => { throw new Error("model called"); };
    const decision = await choose({ extractEntities: refuse, classify: refuse, classifyMany: refuse }, state, [], new Map(), new Set(), parts, served);
    expect(decision.target).toBe("Friday, October 2, 2026 , 275 US dollars");
  }, 60_000);

  // Zipline addition: a "to …" part keeps its whole place name.
  it("keeps the whole place in 'to Blazing Bagles Redmond'", async () => {
    const parts = await requirements("Get walking directions from Marmoor Park to Blazing Bagles Redmond", model);
    expect(parts.find((p) => p.text.startsWith("to "))?.values).toEqual(["blazing bagles redmond"]);
    expect(parts.find((p) => p.text.startsWith("from "))?.values).toEqual(["marmoor park"]);
  }, 60_000);
});
