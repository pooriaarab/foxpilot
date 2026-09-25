// Runs Zipline end to end in Playwright's Chromium: loads the extension, opens
// a task page, opens the panel (as its own window, pointed at that tab), runs
// the goal, and prints each step and the result.
// Usage: pnpm build && node scripts/e2e.mjs [flights|maps|wiki] [--llm]
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TASKS = {
  flights: ["https://www.google.com/travel/flights?hl=en", "Find a one-way ticket from New York to San Francisco on October 9, 2026."],
  maps: ["https://www.google.com/maps?hl=en", "Get directions from Berlin Hauptbahnhof to Brandenburg Gate. Select Walking."],
  wiki: ["https://en.wikipedia.org/wiki/Main_Page", "Search Wikipedia for the Golden Gate Bridge."],
};
const [url, goal] = TASKS[process.argv[2] ?? "flights"];
const useLlm = process.argv.includes("--llm");

const context = await chromium.launchPersistentContext(join(root, ".e2e-profile"), {
  headless: false,
  viewport: { width: 1120, height: 780 },
  locale: "en-US",
  args: [`--disable-extensions-except=${join(root, "dist")}`, `--load-extension=${join(root, "dist")}`],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
const extensionId = new URL(worker.url()).host;

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url, { waitUntil: "domcontentloaded" });
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
if (useLlm) {
  await panel.locator("#llm-toggle").check();
  await panel.waitForFunction(() => /On:|Failed/.test(document.getElementById("llm-status")?.textContent ?? ""), null, { timeout: 600_000 });
  console.log("llm:", await panel.locator("#llm-status").textContent());
}
await panel.locator("#goal").fill(goal);
await panel.locator("#run").click();
await panel.waitForFunction(() => !document.getElementById("result")?.hidden, null, { timeout: 180_000 });

const steps = await panel.locator("#steps li").allTextContents();
for (const s of steps) console.log("  ", s.replace(/\s+/g, " ").trim());
console.log("result:", await panel.locator("#result").textContent(), "| clock:", await panel.locator("#elapsed").textContent());
await page.screenshot({ path: join(root, "e2e-page.png") });
await context.close();
