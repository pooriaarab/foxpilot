// Runs Zipline end to end in Playwright's Chromium: loads the extension, opens
// a task page, opens the panel (as its own window, pointed at that tab), runs
// the goal, and prints each step and the result.
// Usage: pnpm build && node scripts/e2e.mjs [flights|maps|wiki] [--llm]
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Local fixtures, so development runs do not hit real sites.
const fixtures = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  createReadStream(join(root, "tests/fixtures", new URL(req.url, "http://x").pathname.replace(/^\/+/, "") || "search.html")).on("error", () => res.writeHead(404).end()).pipe(res);
}).listen(5402);
const TASKS = {
  flights: ["https://www.google.com/travel/flights?hl=en", "Find a one-way ticket from New York to San Francisco on October 9, 2026."],
  maps: ["https://www.google.com/maps?hl=en", "Get directions from Berlin Hauptbahnhof to Brandenburg Gate."],
  walking: ["https://www.google.com/maps?hl=en", "Get directions from Berlin Hauptbahnhof to Brandenburg Gate. Select Walking."],
  newtab: ["chrome://newtab/", "Weather in Seattle"],
  local: ["http://localhost:5402/search.html", "weather seattle"],
  stock: ["http://localhost:5402/search.html", "snowflake stock price"],
  wiki: ["https://en.wikipedia.org/wiki/Main_Page", "Search Wikipedia for the Golden Gate Bridge."],
};
const [url, goal] = process.env.GOAL ? [process.env.URL ?? "http://localhost:5402/search.html", process.env.GOAL] : TASKS[process.argv[2] ?? "flights"];
const useLlm = process.argv.includes("--llm");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext(join(root, ".e2e-profile"), {
  headless: false,
  viewport: { width: 1120, height: 780 },
  locale: "en-US",
  args: [`--disable-extensions-except=${join(root, "dist")}`, `--load-extension=${join(root, "dist")}`],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
const extensionId = new URL(worker.url()).host;

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(2500);
const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true }))[0]?.id);

const panelPromise = context.waitForEvent("page");
await worker.evaluate(
  ([id, tab]) => chrome.windows.create({ url: `chrome-extension://${id}/sidepanel.html?tab=${tab}`, type: "popup", width: 420, height: 900, left: 1140, top: 0 }),
  [extensionId, tabId],
);
const panel = await panelPromise;
panel.on("console", (m) => { if (m.type() === "error") console.log("[panel]", m.text()); });
await panel.waitForFunction(() => /Ready|Failed/.test(document.getElementById("gliner-status")?.textContent ?? ""), null, { timeout: 600_000 });
console.log("gliner:", await panel.locator("#gliner-status").textContent());
if (!useLlm && (await panel.locator("#llm-toggle").isChecked())) await panel.locator("#llm-toggle").uncheck();
if (useLlm) {
  await panel.locator("#llm-toggle").check();
  await panel.waitForFunction(() => /On:|Failed/.test(document.getElementById("llm-status")?.textContent ?? ""), null, { timeout: 600_000 });
  console.log("llm:", await panel.locator("#llm-status").textContent());
}
await panel.locator("#goal").fill(goal);
await panel.locator("#run").click();
if (process.env.MARKSHOT) {
  // Capture the page while an action highlight is showing.
  for (let i = 0; i < 200; i++) {
    if (await page.evaluate(() => !!document.getElementById("zipline-action")).catch(() => false)) {
      await page.screenshot({ path: process.env.MARKSHOT });
      console.log("captured action highlight");
      break;
    }
    await sleep(25);
  }
}
await panel.waitForFunction(() => !document.getElementById("result")?.hidden, null, { timeout: 180_000 });

const steps = await panel.locator("#steps li").allTextContents();
for (const s of steps) console.log("  ", s.replace(/\s+/g, " ").trim());
console.log("tab group:", await worker.evaluate(async (id) => { const t = await chrome.tabs.get(id); return t.groupId === -1 ? "(none)" : (await chrome.tabGroups.get(t.groupId)).title; }, tabId));
await sleep(1500);
await panel.waitForFunction(() => "__ziplineAnswer" in window || !/Done/.test(document.getElementById("result")?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => {});
console.log("answer:", await panel.locator(".answer").textContent().catch(() => "(none)"));
const dbg = await panel.evaluate(() => window.__ziplineAnswer).catch(() => null);
if (dbg) for (const c of [...(dbg.scores ?? [])].sort((a, b) => b.score - a.score).slice(0, 8)) console.log("   ", c.score.toFixed(2), c.text);
await sleep(3000);
await page.screenshot({ path: join(root, "e2e-answer.png") }).catch(() => {});
console.log("tab group after 4.5 s:", await worker.evaluate(async (id) => (await chrome.tabs.get(id)).groupId === -1 ? "(ungrouped)" : "still grouped", tabId));
console.log("result:", await panel.locator("#result").textContent(), "| clock:", await panel.locator("#elapsed").textContent());
if (process.env.DUMP) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.DUMP, JSON.stringify(await panel.evaluate(() => window.__zipline), null, 1));
  console.log("wrote", process.env.DUMP);
}
await page.screenshot({ path: join(root, "e2e-page.png") });
await context.close();
fixtures.close();
