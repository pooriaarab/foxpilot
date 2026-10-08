// Captures snapshot.js observations of real pages for controller parity tests.
// Usage: node tests/capture.mjs  → tests/fixtures/*.json
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { snapshot } from "../src/agent/snapshot.js";

const out = (name, state, extra = {}) => {
  writeFileSync(new URL(`fixtures/${name}.json`, import.meta.url), JSON.stringify({ ...extra, state }, null, 1));
  console.log(name, state.actions.length, "actions", state.title);
};

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1120, height: 780 }, locale: "en-US" });
const observe = () => page.evaluate(snapshot);

await page.goto("https://www.google.com/travel/flights?hl=en", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);
out("flights-start", await observe(), { goal: "Find a one-way ticket from New York to San Francisco on October 9, 2026." });

// Type into "Where from?" the way the agent does (select all, insert text), then observe the suggestions.
const from = page.getByRole("combobox", { name: /Where from/ }).first();
await from.click();
await page.keyboard.press("Meta+A");
await page.keyboard.insertText("New York");
await page.waitForTimeout(1500);
const typed = await observe();
out("flights-typed-origin", typed, { goal: "Find a one-way ticket from New York to San Francisco on October 9, 2026." });

await page.goto("https://www.google.com/maps?hl=en", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);
out("maps-start", await observe(), { goal: "Get directions from Berlin Hauptbahnhof to Brandenburg Gate. Select Walking." });

await browser.close();
