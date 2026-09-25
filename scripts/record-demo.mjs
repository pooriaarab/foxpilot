// Records a real-time demo: the task page and the Zipline panel side by side.
// Both windows are captured with CDP screencast (timestamped JPEG frames), then
// stitched with ffmpeg into videos/zipline-demo.mp4. Nothing is sped up.
// Usage: pnpm build && node scripts/record-demo.mjs [flights|maps] [--llm]
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "videos");
const frames = join(out, ".frames");
const TASKS = {
  flights: ["https://www.google.com/travel/flights?hl=en", "Find a one-way ticket from New York to San Francisco on October 9, 2026."],
  maps: ["https://www.google.com/maps?hl=en", "Get directions from Berlin Hauptbahnhof to Brandenburg Gate."],
};
const task = process.argv[2] ?? "flights";
const [url, goal] = TASKS[task];
const useLlm = process.argv.includes("--llm");
const PAGE = { width: 1120, height: 800 };
const PANEL = { width: 520, height: 800 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });

const context = await chromium.launchPersistentContext(join(root, ".e2e-profile"), {
  headless: false,
  viewport: null,
  locale: "en-US",
  colorScheme: "dark",
  args: [
    `--disable-extensions-except=${join(root, "dist")}`,
    `--load-extension=${join(root, "dist")}`,
    `--window-size=${PAGE.width},${PAGE.height + 90}`,
    "--window-position=0,0",
  ],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
const extensionId = new URL(worker.url()).host;
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url, { waitUntil: "domcontentloaded" });
await sleep(2500);
const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true }))[0]?.id);
const panelPromise = context.waitForEvent("page");
await worker.evaluate(
  ([id, tab, w, h, left]) =>
    chrome.windows.create({ url: `chrome-extension://${id}/sidepanel.html?tab=${tab}`, type: "popup", width: w, height: h, left, top: 0 }),
  [extensionId, tabId, PANEL.width, PANEL.height + 60, PAGE.width + 10],
);
const panel = await panelPromise;
// --window-size applies to every window, so size the panel window explicitly.
await worker.evaluate(async ([w, h, left]) => {
  const [win] = (await chrome.windows.getAll({ populate: true })).filter((x) => x.type === "popup");
  if (win?.id !== undefined) await chrome.windows.update(win.id, { width: w, height: h, left, top: 0 });
}, [PANEL.width, PANEL.height + 60, PAGE.width + 10]);
await sleep(300);
console.log("panel viewport:", await panel.evaluate(() => `${innerWidth}x${innerHeight}`), "page viewport:", await page.evaluate(() => `${innerWidth}x${innerHeight}`));
await panel.waitForFunction(() => /Ready|Failed/.test(document.getElementById("gliner-status")?.textContent ?? ""), null, { timeout: 600_000 });
const toggle = panel.locator("#llm-toggle");
if ((await toggle.isChecked()) !== useLlm) await toggle.setChecked(useLlm);
if (useLlm) await panel.waitForFunction(() => /On:/.test(document.getElementById("llm-status")?.textContent ?? ""), null, { timeout: 600_000 });
await panel.locator("#steps").evaluate((el) => el.replaceChildren());
// Larger type for a social-size video.
await panel.evaluate(() => { document.body.style.zoom = "1.1"; });

async function screencast(target, name) {
  const session = await context.newCDPSession(target);
  const list = [];
  let n = 0;
  session.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const file = join(frames, `${name}-${String(n++).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    list.push({ file, t: metadata.timestamp });
    await session.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await session.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });
  return { list, stop: () => session.send("Page.stopScreencast").catch(() => {}) };
}

const pageCast = await screencast(page, "page");
const panelCast = await screencast(panel, "panel");
const t0 = Date.now() / 1000;
await sleep(1200);
await panel.locator("#goal").fill("");
await panel.locator("#goal").pressSequentially(goal, { delay: 12 });
await sleep(500);
await panel.locator("#run").click();
await panel.waitForFunction(() => !document.getElementById("result")?.hidden, null, { timeout: 180_000 });
await sleep(1500);
await page.mouse.wheel(0, 300);
await sleep(2500);
const t1 = Date.now() / 1000;
if (process.env.SHOT) await panel.screenshot({ path: process.env.SHOT });
await pageCast.stop();
await panelCast.stop();
const summary = {
  result: await panel.locator("#result").textContent(),
  steps: (await panel.locator("#steps li").allTextContents()).map((s) => s.replace(/\s+/g, " ").trim()),
};
await context.close();

// Frames arrive only when something repaints; hold each until the next one.
function concatList(list, name) {
  const lines = [];
  const kept = list.filter((f) => f.t >= t0 - 1 && f.t <= t1);
  kept.forEach((f, i) => {
    const next = kept[i + 1]?.t ?? t1;
    const start = i === 0 ? t0 : f.t;
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - start).toFixed(4)}`);
  });
  lines.push(`file '${kept.at(-1).file}'`);
  const path = join(frames, `${name}.txt`);
  writeFileSync(path, lines.join("\n"));
  return path;
}
const pageList = concatList(pageCast.list, "page");
const panelList = concatList(panelCast.list, "panel");
const video = join(out, `zipline-${task}${useLlm ? "-llm" : ""}.mp4`);
execFileSync("ffmpeg", [
  "-nostdin", "-y", "-loglevel", "error",
  "-f", "concat", "-safe", "0", "-i", pageList,
  "-f", "concat", "-safe", "0", "-i", panelList,
  "-filter_complex",
  `[0:v]fps=30,scale=${PAGE.width}:${PAGE.height}:force_original_aspect_ratio=decrease,pad=${PAGE.width}:${PAGE.height}:(ow-iw)/2:(oh-ih)/2:color=0x111314[a];` +
    `[1:v]fps=30,scale=${PANEL.width}:${PAGE.height}:force_original_aspect_ratio=decrease,pad=${PANEL.width}:${PAGE.height}:(ow-iw)/2:0:color=0x111314[b];` +
    `[a][b]hstack=inputs=2,pad=iw+24:ih+24:12:12:color=0x0b0c0d,format=yuv420p[v]`,
  "-map", "[v]", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-movflags", "+faststart", video,
]);
console.log(JSON.stringify(summary, null, 1));
console.log("video:", video);
