// Runs Consent Shield in a real Firefox over the zoo-sites dialog pages and the
// synthetic CMP pages in fixtures/, and writes artifacts/consent-shield-<ts>.json.
// The add-on only plans (dry run). On each page this runner reads the plan and
// the badge first, checks that the page saw no press, then presses each planned
// first step itself, as a user would, so the next layer gets its plan. The
// path it walked is then graded: zoo-sites' own validator for its pages, and
// the toggles left on for the fixtures. Exit code 0 only when every page matches.
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

// The refuse path each page must take. `first` is the click the badge must show
// before anything is pressed; `never` are labels no plan may press; `untouched`
// and `done` match the zoo-sites validator detail before and after the walk.
// `linger` waits that long for a late dialog (popup-storm's offer comes at 6 s).
const ZOO = [
  { id: "consent-reject", first: "Manage options", never: ["Accept all"], untouched: /saves=0 .*acceptAlls=0/, done: /saves=[1-9].* stillOn=\[\] acceptAlls=0/ },
  { id: "popup-storm", first: "No thanks", never: ["Subscribe", "Enable", "Subscribe now"], untouched: /^(?!.*dismissed)subscribes=0 not-declined=\[\]/, done: /subscribes=0 not-declined=\[\] clean-session=true/, linger: 8000 },
  { id: "modal-escape", first: "Close", never: ["Subscribe"], untouched: /methods=none removed=false/, done: /methods=button.* removed=false/ },
];
// `last` must be among the presses; `off` names the hosts switched off for the page.
const FIXTURES = [
  { page: "onetrust.html", first: "Cookie Settings", last: "Confirm My Choices", never: ["Accept All Cookies", "Allow All"] },
  { page: "tcf.html", first: "MORE OPTIONS", last: "SAVE & EXIT", never: ["AGREE", "ACCEPT ALL"] },
  { page: "banner.html", first: "Reject", last: "Reject", never: ["Accept"] },
  { page: "nag.html", first: "No thanks", last: "No thanks", never: ["Subscribe"] },
  { page: "picker.html", first: null, never: ["Cancel", "Done", "October 9", "October 10"] },
  { page: "onetrust.html", host: "localhost", off: ["localhost"], first: null, never: ["Cookie Settings", "Accept All Cookies"] },
];

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

/** Waits until the plans differ from `before`, then stay the same for 800 ms. */
async function settled(before, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let seen = null;
  for (;;) {
    const now = await read();
    const key = JSON.stringify(now?.store?.plans ?? []);
    if (seen && key === seen.key && Date.now() - seen.at >= 800) return now;
    if (key !== before && key !== seen?.key) seen = { key, at: Date.now() };
    if (Date.now() > deadline) return now;
    await sleep(200);
  }
}

/** Does one planned step with real input: presses the visible control with that name (the topmost), or scrolls the dialog. */
async function act(step) {
  if (step.kind === "scroll") {
    const { w, h } = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    await page.mouse.move(w / 2, h / 2);
    return page.mouse.wheel({ deltaY: 560 });
  }
  const label = step.label;
  const handle = await page.evaluateHandle((l) => {
    // As snapshot.js names a control: text as written, not as CSS cases it.
    const name = (e) => (e.getAttribute("aria-label") || [...(e.labels ?? [])].map((x) => x.textContent).join(" ") ||
      e.textContent || e.value || "").replace(/\s+/g, " ").trim();
    return [...document.querySelectorAll("button,a[href],input,[role]")].reverse().find((e) => e.checkVisibility() && name(e) === l) ?? null;
  }, label);
  const element = handle.asElement();
  if (!element) throw new Error(`No visible control named "${label}"`);
  // As a person would: bring the row to the middle, clear of a sticky button bar at the dialog's edge.
  await element.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await element.click();
}

async function walk(url, spec) {
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch((e) => console.error("goto:", e.message));
  // The first plan can wait for GLiNER2 to load in the background page.
  let now = await settled("[]", spec.first ? 60_000 : 5000);
  const dryRun = { badge: now?.badge ?? "", title: now?.title ?? "", plans: now?.store?.plans ?? [], off: now?.store?.off ?? false };
  const first = dryRun.plans.at(-1)?.steps[0]?.label ?? null;
  // The badge title must name the same first click.
  const verdict = { url, dryRun, first, titleOk: !first || dryRun.title.includes(`"${first}"`), pressed: [], error: null };
  verdict.untouchedDetail = spec.entry ? (await grade(zoo, spec.entry, { answer: "", fields: null })).detail : null;
  try {
    for (let i = 0; i < 40; i++) {
      const plans = now?.store?.plans ?? [];
      if (!plans.length) {
        if (!spec.linger) break;
        now = await settled("[]", spec.linger);
        if (!now?.store?.plans?.length) break;
        continue;
      }
      const step = plans.at(-1).steps[0];
      const label = step.kind === "scroll" ? "(scroll down)" : step.label;
      await act(step);
      verdict.pressed.push(label);
      const before = JSON.stringify(plans);
      now = await settled(before, 10_000);
      if (JSON.stringify(now?.store?.plans ?? []) === before) throw new Error(`The plan did not move after pressing "${label}"`);
    }
  } catch (error) {
    verdict.error = error.message;
  }
  verdict.log = now?.store?.log ?? [];
  return verdict;
}

const results = [];
for (const spec of ZOO) {
  const entry = entries.find((e) => e.id === spec.id);
  resetFor(zoo, entry);
  const verdict = await walk(entry.url, { ...spec, entry });
  verdict.detail = (await grade(zoo, entry, { answer: "", fields: null })).detail;
  const match = verdict.first === spec.first && verdict.titleOk && spec.untouched.test(verdict.untouchedDetail) && spec.done.test(verdict.detail) &&
    !verdict.pressed.some((l) => spec.never.includes(l)) && !verdict.error;
  results.push({ name: `zoo:${spec.id}`, expected: { first: spec.first, never: spec.never, done: String(spec.done) }, match, ...verdict });
}
for (const spec of FIXTURES) {
  await ext.evaluate((off) => chrome.storage.local.set({ off }), spec.off ?? []);
  const url = `http://${spec.host ?? "127.0.0.1"}:${port}/${spec.page}`;
  const verdict = await walk(url, spec);
  verdict.optionalOn = await page.evaluate(() => [...document.querySelectorAll("[data-optional]")]
    .filter((e) => e.checked || e.getAttribute("aria-checked") === "true").map((e) => e.getAttribute("aria-label") || e.parentElement.innerText.trim()));
  const path = spec.first ? verdict.pressed.includes(spec.last) && !verdict.optionalOn.length : !verdict.pressed.length && !verdict.dryRun.badge.match(/\d/);
  const match = verdict.first === spec.first && verdict.titleOk && path && !verdict.pressed.some((l) => spec.never.includes(l)) && !verdict.error &&
    (!spec.off || (verdict.dryRun.off && verdict.dryRun.badge === "off"));
  results.push({ name: `fixture:${spec.page}${spec.off ? " (site off)" : ""}`, expected: { first: spec.first, last: spec.last ?? null, never: spec.never }, match, ...verdict });
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
  console.log(`${r.match ? "MATCH" : "MISS "} ${r.name.padEnd(36)} first=${JSON.stringify(r.first)} pressed=[${r.pressed.join(" > ")}]${r.error ? ` error: ${r.error}` : ""}`);
  if (r.detail) console.log(`       ${r.detail}`);
}
console.log(`${artifact.matched}/${artifact.total} pages match their refuse path. ${out}`);
process.exit(artifact.matched === artifact.total ? 0 : 1);
