// Runs Consent Shield in a real Firefox over the zoo-sites dialog pages and the
// synthetic CMP pages in fixtures/, and writes artifacts/consent-shield-<ts>.json.
// The add-on refuses each dialog by itself; this runner presses nothing. It
// loads each page, waits until the add-on's log stops changing, and reads the
// log, badge and title. Then it grades the result: zoo-sites' own validator for
// its pages, and the toggles left on for the fixtures. Exit code 0 only when
// every page matches.
// Usage: pnpm e2e:consent [--zoo <zoo-sites checkout>] [--headless]
// Env: FIREFOX (binary path).
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import puppeteer from "puppeteer";
import { distOf, extensionOf, FIREFOX, openExtensionPage, preflight, root } from "../../../scripts/lib/firefox.mjs";
import { grade, inventory, openZoo, resetFor } from "../../../scripts/zoo/zoo.mjs";

const app = "consent-shield";
const args = process.argv.slice(2);
const zooPath = args.includes("--zoo") ? args[args.indexOf("--zoo") + 1] : "/tmp/zoo-src/zoo-sites";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The refuse path each page must take. `never` are labels the log may not hold.
// `done` matches the zoo-sites validator detail at the end. `linger` waits at
// least that long for a late dialog (popup-storm's offer comes at 6 s).
const ZOO = [
  { id: "consent-reject", never: ["Accept all"], done: /saves=[1-9].* stillOn=\[\] acceptAlls=0/ },
  { id: "popup-storm", never: ["Subscribe", "Enable", "Subscribe now"], done: /subscribes=0 not-declined=\[\] clean-session=true/, linger: 8000 },
  { id: "modal-escape", never: ["Subscribe"], done: /methods=button.* removed=false/ },
];
// `last` must be among the presses; with no `last` the add-on must do nothing.
// `off` names the hosts switched off for the page.
const FIXTURES = [
  { page: "onetrust.html", last: "Confirm My Choices", never: ["Accept All Cookies", "Allow All", "Cookie Policy", "Privacy Notice"] },
  { page: "switches.html", last: "Confirm my choices", never: ["Accept all cookies"] },
  { page: "tcf.html", last: "SAVE & EXIT", never: ["AGREE", "ACCEPT ALL"] },
  { page: "banner.html", last: "Reject", never: ["Accept"] },
  { page: "nag.html", last: "No thanks", never: ["Subscribe"] },
  { page: "picker.html", never: ["Cancel", "Done", "October 9", "October 10"] },
  { page: "onetrust.html", host: "localhost", off: ["localhost"], never: ["Cookie Settings", "Accept All Cookies"] },
];
// The add-on is done when the log, badge and zoo grade stay the same this long.
// One step takes up to about 7 s (scan delay, GLiNER2, settle). The first step
// also waits for GLiNER2 to load, up to FIRST_MS. No page may take over PAGE_MS.
const QUIET = 10_000;
const FIRST_MS = 90_000;
const PAGE_MS = 300_000;

const missing = preflight({ app }) ?? (existsSync(join(zooPath, "server.mjs")) ? null : `Cannot find a zoo-sites checkout at ${zooPath} (pass --zoo).`);
if (missing) {
  console.error(missing);
  process.exit(2);
}

const fixtures = join(root, "apps", app, "e2e", "fixtures");
const server = createServer((req, res) => {
  const file = join(fixtures, new URL(req.url, "http://x").pathname.replace(/^\/+/, ""));
  if (!file.startsWith(fixtures) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : "text/html" });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const zoo = await openZoo(zooPath);
const entries = inventory(zoo);

const { uuid, prefs } = extensionOf(app);
const browser = await puppeteer.launch({
  browser: "firefox", executablePath: FIREFOX, headless: args.includes("--headless"),
  args: ["-remote-allow-system-access"], defaultViewport: null, extraPrefsFirefox: prefs,
});
await browser.installExtension(distOf(app));
const ext = await browser.newPage();
await openExtensionPage(ext, `moz-extension://${uuid}/popup.html`);
const page = await browser.newPage();

/** The task tab's store entry (src/store.ts), once it is for the page on screen, and its toolbar badge and title. */
const read = () => ext.evaluate(async () => {
  const tab = (await chrome.tabs.query({})).find((t) => t.url && !/^(?:moz-extension|about):/.test(t.url));
  if (!tab) return null;
  const key = `tab:${tab.id}`;
  const store = (await chrome.storage.session.get(key))[key];
  return { store: store?.url === tab.url ? store : null,
    badge: await chrome.action.getBadgeText({ tabId: tab.id }), title: await chrome.action.getTitle({ tabId: tab.id }) };
});

/** Loads the page and presses nothing. Waits until the add-on stops changing the page, then reads what it did. */
async function watch(url, spec, entry) {
  const begin = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch((e) => console.error("goto:", e.message));
  let now, detail, key, since;
  for (;;) {
    now = await read();
    detail = entry ? (await grade(zoo, entry, { answer: "", fields: null })).detail : null;
    const log = now?.store?.log ?? [];
    const next = JSON.stringify([log.length, now?.store?.stopped, now?.store?.off, now?.badge, detail]);
    if (next !== key) [key, since] = [next, Date.now()];
    const elapsed = Date.now() - begin;
    // A page that must be refused waits for its first step; a page off or left alone only waits QUIET.
    const begun = log.length || now?.store?.off || !(entry || spec.last) || elapsed > FIRST_MS;
    if ((begun && Date.now() - since >= QUIET && elapsed >= (spec.linger ?? 0)) || elapsed > PAGE_MS) break;
    await sleep(500);
  }
  const store = now?.store ?? null;
  const log = store?.log ?? [];
  const done = log.filter((e) => !e.failed);
  const pressed = done.filter((e) => e.kind === "press" || e.kind === "expand").map((e) => e.label);
  // The badge and title as background.ts must set them from this log.
  const count = done.filter((e) => e.kind === "toggle" || e.kind === "press").length;
  const badge = now?.badge ?? "";
  const title = now?.title ?? "";
  const badgeOk = badge === (store?.off ? "off" : store?.stopped ? "!" : count ? String(count) : "");
  const titleOk = store?.stopped ? title === `Consent Shield stopped: ${store.stopped}` : pressed.every((l) => title.includes(`"${l}"`));
  const ok = Boolean(store) && !store.stopped && badgeOk && titleOk && !log.some((e) => spec.never.includes(e.label));
  return { url, ms: Date.now() - begin, ok, pressed, badge, title, badgeOk, titleOk, off: store?.off ?? null, stopped: store?.stopped ?? null, detail, log };
}

const results = [];
for (const spec of ZOO) {
  const entry = entries.find((e) => e.id === spec.id);
  resetFor(zoo, entry);
  const verdict = await watch(entry.url, spec, entry);
  const match = verdict.ok && spec.done.test(verdict.detail);
  results.push({ name: `zoo:${spec.id}`, expected: { never: spec.never, done: String(spec.done) }, match, ...verdict });
}
for (const spec of FIXTURES) {
  await ext.evaluate((off) => chrome.storage.local.set({ off }), spec.off ?? []);
  const verdict = await watch(`http://${spec.host ?? "127.0.0.1"}:${port}/${spec.page}`, spec, null);
  verdict.optionalOn = await page.evaluate(() => [...document.querySelectorAll("[data-optional]")]
    .filter((e) => e.checked || e.getAttribute("aria-checked") === "true").map((e) => e.getAttribute("aria-label") || e.parentElement.innerText.trim()));
  const path = spec.off ? verdict.off && verdict.badge === "off" && !verdict.log.length && verdict.optionalOn.length > 0
    : spec.last ? verdict.pressed.includes(spec.last) && !verdict.optionalOn.length : !verdict.log.length && !/\d/.test(verdict.badge);
  const match = verdict.ok && Boolean(path);
  results.push({ name: `fixture:${spec.page}${spec.off ? " (site off)" : ""}`, expected: { last: spec.last ?? null, never: spec.never }, match, ...verdict });
}

const git = (...a) => { try { return execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim(); } catch { return "unknown"; } };
const artifact = { app, at: new Date().toISOString(), commit: git("rev-parse", "HEAD"), firefox: await browser.version(),
  zooCommit: zoo.commit, matched: results.filter((r) => r.match).length, total: results.length, results };
await browser.close();
await zoo.close();
server.close();
mkdirSync(join(root, "artifacts"), { recursive: true });
const out = join(root, "artifacts", `consent-shield-${artifact.at.replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify(artifact, null, 1));
for (const r of results) {
  console.log(`${r.match ? "MATCH" : "MISS "} ${r.name.padEnd(36)} pressed=[${r.pressed.join(" > ")}] badge=${JSON.stringify(r.badge)}` +
    `${r.stopped ? ` stopped: ${r.stopped}` : ""}${r.badgeOk && r.titleOk ? "" : ` title=${JSON.stringify(r.title)}`} ${Math.round(r.ms / 1000)} s`);
  if (r.detail) console.log(`       ${r.detail}`);
}
console.log(`${artifact.matched}/${artifact.total} pages match their refuse path. ${out}`);
process.exit(artifact.matched === artifact.total ? 0 : 1);
