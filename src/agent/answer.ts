// After a run: find the block on the page that answers the goal and outline it.
// Candidates are the page's visible text blocks; GLiNER2 scores each as the
// the answer card vs. questions, links, social posts, ads and page chrome;
// among the ones that look like answers, a second call asks which one the
// goal refers to. Nothing is highlighted below 0.5.
import type { TabBrowser } from "./browser";
import type { Scorer } from "./controller";
import { choose, describe, parseClock, parseDuration, parseMoney, qualifiers, type Row } from "./pick";
import { searchQuery } from "./search";

export type Answer = { text: string; score: number; label?: string };

const MAX_CANDIDATES = 24;

declare global {
  interface Window {
    __ziplineBlocks?: Element[];
  }
}

// The page scripts below are injected by scripting.executeScript, which sends
// only a function's source, so each one uses nothing from module scope.

/** Collects visible text blocks (20–500 chars, the largest that are not a list of pieces) near the top. */
function collect(max: number): { i: number; text: string }[] {
  document.getElementById('zipline-answer')?.remove();
  // A run often ends on exploratory scrolls; the answer is usually near the top.
  scrollTo(0, 0);
  const limit = innerHeight * 2.2;
  const text = (e: Element) => ((e as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim();
  const out: Element[] = [];
  const visit = (e: Element) => {
    if (out.length >= max) return;
    const r = e.getBoundingClientRect();
    if (r.bottom < 0 || r.top > limit || r.width < 40 || r.height < 16) return;
    if (!e.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})) return;
    if (e.closest('nav,header,footer,[role="navigation"],[role="banner"],[role="contentinfo"],form,[role="search"]')) return;
    const t = text(e);
    if (t.length < 20) return;
    // A long block made of two or more substantial pieces (a card and a result)
    // is split; a short one (a single card or result with its lines) is not.
    const pieces = [...e.children].filter(c => text(c).length >= 20).length;
    if (t.length <= 500 && (pieces < 2 || t.length <= 280)) { out.push(e); return; }
    for (const child of e.children) visit(child);
  };
  for (const child of document.body.children) visit(child);
  window.__ziplineBlocks = out;
  return out.map((e, i) => ({ i, text: text(e).slice(0, 300) }));
}

function highlight(index: number, label = "✦ Zipline found this"): boolean {
  const e = window.__ziplineBlocks?.[index];
  if (!e) return false;
  e.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const host = document.createElement('div');
  host.id = 'zipline-answer';
  host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
  const root = host.attachShadow({ mode: 'open' });
  // Built without innerHTML: pages that enforce Trusted Types (Google Flights)
  // reject HTML strings, and a constructed stylesheet is not blocked by CSP.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('.box{position:absolute;border-radius:14px;outline:3px solid #2cc4ad;outline-offset:6px;' +
    'box-shadow:0 0 0 9999px rgba(8,10,12,.28),0 0 42px 8px rgba(44,196,173,.55);transition:all .35s ease;animation:pulse 1.6s ease-in-out 2}' +
    '@keyframes pulse{50%{box-shadow:0 0 0 9999px rgba(8,10,12,.28),0 0 64px 16px rgba(183,227,77,.6)}}' +
    '.chip{position:absolute;transform:translateY(-100%);margin-top:-12px;padding:5px 11px;border-radius:999px;' +
    'background:linear-gradient(135deg,#0f9d8a,#b7e34d);color:#06201c;font:700 13px/1.2 system-ui,-apple-system,sans-serif;' +
    'box-shadow:0 6px 20px rgba(0,0,0,.35);white-space:nowrap}');
  root.adoptedStyleSheets = [sheet];
  for (const name of ['box', 'chip']) { const el = document.createElement('div'); el.className = name; root.append(el); }
  root.querySelector('.chip')!.textContent = label;
  document.body.append(host);
  const place = () => {
    const r = e.getBoundingClientRect();
    const box = root.querySelector<HTMLElement>('.box')!, chip = root.querySelector<HTMLElement>('.chip')!;
    Object.assign(box.style, { left: r.left + scrollX + 'px', top: r.top + scrollY + 'px', width: r.width + 'px', height: r.height + 'px' });
    Object.assign(chip.style, { left: r.left + scrollX + 'px', top: r.top + scrollY + 'px' });
  };
  place();
  addEventListener('resize', place);
  new ResizeObserver(place).observe(e);
  // Dismiss on the first click anywhere.
  addEventListener('pointerdown', () => host.remove(), { once: true });
  return true;
}

/** Candidate scores from the last search, for debugging. */
export let lastScores: { text: string; score: number }[] = [];

/** Rows of a results list: list items with a price, innermost first, top to bottom. */
function collectRows() {
  document.getElementById('zipline-answer')?.remove();
  const text = (e: Element) => ((e as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim();
  const money = /[$€£¥₹]\s?\d|\d\s?(USD|EUR|GBP)\b|\d\s?(US )?dollars\b/i;
  const items = [...document.querySelectorAll('li,[role="listitem"],[role="row"]')];
  const stats = { items: items.length, priced: 0, long: 0, hidden: 0 };
  const rows = items.filter(e => {
    const t = text(e);
    if (t.length < 20 || !money.test(t)) return false;
    // A calendar week or a price grid ("9 $254 10 $244 …") is not a result.
    // As the string version ran it: its template literal dropped both backslashes.
    if ((t.match(/[$€£¥₹]s?d/g) || []).length >= 3) return false;
    stats.priced++;
    // Rows can carry long screen-reader text ("Leaves … at 6:00 AM").
    if (t.length > 2000) { stats.long++; return false; }
    if (!e.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})) { stats.hidden++; return false; }
    return true;
  });
  const inner = rows.filter(r => !rows.some(o => o !== r && r.contains(o))).slice(0, 40);
  window.__ziplineBlocks = inner;
  return { stats, rows: inner.map((e, i) => ({ i, text: text(e).slice(0, 2000) })) };
}

const ROW_TYPES = {
  price: "a price or fare",
  time: "a clock time",
  duration: "a length of time, such as a flight duration",
};

/** For goals with qualifiers ("cheapest morning"): read each result row, then filter and rank in code. */
async function pickRow(browser: TabBrowser, model: Scorer, goal: string): Promise<Answer | null> {
  const q = qualifiers(goal);
  if (!q) return null;
  // Results can still be rendering when the run ends; wait up to 3 s for rows.
  let collected = await browser.evaluate(collectRows);
  for (let tries = 0; tries < 12 && !collected?.rows?.length; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    collected = await browser.evaluate(collectRows);
  }
  const blocks = collected?.rows ?? [];
  if (!blocks.length) {
    const st = collected?.stats;
    lastNote = st
      ? `No result rows found: checked ${st.items} list items, ${st.priced} with a price (${st.long} too long, ${st.hidden} hidden).`
      : "No result rows found.";
    return null;
  }
  const rows: Row[] = [];
  for (const block of blocks) {
    // Most result rows show a time range ("9:00 PM – 12:34 AM") and a price;
    // those are read by pattern. GLiNER2 reads the rest (1.7 s → ~0.3 s on Flights).
    const range = RANGE.exec(block.text);
    const priced = block.text.match(PRICE)?.[0];
    if (range && priced) {
      rows.push({
        i: block.i, text: block.text, price: parseMoney(priced), depart: parseClock(range[1]),
        duration: parseDuration(block.text.match(DURATION)?.[0]), nonstop: NONSTOP.test(block.text),
      });
      continue;
    }
    const found = await model.extractEntities(block.text.slice(0, 500), ROW_TYPES);
    rows.push({
      i: block.i,
      text: block.text,
      // The pattern first: "$139.95 $139 . 95" (Amazon) led GLiNER2 to "$139".
      price: parseMoney(block.text.match(PRICE)?.[0]) ?? parseMoney(found.price?.[0]?.text),
      // Spans come ordered by confidence; the departure is the earliest time in the row.
      depart: parseClock(earliest(found.time)?.text) ?? parseClock(block.text),
      // Durations have a fixed shape ("6 hr 14 min"); GLiNER's span can stop at "6 hr".
      duration: parseDuration(block.text.match(DURATION)?.[0]) ?? parseDuration(found.duration?.[0]?.text),
      nonstop: NONSTOP.test(block.text),
    });
  }
  lastRows = rows;
  const row = await chooseItem(model, rows, q, searchQuery(goal));
  if (!row) {
    lastNote = explain(rows, q);
    return null;
  }
  const label = describe(q, row);
  await browser.evaluate(highlight, row.i, `✦ ${label}`);
  return { text: row.text, score: 1, label };
}

const RANGE = /(\d{1,2}:\d{2}\s?[AP]M)\s*[–—-]\s*\d{1,2}:\d{2}\s?[AP]M/i;
const DURATION = /\d+\s*h(?:r|ours?)?(?:\s*\d+\s*m(?:in)?)?|\d+\s*min\b/i;
const NONSTOP = /\b(nonstop|non-stop|direct)\b/i;
const PRICE = /[$€£¥₹]\s?[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?\s?(?:US dollars|USD|dollars)/i;

/**
 * A goal without preferences on a page of results (three or more rows, each
 * with a price and a time, like flights): the page's own first result is the
 * answer, in the order the site ranked them. Anything else goes to the card
 * search below.
 */
async function topRow(browser: TabBrowser): Promise<Answer | null> {
  const collected = await browser.evaluate(collectRows);
  const rows = (collected?.rows ?? []).filter((r) => parseClock(r.text) !== undefined && PRICE.test(r.text));
  if (rows.length < 3) return null;
  const first = rows[0]!;
  const price = parseMoney(first.text.match(PRICE)?.[0]);
  const label = price !== undefined ? `Top result · $${price}` : "Top result";
  await browser.evaluate(highlight, first.i, `✦ ${label}`);
  return { text: first.text, score: 1, label };
}

const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "one", "new"]);

/**
 * Shopping results mix the item with other brands, accessories and ads. When
 * some rows name every word of the item ("kitchenaid" and "mixer"), only those
 * count, sponsored ones last; then, from the best by the goal's order, GLiNER2
 * checks each candidate is the item and not an accessory for it. Rows that
 * never name the item (flights: "one-way ticket from New York…") skip all this.
 */
async function chooseItem(model: Scorer, rows: Row[], q: NonNullable<ReturnType<typeof qualifiers>>, item: string): Promise<Row | null> {
  const words = (item.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3 && !STOP.has(w));
  const naming = words.length && words.length <= 5
    ? rows.filter((r) => words.every((w) => new RegExp(`\\b${w}`, "i").test(r.text)))
    : [];
  if (!naming.length) return choose(rows, q);
  const organic = naming.filter((r) => !/^\s*sponsored\b/i.test(r.text));
  let pool = organic.length ? organic : naming;
  // Measured on real titles: with "book" and "other" as their own labels, a
  // cookbook scores 0.92 book; with only item vs accessory it scored 1.00 item.
  // Accessories read too much like the item ("…Stand Mixer Pouring Shield
  // Attachment" 0.88 item), so their telltale words are checked in code.
  const labels = {
    item: `the ${item} itself`,
    accessory: "an attachment or spare part",
    book: "a book or cookbook",
    other: "another kind of product",
  };
  const accessory = new RegExp(
    `\\b(attachments?|accessor(?:y|ies)|replacement|spare|cover|case|shield|fits|compatible with)\\b|\\bfor\\s+(?:an?\\s+|the\\s+|your\\s+)?${words[0]}\\b`, "i");
  for (let checks = 0; checks < 6; checks++) {
    const row = choose(pool, q);
    if (!row) return null;
    const title = row.text.replace(/^\s*(sponsored|overall pick|best seller|amazon's choice)\s*/i, "").slice(0, 160);
    pool = pool.filter((r) => r !== row);
    if (accessory.test(title)) continue;
    const verdict = await model.classify(title, "product", labels);
    if ((verdict.item ?? 0) >= 0.5) return row;
  }
  return choose(pool, q);
}

function earliest<T extends { start?: number }>(spans: T[] | undefined): T | undefined {
  return spans?.length ? [...spans].sort((a, b) => (a.start ?? 0) - (b.start ?? 0))[0] : undefined;
}

/** Rows read in the last pick, for debugging. */
export let lastRows: Row[] = [];
/** Why the last pick found nothing, shown in the panel. */
export let lastNote = "";

function explain(rows: Row[], q: NonNullable<ReturnType<typeof qualifiers>>): string {
  if (!rows.length) return "No result rows with a price on this page.";
  const parts = [`${rows.length} result rows read`];
  const withTime = rows.filter((r) => r.depart !== undefined).length;
  if (q.window) parts.push(`${rows.filter((r) => r.depart !== undefined && inWindowOf(r.depart, q.window!)).length} of ${withTime} with a time are in the ${q.windowName}`);
  if (q.nonstop) parts.push(`${rows.filter((r) => r.nonstop).length} nonstop`);
  return `No row matched: ${parts.join(" · ")}.`;
}

function inWindowOf(minutes: number, [start, end]: [number, number]): boolean {
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export async function findAnswer(browser: TabBrowser, model: Scorer, goal: string): Promise<Answer | null> {
  lastNote = "";
  lastScores = [];
  lastRows = [];
  const picked = await pickRow(browser, model, goal);
  if (picked) return picked;
  // A goal with preferences ("cheapest", "red-eye") wants one of the results;
  // some other card on the page is not an answer to it.
  if (qualifiers(goal)) return null;
  const listed = await topRow(browser);
  if (listed) return listed;
  const blocks = await browser.evaluate(collect, MAX_CANDIDATES);
  if (!blocks?.length) return null;
  // Naming what an answer card is, and what the other blocks are, matters: with
  // just "answer vs other", anything about the topic ("People also ask …")
  // scored as the answer. Measured on a real results page: card 1.00, next 0.81.
  const labels = {
    answer: `the answer card: the facts or figures that answer "${goal}" directly on this page`,
    questions: "a list of questions or related searches",
    link: "a search result linking to another site, with a title and snippet",
    social: "a social media post or profile",
    ad: "an ad or sponsored offer",
    other: "navigation, menus or page chrome",
  };
  let best: { i: number; text: string; score: number } | null = null;
  const scored: { text: string; score: number }[] = [];
  const blocksWithScores: { i: number; text: string; score: number }[] = [];
  for (const block of blocks) {
    const probabilities = await model.classify(block.text, "answer", labels);
    const score = probabilities.answer ?? 0;
    scored.push({ text: block.text.slice(0, 80), score });
    blocksWithScores.push({ ...block, score });
    if (!best || score > best.score) best = { ...block, score };
  }
  lastScores = scored;
  if (!best || best.score < 0.5) return null;

  // Round 2: several blocks can all look like "facts and figures" (a price, a
  // chart's stats, related tickers). Ask which one the goal refers to, the way
  // the agent matches a requirement to controls: goal as text, blocks as labels.
  const finalists = blocksWithScores
    .filter((b) => b.score >= Math.min(0.9, best!.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  if (finalists.length > 1) {
    const byLabel = new Map<string, (typeof finalists)[number]>();
    for (const f of finalists) {
      const label = f.text.slice(0, 90);
      if (!byLabel.has(label)) byLabel.set(label, f);
    }
    const probabilities = await model.classify(
      `the answer to: ${goal}`, "answer", Object.fromEntries([...byLabel.keys()].map((l) => [l, undefined])),
    );
    const [label] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
    best = byLabel.get(label) ?? best;
  }
  await browser.evaluate(highlight, best.i);
  return { text: best.text, score: best.score };
}

/** Removes a previous run's highlight. */
export function clear(): void {
  document.getElementById('zipline-answer')?.remove();
}
