// After a run that ended in "done": check the finished page against the goal.
// "Done" only means the controller found nothing left to do; this says whether
// the page shows what was asked for. Each part of the goal needs evidence on
// the page now: a field holding its value, or a control naming its setting
// ("Change ticket type. One way"). GLiNER2 picks the setting out of a part with
// no value ("one-way ticket") and recognises error, captcha and empty pages;
// matching is literal, like the controller's, except on a field the page
// renamed after the agent committed it.
import { parseAsk } from "./ask";
import { nearlyNames, namesValue, unsentForms, type Part, type Scorer } from "./controller";
import { firstDate } from "./dates";
import type { Action, HistoryEntry, Page } from "./types";

export type Check = { part: string; ok: boolean; evidence: string };
export type Verdict = { verified: boolean; checks: Check[]; problem?: string };

// Examples in the description matter: without "walking" in it, "Get walking
// directions" gave no span; with them, walking 0.84, one-way 0.98, business class 0.93.
const SETTING = { setting: "an option or mode the person wants, such as one-way, business class, walking, driving or transit" };

const PAGE = {
  problem: "an error, no results, a captcha or a sign-in page",
  content: "a page with content or results",
};

/** Where a control shows its state: the field's value, then its name. */
function shown(action: Action): string[] {
  return [action.value, action.current_value, action.label].filter((t): t is string => Boolean(t));
}

/**
 * The page's own form comes first: a card beside it can name the same words
 * ("One way trip from New York…") while the form says Round trip.
 */
function controlsOf(page: Page): Action[] {
  const controls = page.actions.filter((a) => a.kind !== "scroll" && a.kind !== "wait" && a.kind !== "key");
  const inForm = controls.filter((a) => a.form != null);
  return inForm.some((a) => a.kind === "fill") ? inForm : controls;
}

/**
 * A field the page renamed after the agent committed it: Google Maps turns a
 * taken "Berlin Hauptbahnhof" into "Berlin Central Station" after the next
 * click. Only the exact node the agent filled for this part counts, and only if
 * the suggestion it took (or the field right after) named the value, nothing
 * was typed into that node since, and the field names no other part's value.
 */
function renamed(page: Page, part: Part, parts: Part[], history: HistoryEntry[]): Check | null {
  const names = (text?: string | null) => Boolean(text) && part.values.every((v) => nearlyNames(text!, v));
  const others = parts.filter((p) => p !== part).flatMap((p) => p.values);
  for (const [index, commit] of history.entries()) {
    const node = commit.committed_node;
    if (node == null || !(names(commit.action) || names(commit.committed_value))) continue;
    const into = (h: HistoryEntry) => h.kind === "fill" && h.node === node && h.document_id === commit.document_id;
    if (history.slice(0, index).reverse().find(into)?.requirement !== part.text) continue;
    if (history.slice(index + 1).some(into)) continue;
    const field = page.actions.find((a) => a.kind === "fill" && a.node === node && a.document_id === commit.document_id);
    if (!field?.value?.trim() || others.some((v) => nearlyNames(field.value!, v))) continue;
    return { part: part.text, ok: true, evidence: `${field.label.trim()}: ${field.value} (renamed by the page after "${commit.action.trim()}")` };
  }
  return null;
}

function evidenceFor(page: Page, part: Part, parts: Part[], history: HistoryEntry[]): Check | null {
  const controls = controlsOf(page);
  if (part.date) {
    const field = controls.find((a) => shown(a).some((t) => firstDate(t) === part.date));
    if (field) return { part: part.text, ok: true, evidence: `${field.label.trim()}: ${field.value ?? field.label}` };
    return { part: part.text, ok: false, evidence: `no field or label shows ${part.date}` };
  }
  if (!part.values.length) return null;
  const missing = part.values.filter((value) => !controls.some((a) => shown(a).some((t) => nearlyNames(t, value))));
  if (!missing.length) {
    const field = controls.find((a) => a.value && part.values.every((v) => nearlyNames(a.value!, v)));
    return { part: part.text, ok: true, evidence: field ? `${field.label.trim()}: ${field.value}` : "named on the page" };
  }
  const kept = renamed(page, part, parts, history);
  if (kept) return kept;
  // Without a form, results often name the values in text only ("New York to San Francisco").
  const hasForm = page.actions.some((a) => a.form != null && a.kind === "fill");
  if (!hasForm && missing.every((value) => nearlyNames(page.text, value))) return { part: part.text, ok: true, evidence: "in the page text" };
  return { part: part.text, ok: false, evidence: `${missing.join(", ")} not on the page` };
}

/** "one-way ticket" is shown as "One way": try the span, then without its last word. */
const on = (a: Action) => [a.selected, a.checked, a.pressed].some((v) => v === "true");
const stated = (a: Action) => [a.selected, a.checked, a.pressed].some((v) => v != null);

/**
 * The control showing a setting. Where the matching controls report a state
 * (a row of travel-mode tabs: aria-selected, aria-checked, aria-pressed), the
 * one for the setting must be the selected one: a "Walking" tab that is merely
 * on the page does not mean walking directions.
 */
function settingShown(page: Page, span: string): { control?: Action; unselected?: Action } {
  const words = span.split(/[\s-]+/).filter(Boolean);
  const tries = [words.join(" "), words.length > 1 ? words.slice(0, -1).join(" ") : ""].filter(Boolean);
  const matching = controlsOf(page).filter((a) => shown(a).some((t) => tries.some((needle) => namesValue(t, needle))));
  if (!matching.length) return {};
  if (!matching.some(stated)) return { control: matching[0] };
  const selected = matching.find(on);
  return selected ? { control: selected } : { unselected: matching.find(stated) };
}

export async function verify(model: Scorer, page: Page, parts: Part[], history: HistoryEntry[]): Promise<Verdict> {
  const checks: Check[] = [];
  for (const part of parts) {
    const valued = evidenceFor(page, part, parts, history);
    if (valued) {
      checks.push(valued);
      continue;
    }
    const found = await model.extractEntities(part.text, SETTING);
    const span = found.setting?.[0]?.text;
    if (!span) continue; // "Get directions": nothing checkable beyond the page itself
    const { control, unselected } = settingShown(page, span);
    checks.push(
      control
        ? { part: part.text, ok: true, evidence: control.label.trim() }
        : unselected
          ? { part: part.text, ok: false, evidence: `"${unselected.label.trim()}" is on the page but not selected` }
          : { part: part.text, ok: false, evidence: `nothing on the page shows "${span}"` },
    );
  }
  if (unsentForms(page, history).size) checks.push({ part: "Search sent", ok: false, evidence: "the form still holds values that were never sent" });
  const kind = await model.classify(`${page.title}. ${page.text.slice(0, 500)}`, "page", PAGE);
  const problem = (kind.problem ?? 0) >= 0.7 ? `the page looks like an error, empty result or captcha (${Math.round(kind.problem! * 100)}%)` : undefined;
  return { verified: !problem && checks.every((c) => c.ok), checks, problem };
}

/** A field to type again, with the value the page's error text gave for it. */
export type Refill = { action: Action; text: string; requirement: string | null };

/** A line that asks for something else: "Use your work address …", "Must be the 5-digit ZIP 60614". */
const CORRECTION = /\b(?:use|must|should|enter|expected|instead|invalid|required|needs?|not)\b/i;
const SHAPED = new Set(["email", "card", "phone", "cvv", "expiry", "zip", "code"]);

/**
 * After a send: the fields the page's new text corrects. A new line that reads
 * as a correction and holds a value of one field's shape (email, ZIP, phone,
 * card, code), different from what was typed there, gives that field its value.
 * The shape of a field comes from its label and what was typed ("Work email",
 * "Company ZIP code: 60614-2210"). Fields the text does not name keep their value.
 */
export function corrections(before: string, page: Page, history: HistoryEntry[]): Refill[] {
  const old = new Set(before.split("\n"));
  const offered = page.text.split("\n").filter((line) => !old.has(line) && CORRECTION.test(line))
    .flatMap((line) => parseAsk(line).values.filter((v) => SHAPED.has(v.kind)));
  const typed = page.actions.flatMap((action) => {
    if (action.kind !== "fill" || !action.value) return [];
    const entry = [...history].reverse().find((h) => h.kind === "fill" && h.text && h.node === action.node && h.document_id === action.document_id);
    if (!entry) return [];
    const label = action.label.replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
    const kind = parseAsk(`${label}: ${entry.text}`).values.find((v) => SHAPED.has(v.kind))?.kind;
    return kind ? [{ action, kind, entry }] : [];
  });
  const refills: Refill[] = [];
  for (const { action, kind, entry } of typed) {
    if (typed.filter((t) => t.kind === kind).length !== 1) continue;
    const value = offered.find((v) => v.kind === kind && v.value.toLowerCase() !== entry.text!.toLowerCase())?.value;
    if (value) refills.push({ action, text: value, requirement: entry.requirement ?? null });
  }
  return refills;
}
