// Runs PII Guard end to end in Firefox. It installs dist/pii-guard (a copy
// whose content script also matches 127.0.0.1), opens each fixture composer
// (textarea, contenteditable, ProseMirror-like), types each message in
// fixtures/messages.json, and reads the marked spans from the page. It writes
// artifacts/pii-guard-<ts>.json: per-type precision and recall, per-message
// results, and the model time on the first call (cold), on later calls, and
// on the first call after Firefox unloads the idle event page.
// Usage: pnpm e2e:pii [--headless]. Env: FIREFOX (binary path).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { distOf, FIREFOX, root } from "../../../scripts/lib/firefox.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const messages = JSON.parse(readFileSync(join(here, "fixtures/messages.json"), "utf8"));
const KINDS = ["textarea", "contenteditable", "prosemirror"];
// Firefox unloads an idle event page after this long (default 30 s). Shorter, so the run tests the reload.
const IDLE_MS = 10_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dist = distOf("pii-guard");
for (const [what, path] of [["Firefox", FIREFOX], ["the built app (run node scripts/build.mjs pii-guard)", join(dist, "manifest.json")]]) {
  if (!existsSync(path)) { console.error(`Cannot find ${what} at ${path}.`); process.exit(2); }
}
// The shipped manifest stays as it is; only this copy also runs on the fixture server.
const work = mkdtempSync(join(tmpdir(), "pii-guard-"));
const ext = join(work, "ext");
cpSync(dist, ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
manifest.content_scripts[0].matches.push("http://127.0.0.1/*");
manifest.host_permissions.push("http://127.0.0.1/*");
writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest));

const page = readFileSync(join(here, "fixtures/composer.html"));
const server = createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(page)).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}/composer.html`;

const browser = await puppeteer.launch({
  browser: "firefox", executablePath: FIREFOX, headless: process.argv.includes("--headless"), userDataDir: join(work, "profile"),
  extraPrefsFirefox: { "extensions.background.idle.timeout": IDLE_MS },
});
const layer = () => { const l = document.getElementById("pii-guard-layer"); return l ? { ...l.dataset } : {}; };

/** Types one message into a new composer and waits for the model's marks (or the shape-only fallback). */
async function check(tab, kind, message) {
  const before = Number((await tab.evaluate(layer)).seq ?? 0);
  await tab.click("#reset");
  await tab.click("#composer");
  await tab.keyboard.type(message.text);
  const typed = Date.now();
  for (const deadline = typed + 120_000; Date.now() < deadline; await sleep(50)) {
    const d = await tab.evaluate(layer);
    if (Number(d.seq) > before && Number(d.length) === message.text.length && (d.state === "model" || d.state === "shapes-only")) {
      const spans = JSON.parse(d.spans).map((s) => ({ ...s, text: s.text.replace(/ /g, " ") }));
      return { kind, text: message.text, state: d.state, modelMs: d.state === "model" ? Number(d.modelMs) : null, afterTypingMs: Date.now() - typed, marks: await tab.$$eval(".pii-mark", (m) => m.length), spans, ...score(message, spans) };
    }
  }
  return { kind, text: message.text, state: "timeout", spans: [], ...score(message, []) };
}

/** A span hits an expected value when the types match and the characters overlap. */
function score(message, spans) {
  const expected = message.pii.map(([type, value]) => ({ type, start: message.text.indexOf(value), end: message.text.indexOf(value) + value.length }));
  const hits = (a, b) => a.type === b.type && a.start < b.end && b.start < a.end;
  return {
    found: expected.map((e) => ({ ...e, hit: spans.some((s) => hits(s, e)) })),
    falsePositives: spans.filter((s) => !expected.some((e) => hits(s, e))),
  };
}

const results = [];
const timing = {};
let failure = null;
try {
  await browser.installExtension(ext);
  const tab = await browser.newPage();
  for (const kind of KINDS) {
    await tab.goto(`${base}?kind=${kind}`, { waitUntil: "load" });
    for (const message of messages) {
      const result = await check(tab, kind, message);
      results.push(result);
      console.log(`${result.state.padEnd(11)} ${String(result.modelMs ?? "-").padStart(6)} ms  ${kind.padEnd(15)} ${result.found.filter((f) => !f.hit).length} missed, ${result.falsePositives.length} extra  ${message.text}`);
    }
  }
  timing.coldFirstCallMs = results[0].modelMs;
  const warm = results.slice(1).map((r) => r.modelMs).filter(Number.isFinite).sort((a, b) => a - b);
  timing.warmMedianMs = warm[Math.floor(warm.length / 2)];
  await sleep(IDLE_MS * 2);
  const idle = await check(tab, KINDS.at(-1), messages[0]);
  timing.afterIdleUnloadMs = idle.modelMs;
  timing.idleState = idle.state;
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
}

const types = [...new Set(messages.flatMap((m) => m.pii.map(([t]) => t)))];
const perType = Object.fromEntries(types.map((type) => {
  const tp = results.flatMap((r) => r.found).filter((f) => f.type === type && f.hit).length;
  const fn = results.flatMap((r) => r.found).filter((f) => f.type === type && !f.hit).length;
  const fp = results.flatMap((r) => r.falsePositives).filter((s) => s.type === type).length;
  return [type, { tp, fp, fn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null }];
}));
const cleanMessages = results.filter((r) => !r.found.length);
const record = {
  firefox: await browser.version().catch(() => "unknown"), messages: messages.length, kinds: KINDS, idleTimeoutMs: IDLE_MS, timing, perType,
  cleanMessagesWithMarks: cleanMessages.filter((r) => r.spans.length).length, cleanMessages: cleanMessages.length,
  timeouts: results.filter((r) => r.state === "timeout").length, shapesOnly: results.filter((r) => r.state === "shapes-only").length,
  error: failure, results,
};
await browser.close().catch(() => {});
server.close();
rmSync(work, { recursive: true, force: true });
mkdirSync(join(root, "artifacts"), { recursive: true });
const out = join(root, "artifacts", `pii-guard-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify(record, null, 2));
console.log(JSON.stringify({ timing, perType }, null, 1));
const ok = !failure && record.timeouts === 0;
console.log(`${ok ? "PASS" : "FAIL"} pii-guard${failure ? `: ${failure}` : ""} | ${out}`);
process.exit(ok ? 0 : 1);
