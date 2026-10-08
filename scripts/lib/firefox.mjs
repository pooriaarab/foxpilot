// Drives foxpilot in a real Firefox. One session is one Firefox with the
// built extension (dist/) in a fresh profile, one task tab, and the panel in
// its own window. One session runs many goals, so GLiNER2 loads once.
//
//   const session = await launch({ headless });  // Firefox, extension, panel window
//   const tabId = await session.openTask(url);    // loads url in the task tab
//   const { modelLoadMs } = await session.ready(); // waits for GLiNER2
//   const result = await session.run(goal, { tabId, llm }); // RunResult, src/panel/sidepanel.ts
//   await session.screenshot(path);                // the task tab
//   await session.close();
//
// format(result) gives the human-readable lines. preflight() names a missing
// Firefox or build. Env: FIREFOX (binary path).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

export const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const dist = join(root, "dist");
export const FIREFOX = process.env.FIREFOX ?? "/Applications/Firefox.app/Contents/MacOS/firefox";
// Fixed, so the panel URL is known before the extension loads.
const UUID = "5f3c9a7e-2b1d-4e6a-9c80-1d2e3f4a5b6c";
const GECKO_ID = "foxpilot@pooriaarab.github.io";
const PANEL = `moz-extension://${UUID}/sidepanel.html`;
// A first model download, or a run with the LLM, can take minutes.
const LONG_MS = 600_000;

/** Why a session cannot start (no Firefox, no build), or null. */
export function preflight() {
  for (const [what, path] of [["Firefox", FIREFOX], ["the built extension (run pnpm build)", join(dist, "manifest.json")]]) {
    if (!existsSync(path)) return `Cannot find ${what} at ${path}.`;
  }
  return null;
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

export async function launch({ headless = false } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "foxpilot-"));
  const browser = await puppeteer.launch({
    browser: "firefox",
    executablePath: FIREFOX,
    headless, // WebGPU needs a headed Firefox
    userDataDir: profile,
    // BiDi refuses to touch moz-extension: pages without system access.
    args: ["-remote-allow-system-access"],
    defaultViewport: null,
    protocolTimeout: LONG_MS,
    extraPrefsFirefox: { "extensions.webextensions.uuids": JSON.stringify({ [GECKO_ID]: UUID }) },
  });
  const close = async () => {
    await browser.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  };
  try {
    await browser.installExtension(dist);
    const task = await browser.newPage();
    // The real sidebar cannot be opened over BiDi (it needs a user gesture). A popup
    // window is the closest match: the panel is visible, so its timers run at full
    // speed, and focus sits outside the task page, as it does in the sidebar.
    const opener = await browser.newPage();
    await openExtensionPage(opener, PANEL);
    await opener.evaluate(async (u) => {
      await chrome.windows.create({ url: u, type: "popup", left: 1284, top: 0, width: 440, height: 1080, focused: true });
    }, PANEL);
    let panel = null;
    for (const deadline = Date.now() + 30_000; !panel && Date.now() < deadline; await sleep(250)) {
      for (const p of await browser.pages()) {
        if (p !== opener && (await p.evaluate(() => location.href).catch(() => null)) === PANEL) panel = p;
      }
    }
    if (!panel) throw new Error("The panel window did not open.");
    await opener.close();
    panel.on("console", (m) => { if (m.type() === "error") console.error("[panel]", m.text()); });
    await poll(panel, () => typeof window.foxpilot === "object" && document.readyState === "complete", undefined, 30_000);
    return session(browser, task, panel, close);
  } catch (error) {
    await close();
    throw error;
  }
}

function session(browser, task, panel, close) {
  let tabId = null;
  return {
    version: () => browser.version(),
    async openTask(url) {
      await task.goto(url, { waitUntil: "domcontentloaded" }).catch((e) => console.error("goto:", e.message));
      await sleep(2500);
      if (tabId == null) {
        tabId = await panel.evaluate(async () => {
          const tabs = await chrome.tabs.query({});
          return tabs.find((t) => t.url && !t.url.startsWith("moz-extension:") && !t.url.startsWith("about:"))?.id;
        });
        if (!tabId) throw new Error("Cannot find the task tab from the panel.");
        // Side by side, task page left and panel right, so a run is easy to watch and record.
        await panel.evaluate(async (id) => {
          const { windowId } = await chrome.tabs.get(id);
          await chrome.windows.update(windowId, { left: 0, top: 0, width: 1280, height: 1080, state: "normal" });
        }, tabId);
      }
      return tabId;
    },
    ready: () => panel.evaluate(() => window.foxpilot.ready()),
    async run(goal, { tabId: tab, llm = false }) {
      const id = (await panel.evaluate(() => window.foxpilot.last()?.id ?? 0)) + 1;
      return panel.evaluate((o) => window.foxpilot.run(o), { goal, tabId: tab, llm }).catch(async (error) => {
        // BiDi can drop a long call; the panel keeps the result.
        console.error("run call dropped, polling:", error.message);
        await poll(panel, (n) => window.foxpilot.last()?.id === n, id, LONG_MS);
        return panel.evaluate(() => window.foxpilot.last());
      });
    },
    screenshot: (path) => task.screenshot({ path }),
    close,
  };
}

/** A RunResult as lines for people: each action with its ms, each check, refusals, the answer. */
export function format(result) {
  const t = (s) => (s.timing ? ` (decide ${s.timing.decide}, act ${s.timing.act}, observe ${s.timing.observe})` : "");
  return [
    ...result.steps.map((s) => `  ${String(s.ms).padStart(6)} ms  ${s.operation} ${s.action}${s.text != null ? ` ← "${s.text}"` : ""}${t(s)}`),
    ...result.checks.map((c) => `  ${c.ok ? "ok " : "BAD"} ${c.part}${c.evidence ? `: ${c.evidence}` : ""}`),
    ...result.refusals.map((r) => `  refused step ${r.step} ${r.target ?? "-"}: ${r.reason}`),
    ...(result.answer ? [`  answer: ${result.answer.label ?? result.answer.text}`] : []),
    `${result.verified ? "PASS" : "FAIL"} ${result.status}${result.message ? `: ${result.message}` : ""} · ${(result.totalMs / 1000).toFixed(1)} s · ${result.goal}`,
  ];
}
