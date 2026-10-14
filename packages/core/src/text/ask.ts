// Values the ask dictates, read with plain rules before GLiNER2 sees the goal.
// A quoted literal, a "key: value" list, or a value with a known shape (email,
// phone, card, ZIP, code, "N of X") is typed as written. GLiNER2 still
// extracts the values these rules do not find (places, dates, products).

export type Kind = "quoted" | "list" | "email" | "card" | "phone" | "cvv" | "expiry" | "zip" | "code" | "count";

/** One dictated value: the field it is for (key), the literal, and where it sits in the text. */
export type Dictated = { key: string; value: string; kind: Kind; start: number; end: number };

export type Ask = {
  /** "Open this page — <description>.": context, not a requirement. */
  preamble: string;
  /** The ask without its preamble. */
  text: string;
  /** The text in order: prose, and the items of each "key: value" list. */
  segments: (string | Dictated)[];
  values: Dictated[];
};

// The description may hold a domain ("records view for fernvale-labs.example.net."): a dot before a letter does not end it.
const PREAMBLE = /^(?:open|visit|go to) this page\/?(?:\s+in (?:the|your) browser|\s*[—–-]+\s(?:[^.!?]|[.!?](?=\w))*)?\s*[.!?](?:\s+|$)/i;

const QUOTED = /"([^"\n]{1,80})"|“([^”\n]{1,80})”|(?<![\p{L}\p{N}])'([^'\n]{1,80})'(?![\p{L}\p{N}])/gu;
/** A quoted name of a control to press is not a value: 'Click the "Reveal code" button'. */
const CONTROL_AFTER = /^\s+(?:button|link|tab|icon|menu|checkbox)\b/i;
const CONTROL_BEFORE = /\b(?:click|press|tap|hit|open)\s+(?:on\s+)?(?:the\s+)?$/i;

/** Shapes, in priority order: an earlier shape wins an overlap. Group 1, when present, is the value. */
export const SHAPES: [Kind, RegExp, string][] = [
  ["email", /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "email"],
  ["card", /(?<!\d)\d{4}(?:[ -]?\d{4}){3}(?!\d)/g, "card number"],
  ["phone", /(?<![\d-])(?:\+?1[ .-]?)?(?:\(\d{3}\)\s?|\d{3}[ .-])\d{3}[ .-]\d{4}(?![\d-])/g, "phone"],
  ["cvv", /\b(?:cvv|cvc|security code)\s*:?\s+(\d{3,4})\b/gi, "security code"],
  ["expiry", /\bexp(?:iry|iration)?(?: date)?\s*:?\s+((?:0[1-9]|1[0-2])\/(?:\d{2}|\d{4}))\b/gi, "expiry date"],
  ["zip", /\b(?:zip(?: code)?|postal code|postcode)\s*:?\s+(\d{5}(?:-\d{4})?|[A-Z]\d[A-Z] ?\d[A-Z]\d)\b/gi, "ZIP code"],
  ["code", /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g, "code"],
  ["count", /\b(\d{1,3})\s+(?:x\s+)?of\s+(?:the\s+)?[\p{L}\p{N}][^,.;]*/giu, "quantity"],
];

/** A value the ask rules out ("NOT Form RV-7A", "other than Plan B") is not one to type. */
const RULED_OUT = /\b(?:not|never|avoid|except|excluding|other\s+than|rather\s+than|instead\s+of)\s+(?:[\p{L}\p{N}'-]+\s+){0,2}$/iu;

/** True when the text just before a value rules the value out. */
export function ruledOut(before: string): boolean {
  return RULED_OUT.test(before);
}

/** "Fill it out with: name: Maya, email: …": a key is 1-4 words after a break. */
const KEY = /(?<=^|[,:;.!?]\s*)([A-Za-z][A-Za-z'/-]*(?: [A-Za-z'/-]+){0,3}):\s+/g;

/** The field a value is for, from the words before it ("the access code") or after it ("into the name field"). */
function keyOf(text: string, start: number, end: number, fallback: string): string {
  const before = /\b(?:the|a|an|your|my|this|its)\s+((?:[a-z]+\s+){0,2}[a-z]+)\s*:?\s*$/i.exec(text.slice(Math.max(0, start - 40), start));
  if (before) return before[1]!.toLowerCase();
  const after = /^\s*(?:into|in|as)\s+(?:the|a|your)\s+((?:[a-z]+\s+){0,2}?[a-z]+)\s+(?:field|box|input)\b/i.exec(text.slice(end));
  return after ? after[1]!.toLowerCase() : fallback;
}

/** "key: value" lists of two or more items, with the clause that leads into each ("Fill it out with:"). */
function lists(text: string): { start: number; end: number; items: Dictated[] }[] {
  const keys = [...text.matchAll(KEY)].map((m) => ({ key: m[1]!, start: m.index!, from: m.index! + m[0].length }));
  const found: { start: number; end: number; items: Dictated[] }[] = [];
  let run: Dictated[] = [];
  const close = () => {
    if (run.length >= 2) {
      const lead = /[^.!?;]*:\s*$/.exec(text.slice(0, run[0]!.start));
      found.push({ start: lead ? lead.index : run[0]!.start, end: run[run.length - 1]!.end, items: run });
    }
    run = [];
  };
  keys.forEach((k, i) => {
    const between = text.slice(k.from, keys[i + 1]?.start ?? text.length);
    // An item runs to the comma before the next key; the last one ends at its
    // clause ("…, time: Morning, and give consent.").
    const middle = keys[i + 1] ? /^([^:,;]+),\s*$/.exec(between) : null;
    const value = middle ? middle[1]! : /^[^,;]*?(?=[,;]|\.\s|\.$|$)/.exec(between)![0];
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 60) return close();
    run.push({ key: k.key.toLowerCase(), value: trimmed, kind: "list", start: k.start, end: k.from + value.length });
    if (!middle) close();
  });
  close();
  return found;
}

/** Split the ask into preamble, prose and dictated values. */
export function parseAsk(goal: string): Ask {
  const preamble = PREAMBLE.exec(goal)?.[0] ?? "";
  const text = goal.slice(preamble.length);
  const values: Dictated[] = [];
  const taken: [number, number][] = [];
  const free = (start: number, end: number) => taken.every(([s, e]) => end <= s || start >= e);
  const segments: (string | Dictated)[] = [];
  let at = 0;
  for (const list of lists(text)) {
    segments.push(text.slice(at, list.start), ...list.items);
    values.push(...list.items);
    taken.push([list.start, list.end]);
    at = list.end;
  }
  segments.push(text.slice(at));
  for (const m of text.matchAll(QUOTED)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (!free(start, end) || CONTROL_AFTER.test(text.slice(end)) || CONTROL_BEFORE.test(text.slice(0, start)) ||
        ruledOut(text.slice(0, start))) continue;
    values.push({ key: keyOf(text, start, end, "text"), value: (m[1] ?? m[2] ?? m[3]!).trim(), kind: "quoted", start, end });
    taken.push([start, end]);
  }
  for (const [kind, shape, name] of SHAPES) {
    for (const m of text.matchAll(shape)) {
      const start = m.index! + (m[1] ? m[0].indexOf(m[1]) : 0);
      const value = m[1] ?? m[0];
      if (!free(m.index!, m.index! + m[0].length) || ruledOut(text.slice(0, start))) continue;
      values.push({ key: kind === "code" ? keyOf(text, start, start + value.length, name) : name, value, kind, start, end: start + value.length });
      taken.push([m.index!, m.index! + m[0].length]);
    }
  }
  return { preamble: preamble.trim(), text, segments: segments.filter((s) => typeof s !== "string" || s.trim()), values };
}

/** The name in a span: "Signal Plus Ultra plan" names "Signal Plus Ultra"; the trailing lowercase noun is its kind. */
export function properName(span: string): string {
  const m = /^((?:\p{Lu}[\p{L}\p{N}'&-]*\s+)*\p{Lu}[\p{L}\p{N}'&-]*)(?:\s+\p{Ll}+)+$/u.exec(span);
  return m ? m[1]! : span;
}

/**
 * Write a value in the shape the field shows ("Phone (format: XXX-XXX-XXXX)").
 * A mask is X, 0, 9 or # placeholders with separators; it applies only when it
 * has one place for each letter and digit of a value that holds a digit.
 */
export function reshape(value: string, label: string): string {
  const chars = value.replace(/[^\p{L}\p{N}]/gu, "");
  for (const mask of label.match(/[X09#(][X09#()\-./ ]{3,}[X09#]/g) ?? []) {
    const places = mask.match(/[X09#]/g)!.length;
    if (places !== chars.length || !/\d/.test(chars) || !/[()\-./ ]/.test(mask)) continue;
    let i = 0;
    return mask.replace(/[X09#]/g, () => chars[i++]!);
  }
  return value;
}
