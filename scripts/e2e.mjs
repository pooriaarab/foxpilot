// Runs Foxpilot end to end in Firefox: loads the built extension in a fresh
// profile, opens a task page, opens the panel as its own tab pointed at that
// page (?tab=<id>), runs the goal, and writes a JSON record and a screenshot
// to artifacts/. Exit code 0 only when the panel verifies the goal.
// Usage: pnpm e2e [flights|maps|walking] [--llm] [--headless] [--dry-run]
// Env: FIREFOX (binary path), GOAL and URL (a custom task).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const FIREFOX = process.env.FIREFOX ?? "/Applications/Firefox.app/Contents/MacOS/firefox";
// Fixed, so the panel URL is known before the extension loads.
const UUID = "5f3c9a7e-2b1d-4e6a-9c80-1d2e3f4a5b6c";
const GECKO_ID = "foxpilot@pooriaarab.github.io";
const TASKS = {
  flights: ["https://www.google.com/travel/flights?hl=en", "Find a one-way ticket from New York to San Francisco on October 9, 2026."],
  maps: ["https://www.google.com/maps?hl=en", "Get directions from Berlin Hauptbahnhof to Brandenburg Gate."],
  walking: ["https://www.google.com/maps?hl=en", "Get directions from Berlin Hauptbahnhof to Brandenburg Gate. Select Walking."],
};
const args = process.argv.slice(2);
const task = args.find((a) => !a.startsWith("--")) ?? "flights";
const useLlm = args.includes("--llm");
const headless = args.includes("--headless");
const [url, goal] = process.env.GOAL ? [process.env.URL ?? TASKS.flights[0], process.env.GOAL] : TASKS[task] ?? [];
if (!goal) {
  console.error(`Unknown task "${task}". Use one of: ${Object.keys(TASKS).join(", ")}.`);
  process.exit(2);
}
if (args.includes("--dry-run")) {
  console.log(JSON.stringify({ firefox: FIREFOX, firefoxFound: existsSync(FIREFOX), dist, distBuilt: existsSync(join(dist, "manifest.json")), task, url, goal, useLlm, headless }, null, 1));
  process.exit(0);
}
for (const [what, path] of [["Firefox", FIREFOX], ["the built extension (run pnpm build)", join(dist, "manifest.json")]]) {
  if (!existsSync(path)) {
    console.error(`Cannot find ${what} at ${path}.`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// BiDi does not report navigation events for moz-extension: pages, so goto()
// never resolves there and waitForFunction() dies when the page reloads.
// Poll with plain evaluate() calls instead, retrying across reloads.
async function poll(page, fn, arg, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await page.evaluate(fn, arg).catch(() => false);
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${fn.toString().slice(0, 80)}`);
    await sleep(250);
  }
}
async function openExtensionPage(page, target) {
  page.goto(target, { timeout: 0 }).catch(() => {});
  await poll(page, (u) => location.href === u && document.readyState === "complete", target, 30_000);
}
const git = (...a) => { try { return execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim(); } catch { return "unknown"; } };
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(root, "artifacts");
mkdirSync(out, { recursive: true });
const base = join(out, `${task}-${stamp}`);
const profile = mkdtempSync(join(tmpdir(), "foxpilot-e2e-"));

const started = Date.now();
const browser = await puppeteer.launch({
  browser: "firefox",
  executablePath: FIREFOX,
  headless, // WebGPU needs a headed Firefox
  userDataDir: profile,
  // BiDi refuses to touch moz-extension: pages without system access.
  args: ["-remote-allow-system-access"],
  defaultViewport: null,
  extraPrefsFirefox: { "extensions.webextensions.uuids": JSON.stringify({ [GECKO_ID]: UUID }) },
});
const record = { task, goal, url, llm: useLlm, firefox: await browser.version(), gitSha: git("rev-parse", "HEAD"), steps: [], checks: [], verified: false };
let failure = null;
let page;
try {
  await browser.installExtension(dist);
  page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch((e) => console.log("goto:", e.message));
  await sleep(2500);

  // The panel is a normal tab here. It looks the task tab up by URL, then reloads itself with ?tab=<id>.
  const panelUrl = `moz-extension://${UUID}/sidepanel.html`;
  const panel = await browser.newPage();
  panel.on("console", (m) => { if (m.type() === "error") console.log("[panel]", m.text()); });
  await openExtensionPage(panel, panelUrl);
  const tabId = await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url && !t.url.startsWith("moz-extension:") && !t.url.startsWith("about:"))?.id;
  });
  if (!tabId) throw new Error("Cannot find the task tab from the panel.");
  await openExtensionPage(panel, `${panelUrl}?tab=${tabId}`);

  await poll(panel, () => /Ready|Failed/.test(document.getElementById("gliner-status")?.textContent ?? ""), undefined, 600_000);
  const glinerStatus = await panel.$eval("#gliner-status", (e) => e.textContent ?? "");
  console.log("gliner:", glinerStatus);
  record.modelLoadMs = Math.round(Number(/loaded in ([\d.]+) s/.exec(glinerStatus)?.[1] ?? NaN) * 1000) || null;
  if (/Failed/.test(glinerStatus)) throw new Error(`Model failed to load: ${glinerStatus}`);

  const llmOn = await panel.$eval("#llm-toggle", (e) => e.checked);
  if (llmOn !== useLlm) await panel.$eval("#llm-toggle", (e) => e.click());
  if (useLlm) {
    await poll(panel, () => /On:|Failed/.test(document.getElementById("llm-status")?.textContent ?? ""), undefined, 600_000);
    console.log("llm:", await panel.$eval("#llm-status", (e) => e.textContent));
  }

  // Time each step as the panel adds it to the log.
  await panel.evaluate(() => {
    window.__e2eSteps = [];
    new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) if (n.nodeName === "LI") window.__e2eSteps.push({ at: performance.now(), el: n });
    }).observe(document.getElementById("steps"), { childList: true });
  });
  await page.bringToFront();
  await panel.$eval("#goal", (e, g) => { e.value = g; e.dispatchEvent(new Event("input", { bubbles: true })); }, goal);
  const runAt = Date.now();
  await panel.evaluate(() => { window.__e2eRun = performance.now(); });
  await panel.$eval("#run", (e) => e.click());
  await poll(panel, () => !document.getElementById("result")?.hidden, undefined, 180_000);
  // The verdict box lands after the answer search.
  await panel.waitForSelector(".verdict", { timeout: 60_000 }).catch(() => {});
  record.totalMs = Date.now() - runAt;

  record.steps = await panel.evaluate(() => {
    let prev = window.__e2eRun;
    return window.__e2eSteps.map(({ at, el }) => {
      const ms = Math.round(at - prev);
      prev = at;
      return { action: (el.textContent ?? "").replace(/\s+/g, " ").trim(), ms };
    });
  });
  record.checks = await panel.$$eval(".verdict li", (els) => els.map((e) => ({ ok: e.classList.contains("ok"), text: (e.textContent ?? "").replace(/\s+/g, " ").trim() })));
  record.verified = await panel.$eval(".verdict", (e) => e.classList.contains("ok")).catch(() => false);
  record.result = await panel.$eval("#result", (e) => e.textContent?.trim() ?? "");
  record.answer = await panel.$eval(".answer", (e) => e.textContent?.trim() ?? "").catch(() => null);
  for (const s of record.steps) console.log(`  ${String(s.ms).padStart(6)} ms  ${s.action}`);
  for (const c of record.checks) console.log(`  ${c.ok ? "ok " : "BAD"} ${c.text}`);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  record.error = failure;
}
if (page) await page.screenshot({ path: `${base}.png` }).catch((e) => console.log("screenshot:", e.message));
record.passed = record.verified && !failure;
record.wallMs = Date.now() - started;
writeFileSync(`${base}.json`, JSON.stringify(record, null, 2));
await browser.close().catch(() => {});
rmSync(profile, { recursive: true, force: true });
console.log(`${record.passed ? "PASS" : "FAIL"} ${task}${failure ? `: ${failure}` : ""} | ${base}.json`);
process.exit(record.passed ? 0 : 1);
