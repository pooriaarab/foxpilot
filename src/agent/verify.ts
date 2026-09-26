// After a run that ended in "done": check the finished page against the goal.
// "Done" only means the controller found nothing left to do; this says whether
// the page shows what was asked for. Each part of the goal needs evidence on
// the page now: a field holding its value, or a control naming its setting
// ("Change ticket type. One way"). GLiNER2 picks the setting out of a part with
// no value ("one-way ticket") and recognises error, captcha and empty pages;
// matching is literal, like the controller's.
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

function evidenceFor(page: Page, part: Part): Check | null {
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
    const valued = evidenceFor(page, part);
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
