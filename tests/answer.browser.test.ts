// findAnswer on local fixture pages in Playwright's Chromium, with the real
// model on CPU. The adapter stands in for the extension's chrome.debugger.
import { existsSync } from "node:fs";
import { createReadStream } from "node:fs";
import { createServer, type Server } from "node:http";
import { env } from "@huggingface/transformers";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findAnswer, lastRows } from "@foxpilot/agent/answer";
import type { TabBrowser } from "@foxpilot/core/page/browser";
import { Gliner2 } from "@foxpilot/core/model/gliner2";

const ROOT = new URL("..", import.meta.url).pathname;
const have = existsSync(`${ROOT}dist-model/onnx/model.onnx`);
env.allowRemoteModels = false;
env.localModelPath = ROOT;

describe.skipIf(!have)("answer highlight on fixtures", () => {
  let server: Server, browser: Browser, page: Page, model: Gliner2;
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      createReadStream(`${ROOT}tests/fixtures${new URL(req.url!, "http://x").pathname}`).pipe(res);
    }).listen(5403);
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    model = await Gliner2.load("dist-model", { device: "cpu", dtype: "fp32" });
  }, 300_000);
  afterAll(async () => {
    await browser?.close();
    server?.close();
  });
  const adapter = () => ({ evaluate: (func: (...a: unknown[]) => unknown, ...args: unknown[]) => page.evaluate(`(${func})(...${JSON.stringify(args)})`) }) as unknown as TabBrowser;
  const chip = () => page.evaluate(() => document.getElementById("zipline-answer")?.shadowRoot?.querySelector(".chip")?.textContent ?? null);

  it("picks the cheapest morning flight, not the cheapest overall", async () => {
    await page.goto("http://localhost:5403/flights.html");
    const answer = await findAnswer(adapter(), model, "cheapest one-way ticket from New York to San Francisco on October 9, 2026 morning");
    expect(answer?.text).toContain("6:00 AM");
    expect(answer?.label).toBe("Cheapest morning option · $388");
    expect(await chip()).toBe("✦ Cheapest morning option · $388");
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
    expect(lastRows.find((r) => r.text.includes("at 6:00 AM"))).toMatchObject({ price: 388, depart: 360, duration: 374 });
  }, 120_000);

  it("takes the site's first result when the goal has no preference", async () => {
    await page.goto("http://localhost:5403/flights.html");
    const answer = await findAnswer(adapter(), model, "Find a one-way ticket from New York to San Francisco on October 9, 2026.");
    expect(answer?.label).toMatch(/^Top result · \$\d+$/);
    const first = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("li")].filter((e) => /\$\d/.test(e.innerText) && /\d:\d\d/.test(e.innerText));
      return rows[0]?.innerText.replace(/\s+/g, " ").trim().slice(0, 30);
    });
    expect(answer?.text.startsWith(first!)).toBe(true);
  }, 120_000);

  it("shopping: cheapest of the item itself, not ads, other brands or accessories", async () => {
    await page.goto("http://localhost:5403/shop.html");
    const answer = await findAnswer(adapter(), model, "find me cheapest kitchenaid mixer on amazon.com");
    expect(answer?.text).toContain("5 Speed Ultra Power Hand Mixer");
    expect(answer?.label).toBe("Cheapest option · $59.99");
  }, 120_000);

  it("picks the cheapest overall without a time window", async () => {
    await page.goto("http://localhost:5403/flights.html");
    const answer = await findAnswer(adapter(), model, "cheapest flight from New York to San Francisco");
    expect(answer?.text).toContain("6:15 PM");
  }, 120_000);

  it("still finds the answer card for goals without qualifiers", async () => {
    await page.goto("http://localhost:5403/search.html?q=weather%20seattle");
    const answer = await findAnswer(adapter(), model, "weather seattle");
    expect(answer?.text).toContain("14°C");
  }, 120_000);
});
