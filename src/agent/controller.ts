// Port of gliner2-ultrafast gliner.py (MIT): requirement extraction and
// scoring against observed browser controls. The controller handles ordering,
// progress, dates and supported operations; the model supplies entity spans
// and control scores. Function names follow the Python so the two read side
// by side; tests/controller.test.ts checks the decisions match it.
import { firstDate, resolveDate, sameDate, type IsoDate } from "./dates";
import type { Action, HistoryEntry, Page } from "./types";
import { isSearchField } from "./search";

export type Labels = Record<string, string | undefined>;

/** What the controller needs from GLiNER2. */
export interface Scorer {
  extractEntities(text: string, types: Labels, threshold?: number): Promise<Record<string, { text: string; start?: number }[]>>;
  classify(text: string, name: string, labels: Labels): Promise<Record<string, number>>;
}

export const FLOOR = 0.5;
export const VALUE_FLOOR = 0.02;
export const SUBMIT_FLOOR = 0.5;
export const CONFIRM_FLOOR = 0.5;
export const CONFIDENT = 0.9;

const RESERVED = /\[(?:P|C|E|R|L|DESCRIPTION|EXAMPLE|OUTPUT)\]|[()[\]]/g;
export const OPERATIONS: Record<string, string> = { click: "CLICK", fill: "TYPE_TEXT", select: "SELECT" };
const NAMES: Record<string, string> = { ...OPERATIONS, key: "PRESS_ENTER" };

export const VALUE_TYPES: Labels = {
  location: "a place, city, country, airport or address",
  date: "a calendar date or day",
  time: "a clock time",
  number: "a count, quantity or amount",
  person: "a person's name",
  organization: "a company, brand or organisation name",
  money: "a price or monetary amount",
  product: "a product, package, library, tool or software name",
  title: "the title of a book, article, page or work",
};

const VERBS =
  "open|click|press|select|choose|go|view|find|search|set|enter|type|add|remove|check|" +
  "uncheck|submit|close|show|read|download|install|book|buy|sort|filter|apply|confirm";
const SPLIT = new RegExp(
  "(?<=\\s)(?=(?:from|to|on|in|at|for|with|by|into|about|between|before|after|during|" +
    `without|under|over|near|then)\\s)|(?<=\\s)(?=and\\s+(?:${VERBS})\\b)|(?<=[.;:])\\s+`,
  "i",
);
const CONFIRM = "confirm and close this dialog";
const SUBMIT = "run the search with the values that were entered";
const KINDS: Record<string, string> = {
  fill: "a text field to type a value into",
  select: "a dropdown value to choose",
  click: "a button or link to press",
};

export type Part = { text: string; values: string[]; date: IsoDate | null };
export type Group = { position: number; actions: Map<string, Action>; open: boolean; takesValue: boolean };
type Scores = Map<string, Record<string, number>>;
type Chosen = { requirement: string | null; score: number; group: Group; rank?: number; commits?: boolean };
export type Memory = Map<string, Record<string, number>>;

export type Decision = {
  choice: string;
  operation: string;
  target: string | null;
  requirement: string | null;
  covered: string[];
  commits: boolean;
  date: IsoDate | null;
  confidence: number;
  probabilities: Record<string, number>;
  rawAnswers: Record<string, Record<string, number>>;
  latencyMs: number;
  usage: { requirements: number; labels: number };
};

/** Strip prompt markers, collapse whitespace, bound length. */
export function clean(value: unknown, limit = 90): string {
  const text = String(value ?? "").replace(RESERVED, " ");
  return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, limit).join("");
}

/** Literal evidence, allowing Unicode accents and punctuation differences. */
export function namesValue(label: string, value: string): boolean {
  const words = (text: string) =>
    (String(text).normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").match(/[\p{L}\p{N}_]+/gu) ?? []).join(" ");
  const needle = words(value);
  return Boolean(needle) && ` ${words(label)} `.includes(` ${needle} `);
}

const wordsOf = (text: string) =>
  String(text).normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").match(/[\p{L}\p{N}_]+/gu) ?? [];

/** Edit distance where swapping two neighbouring letters is one edit ("bagles" → "bagels"). */
function edits(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * Zipline addition: namesValue that forgives typos in the goal. Each word of the
 * value matches a word of the label in order, one edit off for words of 4–6
 * letters and two for longer ones ("marmoor" ≈ "marymoor", "bagles" ≈ "bagels"),
 * with an address allowed in between.
 * Short words and numbers must match exactly.
 */
export function nearlyNames(label: string, value: string): boolean {
  if (namesValue(label, value)) return true;
  const want = wordsOf(value);
  const have = wordsOf(label);
  if (!want.length) return false;
  const close = (a: string, b: string) =>
    a === b || (!/\d/.test(a) && a.length >= 4 && edits(a, b) <= (a.length <= 6 ? 1 : 2));
  // In order, allowing up to 8 skipped words in between: a picked place reads
  // "Blazing Bagels, 6975 176th Ave NE #365, Redmond, WA" for "blazing bagels redmond".
  for (let start = 0; start < have.length; start++) {
    if (!close(want[0]!, have[start]!)) continue;
    let at = start;
    let skipped = 0;
    let ok = true;
    for (const word of want.slice(1)) {
      let next = at + 1;
      while (next < have.length && !close(word, have[next]!)) next++;
      skipped += next - at - 1;
      if (next >= have.length || skipped > 8) { ok = false; break; }
      at = next;
    }
    if (ok) return true;
  }
  return false;
}

/** The name part of a suggestion ("Marymoor Park    West Lake Sammamish Pkwy NE" → "Marymoor Park"). */
const nameOf = (label: string) => label.split(/\s{2,}|\n/)[0]!;

/** Split the goal into requirements and extract literal values with GLiNER. */
export async function requirements(goal: string, model: Scorer, today?: Date): Promise<Part[]> {
  const text = clean(goal, 600);
  const found = await model.extractEntities(text, VALUE_TYPES);
  const values = new Set<string>();
  for (const spans of Object.values(found)) {
    for (const span of spans) if (span.text.length > 1) values.add(span.text.toLowerCase());
  }
  const parts: Part[] = [];
  for (const raw of text.split(SPLIT)) {
    const part = raw.replace(/^[ ,.;:]+|[ ,.;:]+$/g, "");
    if (part.length < 2) continue;
    const lowered = part.toLowerCase();
    let inPart = [...values].filter((v) => lowered.includes(v)).sort();
    // Zipline addition: "to Blazing Bagles Redmond" is one place; GLiNER2 kept
    // only "bagles redmond". A short "to/from/at/near …" part keeps its whole object.
    const object = /^(?:from|to|at|near)\s+(.+)$/i.exec(part)?.[1]?.replace(/[.,;:!?]+$/, "").toLowerCase();
    if (object && inPart.length === 1 && object !== inPart[0] && object.includes(inPart[0]!) &&
        object.split(/\s+/).length <= 5 && !firstDate(object, today)) inPart = [object];
    parts.push({ text: part, values: inPart, date: resolveDate(part, today) });
  }
  return parts.length ? parts : [{ text, values: [...values].sort(), date: resolveDate(text, today) }];
}

/** Check execution history and current field values for an already-served control. */
export function satisfied(action: Action, history: HistoryEntry[]): boolean {
  let seen = 0;
  for (const entry of history) {
    const sameNode =
      action.node != null && action.document_id != null &&
      entry.node === action.node && entry.document_id === action.document_id;
    if ((!sameNode && entry.action !== action.label) || entry.kind !== action.kind) continue;
    if (action.kind !== "fill") return true;
    seen += 1;
    if (entry.text && action.value) return true;
    if (seen >= 2) return true;
  }
  return false;
}

const OPTION_ROLES = new Set(["option", "menuitemradio", "menuitemcheckbox", "radio", "tab"]);

/**
 * Zipline addition: controls that change the user's account or spend money are
 * never chosen (they stay in the label set, so scores match the Python controller). A run once clicked "Track prices…" and left a tracked flight
 * behind; a browsing agent should not sign in, subscribe, buy or delete.
 */
const UNSAFE = /\b(track prices?|sign (in|out|up)|log ?(in|out)|subscribe|unsubscribe|delete|remove account|buy now|purchase|pay now|place order|checkout|book now|book with|reserve now|continue to book(ing)?)\b/i;

export function isUnsafe(action: Action): boolean {
  return UNSAFE.test(action.label);
}

/**
 * Zipline addition: a bare "Search" or "Submit" button sends the form; it is
 * not what a part of the goal refers to. On Google Flights, "Search" (0.66)
 * served "Find a one-way ticket" and sent a round trip with no return date.
 */
const SENDS = /^(search|submit|go|send|find)$/i;

export function sends(action: Action): boolean {
  return action.kind === "click" && !action.dialog && SENDS.test(clean(action.label));
}

/**
 * Zipline addition: a menu opener ("Change ticket type. Round trip") only shows
 * options; the option itself still has to clear the floor. When the opener is a
 * part's top answer it needs less: one run scored it 0.49 and never opened it.
 */
const MENU_FLOOR = 0.4;

function opensMenu(action: Action): boolean {
  if (action.kind !== "click") return false;
  const popup = String(action.haspopup ?? "").toLowerCase();
  return action.role === "combobox" || (popup !== "" && popup !== "false") || action.expanded != null;
}

/**
 * Zipline addition: a clicked control stays closed for the rest of the run,
 * but a send button whose form was edited after the click has something new
 * to send (the ticket type changed after the first "Search").
 */
function editedSince(action: Action, history: HistoryEntry[]): boolean {
  if (action.form == null) return false;
  let clicked = -1;
  history.forEach((entry, index) => {
    const sameNode = action.node != null && entry.node === action.node && entry.document_id === action.document_id;
    if (entry.kind === "click" && (sameNode || entry.action === action.label)) clicked = index;
  });
  if (clicked < 0) return false;
  return history.slice(clicked + 1).some((entry) => entry.form === action.form && (entry.kind === "fill" || entry.kind === "click"));
}

/** Group supported actions by observed node, preserving document order. */
export function groups(state: Page, history: HistoryEntry[], refused: Set<string>): Map<string, Group> {
  const ordered = new Map<string, Group>();
  state.actions.forEach((action, position) => {
    if (!(action.kind in OPERATIONS)) return;
    const label = clean(action.label);
    if (!label) return;
    const key = JSON.stringify([action.node, action.kind === "select" ? action.value : null]);
    let group = ordered.get(key);
    if (!group) {
      group = { position, actions: new Map(), open: false, takesValue: false };
      ordered.set(key, group);
    }
    if (!group.actions.has(label)) group.actions.set(label, action);
  });
  for (const group of ordered.values()) {
    const action = execute(group);
    group.open = !satisfied(action, history) && !refused.has(action.label) && !action.self_link;
    group.takesValue = action.kind === "fill" || action.kind === "select";
  }
  return ordered;
}

/** Typing beats clicking into the same field; otherwise there is one action. */
export function execute(group: Group): Action {
  const actions = [...group.actions.values()];
  return actions.find((a) => a.kind === "fill") ?? actions[0]!;
}

/** Return the score of the action that would execute for this group. */
function rate(group: Group, probabilities: Record<string, number> | undefined): number {
  return probabilities?.[clean(execute(group).label)] ?? 0;
}

/** Labels for one scoring pass, plus the negatives that keep it honest. */
function schemaFor(ordered: Map<string, Group>, history: HistoryEntry[], valueTakers: boolean): Labels | null {
  const labels: Labels = {};
  for (const group of ordered.values()) {
    const action = execute(group);
    if (valueTakers && (action.kind === "click" || !group.open)) continue;
    labels[clean(action.label)] = KINDS[action.kind];
  }
  for (const entry of history) {
    if (!valueTakers && entry.kind in OPERATIONS) {
      const label = clean(entry.action);
      if (!(label in labels)) labels[label] = KINDS[entry.kind];
    }
  }
  delete labels[""];
  return Object.keys(labels).length ? labels : null;
}

/**
 * Zipline addition: while the goal still has values for the page's search form,
 * clicks outside that form are shortcuts (tracked prices, recent searches,
 * "explore" cards) that run some other search. One account's "One way trip from
 * New York to Denver" cards took the weight that "Change ticket type" gets on a
 * clean page (0.17 instead of 0.87). They stay in the label set (removing
 * negatives made the model less sure, 0.87 to 0.47), but when one comes out on
 * top, the scores are renormalized over the rest: the best control given that
 * it belongs to the form. Dialogs, menus and autocomplete options count as the form.
 */
function shortcuts(ordered: Map<string, Group>, parts: Part[]): Set<string> {
  const found = new Set<string>();
  if (!parts.some((p) => p.values.length)) return found;
  const fields = new Map<unknown, number>();
  for (const group of ordered.values()) {
    const action = execute(group);
    if (group.takesValue && action.form != null) fields.set(action.form, (fields.get(action.form) ?? 0) + 1);
  }
  if (![...fields.values()].some((n) => n >= 2)) return found;
  for (const group of ordered.values()) {
    const action = execute(group);
    if (action.kind === "click" && action.form == null && !action.dialog && action.suggestion_for == null) found.add(clean(action.label));
  }
  return found;
}

function withinForm(scores: Scores, outside: Set<string>): void {
  if (!outside.size) return;
  for (const [text, probabilities] of scores) {
    const [label] = top(probabilities);
    if (!outside.has(label)) continue;
    const kept = Object.entries(probabilities).filter(([l]) => !outside.has(l));
    const total = kept.reduce((sum, [, p]) => sum + p, 0);
    if (total > 0) scores.set(text, Object.fromEntries(kept.map(([l, p]) => [l, p / total])));
  }
}

/** Score requirements against observed controls, narrowing uncertain value matches to inputs. */
async function match(
  model: Scorer, state: Page, history: HistoryEntry[], refused: Set<string>, memory: Memory, parts: Part[],
): Promise<{ ordered: Map<string, Group>; results: Scores; latency: number }> {
  const ordered = groups(state, history, refused);
  const results: Scores = new Map();
  let latency = 0;
  const texts = parts.map((p) => p.text);
  let [scored, spent] = await passOver(model, ordered, history, texts, false, memory);
  for (const [k, v] of scored) results.set(k, v);
  latency += spent;
  const unsure: string[] = [];
  for (const part of parts) {
    if (!part.values.length) continue;
    const available = [...ordered.values()].filter((g) => g.open);
    const scores = results.get(part.text) ?? {};
    const named = available.some(
      (g) =>
        execute(g).kind !== "fill" && rate(g, scores) >= CONFIDENT &&
        part.values.every((value) => namesValue(execute(g).label, value)),
    );
    if (!named && available.some((g) => g.takesValue)) unsure.push(part.text);
  }
  if (unsure.length) {
    [scored, spent] = await passOver(model, ordered, history, unsure, true, memory);
    for (const [k, v] of scored) results.set(k, v);
    latency += spent;
  }
  withinForm(results, shortcuts(ordered, parts));
  return { ordered, results, latency };
}

/** One scoring pass per requirement, or none at all if every answer is remembered. */
async function passOver(
  model: Scorer, ordered: Map<string, Group>, history: HistoryEntry[], texts: string[],
  valueTakers: boolean, memory: Memory,
): Promise<[Scores, number]> {
  const labels = schemaFor(ordered, history, valueTakers);
  if (!labels || !texts.length) return [new Map(), 0];
  // Softmax scores are reusable only for an identical full label schema.
  const signature = JSON.stringify(Object.entries(labels));
  const key = (text: string) => JSON.stringify([text, signature, valueTakers]);
  let latency = 0;
  const fresh = texts.filter((text) => !memory.has(key(text)));
  if (fresh.length) {
    const started = performance.now();
    for (const text of fresh) memory.set(key(text), await model.classify(text, "referenced", labels));
    latency = Math.round(performance.now() - started);
  }
  return [new Map(texts.map((text) => [text, memory.get(key(text))!])), latency];
}

/** Assign requirements to available controls, respecting modal scope and explicit dates. */
function best(ordered: Map<string, Group>, scores: Scores, parts: Part[]): Chosen[] {
  const valued = new Set(parts.filter((p) => p.values.length).map((p) => p.text));
  const valuesOf = new Map(parts.map((p) => [p.text, p.values]));
  const dates = parts.filter((p) => p.date).map((p) => [p.text, p.date!] as const);
  const datedTexts = new Set(dates.map(([text]) => text));
  const anyOpen = [...ordered.values()].some((g) => g.open);
  const texts = anyOpen ? [...scores.keys()] : [];
  let openGroups = [...ordered.values()].filter((g) => g.open);
  const inside = openGroups.filter((g) => execute(g).dialog);
  if (inside.length) openGroups = inside;

  // Parse explicit calendar labels rather than comparing near-identical dates semantically.
  for (const [text, wanted] of dates) {
    for (const group of openGroups) {
      if ([...group.actions.keys()].some((label) => sameDate(label, wanted))) {
        return [{ requirement: text, score: 1.0, group }];
      }
    }
  }
  const offers: [Group, Map<number, number>][] = [];
  for (const group of openGroups) {
    if (isUnsafe(execute(group)) || sends(execute(group))) continue;
    const column = new Map<number, number>();
    texts.forEach((text, index) => {
      const score = rate(group, scores.get(text));
      if (!score) return;
      if (!valued.has(text) && score >= MENU_FLOOR && opensMenu(execute(group)) && score === top(scores.get(text)!)[1]) {
        column.set(index, score);
        return;
      }
      // Zipline addition: a value that is not a date does not go into a date field
      // ("from New York" scored 0.88 for "Departure" on one Google Flights layout).
      if (group.takesValue && valued.has(text) && !datedTexts.has(text) && isDateField(execute(group))) return;
      // Zipline addition: a dropdown can only be set to one of its options, so an
      // option serves a value only if it names it ("Sort by: → Price: High to Low"
      // scored 0.29 for "kitchenaid hand mixer" on Amazon).
      if (execute(group).kind === "select" && valued.has(text) &&
          !(valuesOf.get(text) ?? []).every((value) => namesValue(execute(group).label, value))) return;
      if (score >= (valued.has(text) && group.takesValue ? VALUE_FLOOR : FLOOR)) column.set(index, score);
    });
    if (column.size) offers.push([group, column]);
  }
  const taken = assign(offers, texts.length);
  const order = new Map(texts.map((text, index) => [text, index]));
  const chosen: Chosen[] = taken.map(([group, index, score]) => ({
    requirement: texts[index]!, score, group, rank: order.get(texts[index]!)!,
  }));
  return chosen.sort((a, b) => a.rank! - b.rank! || a.group.position - b.group.position);
}

/** Find a one-to-one assignment, prioritizing earlier requirements before total score. */
function assign(offers: [Group, Map<number, number>][], count: number): [Group, number, number][] {
  type Cell = [number, [Group, number, number][]];
  let table = new Map<number, Cell>([[0, [0.0, []]]]);
  for (const [group, column] of offers) {
    const next = new Map(table);
    for (const [mask, [total, picked]] of table) {
      for (const [index, score] of column) {
        const bit = 1 << index;
        if (mask & bit) continue;
        const key = mask | bit;
        const candidate: Cell = [total + score, [...picked, [group, index, score]]];
        const existing = next.get(key);
        if (!existing || existing[0] < candidate[0]) next.set(key, candidate);
      }
    }
    table = next;
    if (table.size > 1 << Math.min(count, 14)) break;
  }
  // Earlier requirements take precedence when controls are limited.
  let bestEntry: [number, Cell] | null = null;
  for (const entry of table) {
    if (!bestEntry || comparePriority(entry, bestEntry, count) > 0) bestEntry = entry;
  }
  return bestEntry![1][1];
}

/** Python compares (coverage tuple, score); max() keeps the first of equals. */
function comparePriority(a: [number, [number, unknown]], b: [number, [number, unknown]], count: number): number {
  for (let index = 0; index < count; index++) {
    const ca = Boolean(a[0] & (1 << index));
    const cb = Boolean(b[0] & (1 << index));
    if (ca !== cb) return ca ? 1 : -1;
  }
  return a[1][0] === b[1][0] ? 0 : a[1][0] > b[1][0] ? 1 : -1;
}

function top(probabilities: Record<string, number>): [string, number] {
  let label = "";
  let score = -1;
  for (const [key, value] of Object.entries(probabilities)) {
    if (value > score) [label, score] = [key, value];
  }
  return [label, score];
}

const asLabels = (names: Iterable<string>): Labels => Object.fromEntries([...names].map((n) => [n, undefined]));

/** Select a pending dialog action or score its available confirmation controls. */
async function dialog(model: Scorer, ordered: Map<string, Group>, chosen: Chosen[], history: HistoryEntry[]): Promise<Chosen[] | null> {
  const inside = new Map<string, Group>();
  for (const group of ordered.values()) {
    if (execute(group).dialog) inside.set(clean(execute(group).label), group);
  }
  if (!inside.size) return null;
  const wanted = chosen.filter((c) => execute(c.group).dialog);
  if (wanted.length) return wanted;
  // Zipline addition: confirming a dialog means a button, not one of a menu's
  // options (it picked 'Round trip' in an open ticket-type menu).
  const openable = new Map(
    [...inside].filter(([label, group]) => group.open && !firstDate(label) && !OPTION_ROLES.has(execute(group).role ?? "") && !isUnsafe(execute(group))),
  );
  if (!openable.size) return null;
  // Zipline addition: a popup that appeared while typing is an autocomplete,
  // not a dialog to confirm ("Ask Alexa about this" in Amazon's search box).
  if (history[history.length - 1]?.kind === "fill") return null;
  const [value, confidence] = top(await model.classify(CONFIRM, "confirm", asLabels(openable.keys())));
  if (confidence < CONFIRM_FLOOR) return null;
  return [{ requirement: null, score: confidence, group: openable.get(value)! }];
}

/** What a fill belongs to: its form, or itself when it has none. */
function sentKey(entry: { form?: unknown; action?: string; label?: string; node?: number | null }): string {
  // Zipline addition: a field outside a form is keyed by its node when known.
  // Google Maps renames the field once typed into ("Choose destination…" →
  // "Destination Blazing Bagels Redmond"), which lost track of it by label.
  return JSON.stringify(entry.form != null ? entry.form : ["field", entry.node ?? entry.action ?? entry.label]);
}

/**
 * Forms (or lone fields) holding values that were typed but not sent yet.
 * Zipline addition: order matters. A field filled after its form was sent
 * makes the form unsent again (Python treats a form as sent once, forever).
 */
export function unsentForms(state: Page, history: HistoryEntry[]): Set<string> {
  const filledAt = new Map<string, number>();
  const sentAt = new Map<string, number>();
  history.forEach((e, index) => {
    const sending = e.submit || (e.kind === "click" && e.form != null && SENDS.test(clean(e.action)));
    // Choosing a setting in the form (ticket type) changes what a search would send.
    if (e.kind === "fill" || (e.kind === "click" && e.form != null && !sending)) filledAt.set(sentKey(e), index);
    // A click on the form's Search button sends it too, on pages without a real <form>.
    if (sending) sentAt.set(sentKey(e), index);
    // Taking a suggestion, or Enter outside a form, sends the field typed into last.
    if (e.committed_field || (e.kind === "key" && e.submit && e.form == null)) {
      const typed = history.slice(0, index).reverse().find((f) => f.kind === "fill" && (!e.committed_field || f.action === e.committed_field));
      sentAt.set(typed ? sentKey(typed) : JSON.stringify(["field", e.committed_field]), index);
    }
  });
  const holding = new Set(
    state.actions.filter((a) => a.kind === "fill" && a.value).map((a) => sentKey({ form: a.form, action: a.label, node: a.node })),
  );
  const pending = new Set(
    [...filledAt].filter(([k, at]) => at > (sentAt.get(k) ?? -1) && holding.has(k)).map(([k]) => k),
  );
  return pending;
}

/** Find a submission action for a populated, uncommitted form. */
async function unsentForm(
  model: Scorer, state: Page, ordered: Map<string, Group>, history: HistoryEntry[], chosen: Chosen[],
): Promise<Chosen | null> {
  const pending = unsentForms(state, history);
  if (!pending.size) return null;
  const inPending = (form: unknown) => form != null && pending.has(JSON.stringify(form));
  for (const group of ordered.values()) {
    const action = execute(group);
    if (group.open && action.submit && inPending(action.form)) return { requirement: null, score: 1.0, group };
  }
  if (chosen.length) return null;
  const buttons = new Map<string, Group>();
  for (const group of ordered.values()) {
    const action = execute(group);
    const usable = group.open || (sends(action) && editedSince(action, history));
    if (usable && action.kind === "click" && inPending(action.form) && !isUnsafe(action)) buttons.set(clean(action.label), group);
  }
  if (!buttons.size) return enter(state);
  const [value, confidence] = top(await model.classify(SUBMIT, "submit", asLabels(buttons.keys())));
  if (confidence >= SUBMIT_FLOOR) return { requirement: null, score: confidence, group: buttons.get(value)! };
  return enter(state);
}

/** The last resort for sending a field: the key the user would press. */
function enter(state: Page): Chosen | null {
  const key = control(state, "press_enter");
  return key == null
    ? null
    : { requirement: null, score: 1.0, group: { position: -1, actions: new Map([[key.label, key]]), open: true, takesValue: false } };
}

/** Rank observed autocomplete suggestions for the most recently entered value. */
async function suggestion(model: Scorer, ordered: Map<string, Group>, history: HistoryEntry[]): Promise<Chosen | null> {
  const last = history[history.length - 1];
  if (!last || last.kind !== "fill" || !last.text) return null;
  let options = new Map<string, Group>();
  for (const group of ordered.values()) {
    const action = execute(group);
    const associated = action.suggestion_for != null && action.suggestion_for === last.node;
    if (group.open && (associated || action.role === "option")) options.set(clean(action.label), group);
  }
  if (!options.size) return null;
  const typed = clean(last.text, 60);
  const exact = new Map([...options].filter(([label]) => nearlyNames(label, typed)));
  if (exact.size) {
    // Zipline addition: of the suggestions that name what was typed, the one
    // whose own name adds the least ("Marymoor Park" over "Marymoor Park Playground").
    // The raw label: cleaning collapses the double space between name and address.
    const extra = (group: Group) => wordsOf(nameOf(execute(group).label)).length - wordsOf(typed).length;
    const least = Math.min(...[...exact.values()].map(extra));
    const closest = [...exact].filter(([, group]) => extra(group) === least);
    options = exact;
    if (closest.length === 1) {
      // Scored like the Python controller, so the confidence matches it when the pick does.
      const scored = await model.classify(typed, "suggestion", asLabels(options.keys()));
      return { requirement: null, score: scored[closest[0]![0]] ?? 0, group: closest[0]![1], commits: true };
    }
    options = new Map(closest);
  }
  // Zipline addition: in a search box the typed query is the point; a
  // suggestion that does not contain it ("crunchbase" for a mixer) is not
  // taken, and the query is sent as typed.
  else {
    const field = ordered.get(JSON.stringify([last.node ?? null, null]));
    if (isSearchField({ label: last.action, role: field ? execute(field).role : undefined })) return null;
  }
  const [picked, confidence] = top(await model.classify(typed, "suggestion", asLabels(options.keys())));
  return { requirement: null, score: confidence, group: options.get(picked)!, commits: true };
}

/**
 * Zipline addition (not in the Python controller): a short goal that names no
 * value ("snowflake stock price") matches no control above the 0.5 floor, so
 * nothing is chosen and the run ends. When the page has an open search box and
 * nothing has been typed yet, the goal goes into it as a query.
 */
function searchFallback(ordered: Map<string, Group>, history: HistoryEntry[], parts: Part[]): Chosen | null {
  if (parts.length === 0 || parts.length > 2 || history.some((h) => h.kind === "fill")) return null;
  for (const group of ordered.values()) {
    const action = execute(group);
    if (group.open && action.kind === "fill" && isSearchField({ label: action.label, role: action.role })) {
      return { requirement: parts[parts.length - 1]!.text, score: 1.0, group };
    }
  }
  return null;
}

/** A field that takes a date, judged by its label ("Departure", "Return", "Check-in", "Date"). */
export function isDateField(action: Action): boolean {
  return /\b(date|dates|depart(ure|ing)?|return(ing)?|check[- ]?in|check[- ]?out|arriv(al|e|ing)|when|dd\/mm|mm\/dd)\b/i.test(action.label);
}

function control(state: Page, name: string): Action | undefined {
  return state.actions.find((a) => a.id === name);
}

/** How many steps in a row have read the page without changing it. */
function idle(history: HistoryEntry[]): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.kind !== "wait" && history[i]!.kind !== "scroll") break;
    count += 1;
  }
  return count;
}

/** One observation, one decision. */
export async function choose(
  model: Scorer, state: Page, history: HistoryEntry[], memory: Memory, refused: Set<string>,
  allParts: Part[], served: Set<string>,
): Promise<Decision> {
  const parts = allParts.filter((p) => !served.has(p.text));
  // Zipline addition: dates are resolved and matched in code. When an open
  // picker already shows the wanted day, scoring every part against 50 day
  // labels only to ignore the scores cost 1.3–3 s per step on Google Flights.
  const picked = parts.some((p) => p.date) ? best(groups(state, history, refused), new Map(), parts) : [];
  const { ordered, results: scores, latency } = picked.length
    ? { ordered: groups(state, history, refused), results: new Map() as Scores, latency: 0 }
    : await match(model, state, history, refused, memory, parts);
  let chosen = best(ordered, scores, parts);
  const sending = await unsentForm(model, state, ordered, history, chosen);
  if (sending) chosen = [sending, ...chosen];
  const committing = picked.length ? null : await suggestion(model, ordered, history);
  chosen = committing ? [committing] : ((await dialog(model, ordered, chosen, history)) ?? chosen);
  const commits = Boolean(committing);
  if (!chosen.length) {
    const searching = searchFallback(ordered, history, parts);
    if (searching) chosen = [searching];
  }

  let choice: string, operation: string, confidence: number, requirement: string | null, covered: string[];
  if (chosen.length) {
    const action = execute(chosen[0]!.group);
    choice = action.id;
    operation = NAMES[action.kind]!;
    confidence = chosen[0]!.score;
    requirement = chosen[0]!.requirement;
    covered = requirement != null ? [requirement] : [];
    const last = history[history.length - 1];
    if (commits && last?.requirement && nearlyNames(action.label, last.text ?? "")) covered = [last.requirement];
    if (action.kind === "fill") {
      const holding = new Set(parts.filter((p) => p.values.length).map((p) => p.text));
      covered = covered.filter((text) => !holding.has(text));
    } else {
      const unproven = new Set(
        parts
          .filter((p) => p.values.length && !p.values.every((value) => nearlyNames(action.label, value)))
          .map((p) => p.text),
      );
      covered = covered.filter((text) => !unproven.has(text));
    }
  } else {
    requirement = null;
    covered = [];
    // Termination is heuristic; callers must verify the actual outcome.
    const waited = idle(history);
    const wait = history.length && waited < 2 ? control(state, "wait") : undefined;
    const scroll = waited < 4 ? control(state, "scroll_down") : undefined;
    if (wait) [choice, operation, confidence] = [wait.id, "WAIT", 1.0];
    else if (scroll) [choice, operation, confidence] = [scroll.id, "SCROLL_DOWN", 1.0];
    else {
      const acted = history.some((entry) => entry.kind in OPERATIONS);
      choice = operation = acted ? "DONE" : "BLOCKED";
      confidence = 1.0;
    }
  }
  const probabilities: Record<string, number> = {};
  for (const group of ordered.values()) {
    probabilities[execute(group).id] = Math.max(0, ...[...scores.values()].map((p) => rate(group, p)));
  }
  if (!(choice in probabilities)) probabilities[choice] = confidence;
  return {
    choice,
    operation,
    target: chosen.length ? execute(chosen[0]!.group).label : null,
    requirement,
    covered,
    commits,
    date: parts.find((p) => p.text === requirement)?.date ?? null,
    confidence,
    probabilities,
    rawAnswers: Object.fromEntries(
      [...scores].map(([text, p]) => [text, Object.fromEntries(Object.entries(p).sort((a, b) => b[1] - a[1]).slice(0, 8))]),
    ),
    latencyMs: latency,
    usage: { requirements: parts.length, labels: [...ordered.values()].reduce((n, g) => n + g.actions.size, 0) },
  };
}
