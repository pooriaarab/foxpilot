// After a run: report the values the ask asks for ("report the probe code and
// the relay state"). The report clause becomes slots. Each page of the run is
// read after every action, so a value on an earlier page (before a log out)
// or one that showed for a moment (a flash) is not lost. Per slot, the
// candidates in order: text that changed during the run, newest first;
// label/value pairs that name the slot; the page title or URL; the first
// item of each list for "#1" or "top"; the rest of the page. GLiNER2 takes
// the span; patterns check codes, money and dates.
import { nameInjected, type TabBrowser } from "./browser";
import type { Scorer } from "./controller";
import type { Answer } from "./answer";

export type Slot = {
  /** The slot as the ask says it, without articles: "three documents". */
  phrase: string;
  /** What GLiNER2 looks for: "documents". */
  name: string;
  kind: "title" | "url" | "list" | "code" | "money" | "date" | "text";
  count?: number;
};

type Reading = {
  url: string;
  title: string;
  h1: string;
  changed: { text: string; gone: boolean }[];
  pairs: { label: string; value: string }[];
  lists: { head: string; items: string[]; changed: boolean }[];
  blocks: string[];
  /** All visible text, headers and footers too. */
  text: string;
};

// The verb, not the noun: "and report the sum", never "the five report pages" or "get a quote".
const VERB = /(?:^|[,;—–]\s*|\b(?:and|then|to|please|also)\s+)(?:report(?:\s+back)?|tell\s+me|quote)\b\s*(?:(?:with|on)\s+)?/i;
const LEAD = /^(?:(?:the|a|an|your|its|their|this|that|these|both(?=\s+the\b)|each|exact|exactly|full|current|final|most|recent|latest|new|resulting|same)\s+)+/i;
const CUT = new Set(["that", "which", "who", "where", "it", "you", "they", "we", "he", "she", "there", "as", "shown", "displayed", "listed", "appears", "appeared", "from", "on", "in", "at", "after", "before", "when", "once", "to", "for", "by", "with", "under", "into", "is", "was", "are", "were", "do", "does", "did", "has", "had", "have", "will", "can", "only", "exactly", "including", "excluding", "plus", "printed", "announced"]);
const COUNTS: Record<string, number> = { both: 2, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const VAGUE = /^(?:it|them|this|that|what|what you see|what you find|the result|back)$/i;

/** A report clause that points back: "Report both.", "Report them." */
const BACK = /^(?:both|them|all|these|those|each)(?:\s+of\s+them)?[.!]?$/i;
/** The sentence a back-pointing clause names: "Find the deadline and the URL …". */
const FIND = /^(?:find|get|look\s+up|locate|note|check|read)\s+/i;

/** The report clauses of the ask as slots, once each. Empty when the ask asks for nothing. */
export function reportSlots(ask: string): Slot[] {
  const slots: Slot[] = [];
  const sentences = ask.split(/(?<=[.!?])\s+/);
  for (const [index, sentence] of sentences.entries()) {
    const verb = VERB.exec(sentence);
    if (!verb) continue;
    // "report its hours: the days it is open …" explains the slot after the colon.
    let clause = sentence.slice(verb.index + verb[0].length).replace(/^:\s*/, "").split(/[;:]|,?\s+(?:then|before|after|once|when|if|so that|but)\b/i)[0]!;
    // "Find the deadline and the URL of the page. Report both." reports what the find named.
    const before = sentences[index - 1]?.trim() ?? "";
    if (BACK.test(clause.trim()) && FIND.test(before)) clause = before.replace(FIND, "").replace(/[.!?]+$/, "");
    for (const part of clause.split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)) {
      const words = part.replace(/[.!?:"“”]+$/g, "").replace(/^(?:report|tell\s+me|quote)\s+/i, "").replace(LEAD, "").split(/\s+/).filter(Boolean);
      if (!words.length || (CUT.has(words[0]!.toLowerCase()) && !/^(?:which|who|where)$/i.test(words[0]!))) continue;
      let end = 1;
      // "the code the check was assigned": a second "the" starts a clause, "title of the post" does not.
      while (end < words.length && !CUT.has(words[end]!.toLowerCase()) && !(words[end]!.toLowerCase() === "the" && words[end - 1]!.toLowerCase() !== "of")) end++;
      const phrase = words.slice(0, end).join(" ").replace(/[()[\]]/g, "");
      if (!phrase || VAGUE.test(phrase)) continue;
      const first = phrase.split(" ")[0]!.toLowerCase();
      const count = COUNTS[first] ?? (/^\d+$/.test(first) ? Number(first) : undefined);
      let name = count === undefined ? phrase : phrase.split(" ").slice(1).join(" ");
      // "what is the retention period … Report the period": the ask's fuller name is the slot.
      const fuller = /^[\p{L}-]+$/u.test(name) && new RegExp(`\\b(?:the|a|an|its|your|their)\\s+([\\p{L}-]{3,})\\s+${name}\\b`, "iu").exec(ask)?.[1];
      if (fuller && !CUT.has(fuller.toLowerCase()) && !LEAD.test(`${fuller} `)) name = `${fuller} ${name}`;
      if (!name || slots.some((s) => s.name.toLowerCase() === name.toLowerCase())) continue;
      slots.push({ phrase, name, kind: kindOf(name, count), ...(count === undefined ? {} : { count }) });
    }
  }
  return slots;
}

function kindOf(name: string, count?: number): Slot["kind"] {
  const n = name.toLowerCase();
  if (n === "title" || /\b(?:page|tab|document|window)\s+title\b|\btitle of (?:the|this) (?:page|tab)\b/.test(n)) return "title";
  if (/\burl\b|\bweb address\b/.test(n)) return "url";
  // "sum of the five totals" is one sum: the head noun is before "of".
  const last = n.split(" of ")[0]!.split(" ").pop()!;
  if (/^how (?:many|much)\b/.test(n)) return "text";
  if ((count ?? 1) > 1 || (/s$/.test(last) && !/(?:ss|us|is)$/.test(last) && last.length > 3)) return "list";
  if (/\b(?:code|id|reference|ref|hash|token|key|pin|serial)\b|\b(?:confirmation|order|request|permit|tracking|case|account|ticket) number\b/.test(n)) return "code";
  if (/\b(?:total|price|cost|amount|fee|balance|subtotal|charge|refund|fare|premium)\b/.test(n)) return "money";
  if (/\b(?:date|day|deadline)\b/.test(n)) return "date";
  return "text";
}

const PATTERNS: Partial<Record<Slot["kind"], RegExp>> = {
  // "FLUX-93", "a3f9c2", "48213"; not a year or a clock time.
  code: /\b(?:[A-Z]{2,5}(?:-[A-Z0-9]{2,10})+|(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{5,}|\d{5,})\b/g,
  money: /[$€£¥₹]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|CAD|dollars)\b/gi,
  date: /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}(?:, \d{4})?\b|\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{4}\b/g,
};
const DESCRIPTIONS: Partial<Record<Slot["kind"], string>> = { code: "a code, ID or reference", money: "an amount of money", date: "a date" };
const STOP = new Set(["the", "of", "a", "an", "and", "top", "#1"]);
/** Model calls one report may spend; each is ~0.1-0.5 s. */
const BUDGET = 24;

const stems = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w)).map((w) => w.replace(/s$/, ""));
const overlap = (slot: Slot, text: string) => {
  const have = new Set(stems(text));
  return stems(slot.name).filter((w) => have.has(w)).length;
};

declare global {
  interface Window {
    __foxpilotChanges?: { text: string; batch: number; el: Element }[];
  }
}

// readPage is injected by scripting.executeScript, which sends only its source, so it uses nothing from module scope.

/** Starts recording text changes on this document (once), then reads what a report can come from. */
function readPage(): Reading {
  const visible = (e: Element) => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const skip = 'script,style,noscript,template,svg,[id^="zipline-"]';
  const chromeParts = 'nav,header,footer,[role="navigation"],[role="banner"],[role="contentinfo"]';
  // Text nodes joined with spaces: innerText runs "Probe NE-1" and "relay ok" in sibling spans together.
  const words = (e: Element) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      const t = (n.nodeValue || '').trim();
      if (t && p && !p.closest(skip) && visible(p)) out.push(t);
    }
    return out.join(' ').replace(/\s+/g, ' ');
  };
  if (!window.__foxpilotChanges) {
    const changes: { text: string; batch: number; el: Element }[] = (window.__foxpilotChanges = []);
    let batch = 0;
    const note = (node: Node): boolean => {
      const e = node.nodeType === 1 ? (node as Element) : node.parentElement;
      if (!e || e.closest(skip) || (e.textContent || '').length > 600) return false;
      const text = words(e);
      if (text.length < 2 || text.length > 300) return false;
      changes.push({ text, batch, el: e });
      if (changes.length > 80) changes.shift();
      return true;
    };
    new MutationObserver((records) => {
      batch++;
      for (const r of records) {
        // A removal (a closed dialog, a cleared flash) adds no text.
        if (r.type === 'childList') { if (r.addedNodes.length && !note(r.target)) r.addedNodes.forEach(note); }
        else note(r.target);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'open', 'aria-hidden'] });
  }
  const log = window.__foxpilotChanges;
  const seen = new Set<string>();
  const changed = log.map((c, i) => ({ c, i })).sort((a, b) => b.c.batch - a.c.batch || a.i - b.i)
    .filter(({ c }) => !seen.has(c.text) && !!seen.add(c.text)).slice(0, 12)
    .map(({ c }) => ({ text: c.text, gone: !c.el.isConnected || !visible(c.el) }));

  const pairs: { label: string; value: string }[] = [];
  const pair = (label: string, value: string) => { if (pairs.length < 60 && label && value && label.length <= 60 && value.length <= 160) pairs.push({ label, value }); };
  for (const dt of document.querySelectorAll('dt')) {
    const dd = dt.nextElementSibling;
    if (dd?.tagName === 'DD' && visible(dt)) pair(words(dt), words(dd));
  }
  for (const tr of document.querySelectorAll('tr')) {
    const th = tr.querySelector('th'), td = tr.querySelector('td');
    if (th && td && visible(tr)) pair(words(th), words(td));
  }
  // Up to 400 blocks are read and the 80 nearest the viewport kept, in page
  // order: a link to "#sec-22" scrolled to the asked section, deep in the page.
  const found: { text: string; away: number }[] = [];
  const visit = (e: Element) => {
    if (found.length >= 400 || e.matches(skip) || e.matches(chromeParts) || !visible(e)) return;
    const length = (e.textContent || '').trim().length;
    if (!length) return;
    if (length > 300 && e.children.length) { for (const child of e.children) visit(child); return; }
    const text = words(e);
    if (text.length >= 2) {
      const r = e.getBoundingClientRect();
      found.push({ text: text.slice(0, 300), away: Math.max(0, -r.bottom, r.top - innerHeight) });
    }
    for (const line of ((e as HTMLElement).innerText || '').split('\n')) {
      const m = /^\s*([^:]{2,40}):\s*(\S.{0,159})$/.exec(line);
      if (m) pair(m[1]!.trim(), m[2]!.trim());
    }
  };
  visit(document.body);
  const near = new Set(found.map((b, i) => ({ ...b, i })).sort((a, b) => a.away - b.away || a.i - b.i).slice(0, 80).map((b) => b.i));
  const blocks = found.filter((_, i) => near.has(i)).map((b) => b.text);

  const lists: Reading['lists'] = [];
  for (const l of document.querySelectorAll('ul,ol,[role="list"]')) {
    if (lists.length >= 20) break;
    if (l.closest(chromeParts) || !visible(l)) continue;
    const items = [...l.children].filter((c) => c.matches('li,[role="listitem"]') && visible(c)).map(words)
      .filter((t) => t.length >= 2 && t.length <= 200).slice(0, 12);
    if (items.length < 2) continue;
    // The nearest heading before the list: its own section's, or one level up.
    let head = '';
    for (let p: Element | null = l, depth = 0; p && !head && depth < 4; p = p.parentElement, depth++) {
      for (let s = p.previousElementSibling; s && !head; s = s.previousElementSibling) {
        const h = s.matches('h1,h2,h3,h4,h5,h6') ? s : s.querySelector('h1,h2,h3,h4,h5,h6');
        if (h) head = words(h);
      }
    }
    lists.push({ head, items, changed: log.some((c) => l.contains(c.el) || c.el.contains(l)) });
  }
  const h1 = document.querySelector('h1');
  return { url: location.href, title: document.title, h1: h1 ? words(h1) : '', changed, pairs, lists, blocks, text: words(document.body).slice(0, 20000) };
}

nameInjected({ readPage });

/** Reads each page of a run, and at the end reports one "slot: value" line per slot it found. */
export class Reporter {
  readonly slots: Slot[];
  /** The last reading of each page (URL, title and heading: a log out can keep the URL), oldest first. */
  private readings = new Map<string, Reading>();
  private reading: Promise<void> | null = null;
  private steps = -1;
  private calls = 0;
  /** The text of every reading, by the number of actions taken when it was read. */
  private shown = new Map<number, string>();

  /** The ask's words: among blocks that name a slot equally, the one nearer the ask comes first. */
  private asked: string;

  constructor(private model: Scorer, private browser: TabBrowser, ask: string) {
    this.slots = reportSlots(ask);
    this.asked = ask;
  }

  /** Reads the page once per action. Asks without a report clause cost nothing. */
  seen(steps: number): void {
    if (!this.slots.length || steps === this.steps || this.reading) return;
    this.steps = steps;
    this.reading = this.look();
  }

  private async look(): Promise<void> {
    try {
      const page = await this.browser.evaluate(readPage);
      this.shown.set(this.steps, `${this.shown.get(this.steps) ?? ""}\n${page.text}`);
      const key = `${page.url} ${page.title} ${page.h1}`;
      this.readings.delete(key);
      this.readings.set(key, page);
    } catch {
      // The page navigated or cannot be scripted; the earlier readings stay.
    } finally {
      this.reading = null;
    }
  }

  /**
   * True when the page now shows every slot the ask asks for, each in text that
   * changed during the run, on no reading before action `steps` and not in the
   * ask (a ZIP the ask dictates is not the site's code): the run can end. Only
   * code, money and date slots can be judged this way; for an ask with another
   * kind of slot, or none, it is null.
   */
  async found(steps: number): Promise<boolean | null> {
    if (!this.slots.length || this.slots.some((s) => !PATTERNS[s.kind])) return null;
    await this.reading;
    const before = [...this.shown].filter(([step]) => step < steps).map(([, text]) => text).join("\n");
    this.steps = steps;
    await this.look();
    const page = [...this.readings.values()].pop();
    if (!page) return false;
    this.calls = 0;
    for (const slot of this.slots) {
      let value: string | null = null;
      for (const change of page.changed.filter((c) => !c.gone).slice(0, 6)) {
        value = await this.span(slot, change.text, true);
        if (value && !before.includes(value) && !this.asked.toLowerCase().includes(value.toLowerCase())) break;
        value = null;
      }
      if (!value) return false;
    }
    return true;
  }

  async report(): Promise<Answer | null> {
    if (!this.slots.length) return null;
    await this.reading;
    await this.look();
    const pages = [...this.readings.values()].reverse().slice(0, 4);
    const slots: Record<string, string> = {};
    this.calls = 0;
    for (const slot of this.slots) {
      for (const page of pages) {
        const value = await this.fill(slot, page);
        if (value) { slots[slot.phrase] = value; break; }
      }
    }
    const lines = Object.entries(slots).map(([slot, value]) => `${slot}: ${value}`);
    return lines.length ? { text: lines.join("\n"), score: 1, label: "Reported", slots } : null;
  }

  private async fill(slot: Slot, page: Reading): Promise<string | null> {
    if (slot.kind === "title") return page.title || page.h1 || null;
    if (slot.kind === "url") return page.url;
    if (slot.kind === "list") return this.list(slot, page);
    // Text still shown first: a closed dialog's text is a change too. A flash that went is still a candidate.
    const changes = [...page.changed].sort((a, b) => Number(a.gone) - Number(b.gone));
    for (const change of changes.slice(0, 6)) {
      const value = await this.span(slot, change.text, true);
      if (value) return value;
    }
    const named = page.pairs
      .map((p) => ({ ...p, score: overlap(slot, p.label) }))
      .filter((p) => p.score > 0 && (!PATTERNS[slot.kind] || match(slot, p.value)))
      .sort((a, b) => b.score - a.score)[0];
    if (named) return PATTERNS[slot.kind] ? match(slot, named.value) : named.value;
    if (/#\s*1\b|\bfirst\b|\btop\b|\bnumber one\b/i.test(slot.name)) {
      for (const list of page.lists.slice(0, 4)) {
        const value = await this.span(slot, list.items[0]!, false);
        if (value) return value;
      }
    }
    const context = { ...slot, name: this.asked };
    const ranked = page.blocks.map((text, i) => ({ text, i, score: overlap(slot, text), near: overlap(context, text) }))
      .sort((a, b) => b.score - a.score || b.near - a.near || a.i - b.i).slice(0, 6);
    for (const block of ranked) {
      const value = await this.span(slot, block.text, false);
      if (value) return value;
    }
    return null;
  }

  /** The slot's GLiNER2 span in `text`, snapped to the slot's pattern. A changed text may give the pattern alone. */
  private async span(slot: Slot, text: string, changed: boolean): Promise<string | null> {
    const pattern = PATTERNS[slot.kind];
    if (pattern && !match(slot, text)) return null;
    if (this.calls >= BUDGET) return changed && pattern ? match(slot, text) : null;
    this.calls++;
    const found = await this.model.extractEntities(text.slice(0, 500), { [slot.name]: DESCRIPTIONS[slot.kind] }, changed ? 0.4 : 0.5);
    const best = found[slot.name]?.[0];
    if (!pattern) return best?.text ?? null;
    if (!best) return changed ? match(slot, text) : null;
    // GLiNER2 can stop inside a code ("FLUX" of "FLUX-93"): take the pattern match the span touches.
    const start = best.start ?? text.indexOf(best.text);
    const end = start + best.text.length;
    for (const m of text.matchAll(pattern)) if (m.index < end && start < m.index + m[0].length) return m[0];
    return changed ? match(slot, text) : null;
  }

  private list(slot: Slot, page: Reading): string | null {
    const scored = page.lists.map((l) => ({
      l,
      score: (l.changed ? 2 : 0) + overlap(slot, `${l.head} ${l.items.join(" ")}`) + (slot.count === l.items.length ? 2 : 0),
    })).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
    const best = scored[0]?.l;
    return best ? best.items.slice(0, slot.count ?? best.items.length).join("; ") : null;
  }
}

function match(slot: Slot, text: string): string | null {
  const pattern = PATTERNS[slot.kind];
  return pattern ? (text.match(new RegExp(pattern.source, pattern.flags.replace("g", "")))?.[0] ?? null) : null;
}
