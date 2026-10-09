// Runs PII Guard end to end in Firefox. It installs dist/pii-guard (a copy
// whose content script also matches 127.0.0.1), opens each fixture composer
// (textarea, contenteditable, ProseMirror-like), types each message in
// fixtures/messages.json, and reads the marked spans from the page. It writes
// artifacts/pii-guard-<ts>.json: per-type precision and recall, per-message
// results, and the model time on the first call (cold), on later calls, and
// on the first call after Firefox unloads the idle event page.
// Then it tests the send guard (#123) in each composer: one ok/FAIL line per
// case F1-F10, kept in the artifact as "flow".
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
/** Longer than the guard's model wait (400 ms), so a late prompt or send shows. */
const SETTLE_MS = 1_000;
const CLEAN = messages.find((m) => m.text === "Write a haiku about autumn leaves");
/** Has an email, so the shape rules stop it with or without the model. */
const PII = messages[0];

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
const layer = () => { const l = document.getElementById("pii-guard-layer"); return l ? Object.fromEntries(l.getAttributeNames().filter((n) => n.startsWith("data-")).map((n) => [n.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), l.getAttribute(n)])) : {}; };

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
      return { kind, text: message.text, state: d.state, modelMs: d.state === "model" ? Number(d.modelMs) : null, modelError: d.modelError ?? null, afterTypingMs: Date.now() - typed, marks: await tab.$$eval(".pii-mark", (m) => m.length), spans, ...score(message, spans) };
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

/** True when fn(arg) in the page is true within ms. */
async function until(tab, fn, ms, arg) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await tab.evaluate(fn, arg)) return true;
  return false;
}
const promptOpens = (tab) => until(tab, () => document.getElementById("pii-guard-layer")?.dataset.prompt === "open", 3_000);
const sends = (tab) => until(tab, () => window.sent.length > 0, 3_000);
/** Clicks a prompt button with real input. The prompt is in an open shadow root. */
async function press(tab, action) {
  const button = await tab.$(`pierce/[data-action="${action}"]`);
  return button ? (await button.click(), true) : false;
}
/** A new composer state: no open prompt, no sends, no old decision. */
async function fresh(tab) {
  if ((await tab.evaluate(layer)).prompt === "open") await press(tab, "cancel");
  await tab.evaluate(() => {
    Object.assign(window, { prompts: 0, locked: false });
    window.sent.length = 0;
    document.getElementById("pii-guard-layer")?.removeAttribute("data-decision");
  });
}

/** Runs F1-F10 in one composer kind. Each case starts from a new composer. */
async function sendFlow(tab, kind) {
  const state = async () => ({ ...(await tab.evaluate(layer)), ...(await tab.evaluate(() => ({ sent: [...window.sent], prompts: window.prompts, text: window.composerText() }))) });
  const expect = (id, pass, s, extra = "") => {
    flow.push({ kind, id, pass: Boolean(pass), sent: s.sent, prompts: s.prompts, decision: s.decision ?? null, text: s.text, extra });
    console.log(`${pass ? "ok  " : "FAIL"} ${kind.padEnd(15)} ${id.padEnd(22)} sent=${JSON.stringify(s.sent)} prompts=${s.prompts} decision=${s.decision ?? "-"} ${extra}`);
  };
  const piiHeld = async (how) => {
    await fresh(tab);
    const typed = await check(tab, kind, PII);
    if (how === "click") await tab.click("#send");
    else await tab.keyboard.press("Enter");
    return { typed, opened: await promptOpens(tab) };
  };
  let s;

  await fresh(tab);
  await check(tab, kind, CLEAN);
  await tab.keyboard.press("Enter");
  await sleep(SETTLE_MS);
  s = await state();
  expect("F1 clean, model done", s.sent.length === 1 && s.sent[0] === CLEAN.text && s.prompts === 0, s);

  await fresh(tab);
  await tab.click("#reset");
  await tab.click("#composer");
  await tab.keyboard.type(CLEAN.text);
  await tab.keyboard.press("Enter");
  // Sent before the guard's 400 ms model wait could end.
  const quick = await until(tab, () => window.sent.length > 0, 200);
  await sleep(SETTLE_MS);
  s = await state();
  expect("F2 clean, at once", quick && s.sent.length === 1 && s.sent[0] === CLEAN.text && s.prompts === 0, s);

  // A click right after typing, before the 300 ms detect wait ends, on a new composer.
  await fresh(tab);
  await tab.click("#reset");
  await tab.click("#composer");
  await tab.keyboard.type(PII.text);
  await tab.click("#send");
  const early = await promptOpens(tab);
  s = await state();
  expect("F4 PII, click at once", early && !s.sent.length, s);
  await press(tab, "cancel");

  let { typed, opened } = await piiHeld("enter");
  s = await state();
  expect("F3 PII, Enter held", opened && !s.sent.length, s);
  await press(tab, "redact");
  await sends(tab);
  await sleep(SETTLE_MS);
  s = await state();
  const secrets = [...typed.spans.map((x) => x.text), PII.pii.find(([t]) => t === "email")[1]];
  const leaked = secrets.filter((x) => s.sent.some((t) => t.includes(x)));
  expect("F5 redact", s.sent.length && /\[[A-Z]+_\d+\]/.test(s.sent[0]) && !leaked.length, s, `leaked=${JSON.stringify(leaked)}`);
  expect("F9 one send (redact)", s.sent.length === 1 && s.prompts === 1 && s.decision === "redact", s);

  ({ opened } = await piiHeld("click"));
  s = await state();
  expect("F4 PII, click held", opened && !s.sent.length, s);
  await press(tab, "send");
  await sends(tab);
  await sleep(SETTLE_MS);
  s = await state();
  expect("F6 send anyway", s.sent.length >= 1 && s.sent.every((t) => t === PII.text), s);
  expect("F9 one send (send)", s.sent.length === 1 && s.prompts === 1 && s.decision === "send", s);

  for (const how of ["cancel", "Escape"]) {
    ({ opened } = await piiHeld("enter"));
    if (how === "cancel") await press(tab, "cancel");
    else await tab.keyboard.press("Escape");
    await sleep(SETTLE_MS);
    s = await state();
    expect(`F7 ${how}`, opened && !s.sent.length && s.text === PII.text && s.prompt === "closed" && s.decision === "cancel", s);
  }

  await fresh(tab);
  await check(tab, kind, PII);
  await tab.keyboard.down("Shift");
  await tab.keyboard.press("Enter");
  await tab.keyboard.up("Shift");
  await sleep(SETTLE_MS);
  s = await state();
  expect("F8 Shift+Enter", !s.sent.length && s.prompts === 0, s);

  // The composer undoes the redaction, so the guard must say so and send nothing.
  await fresh(tab);
  await check(tab, kind, PII);
  await tab.evaluate(() => { window.locked = true; });
  await tab.keyboard.press("Enter");
  await promptOpens(tab);
  await press(tab, "redact");
  await until(tab, () => document.getElementById("pii-guard-layer")?.dataset.decision === "redact-failed", 3_000);
  await sleep(SETTLE_MS);
  s = await state();
  expect("F10 redact undone", s.decision === "redact-failed" && s.prompt === "open" && s.prompts === 2 && !s.sent.length && s.text === PII.text, s);
  await fresh(tab);
}

const results = [];
const flow = [];
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
  for (const kind of KINDS) {
    await tab.goto(`${base}?kind=${kind}`, { waitUntil: "load" });
    await sendFlow(tab, kind);
  }
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
  error: failure, results, flow,
};
await browser.close().catch(() => {});
server.close();
rmSync(work, { recursive: true, force: true });
mkdirSync(join(root, "artifacts"), { recursive: true });
const out = join(root, "artifacts", `pii-guard-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify(record, null, 2));
console.log(JSON.stringify({ timing, perType }, null, 1));
const flowFails = flow.filter((f) => !f.pass).map((f) => `${f.kind} ${f.id}`);
console.log(`send guard: ${flow.length - flowFails.length}/${flow.length} ok${flowFails.length ? `; FAIL: ${flowFails.join(", ")}` : ""}`);
const ok = !failure && record.timeouts === 0 && flow.length === KINDS.length * 13 && !flowFails.length;
console.log(`${ok ? "PASS" : "FAIL"} pii-guard${failure ? `: ${failure}` : ""} | ${out}`);
process.exit(ok ? 0 : 1);
