// Patience: when nothing scores, decide whether the page is still working. A
// slow job, a timed embargo, a dropdown that fills from a request and a flaky
// backend all look like "nothing to do". Ending the run there reports too
// early. This code holds the run, with a time budget, and never acts while it
// holds. It reads the history and the page text only; it makes no model call.
import type { Action, HistoryEntry, Page } from "./types";

/** The longest the run holds with no number in the ask. */
const READOUT_MS = 20_000;
/** The longest the run holds for a dropdown that fills from a request. */
const CASCADE_MS = 8_000;
/** The most the run holds for one ask, whatever number it names. */
const CEILING_MS = 60_000;
/** The most retry clicks for one control. */
export const MAX_RETRIES = 5;
/** Quiet looks in a row that end a hold, once the page changed and settled. */
const SETTLED = 2;

const CUE = "wait|waiting|take|takes|lifts?|embargo|delay|delayed|slow|patien\\w*|up to|about|loading|ready";
const UNIT = "(seconds?|secs?|s|minutes?|mins?)";
const BUDGET = new RegExp(`\\b(?:${CUE})\\b[^.;]{0,60}?\\b(\\d+(?:\\.\\d+)?)\\s*${UNIT}\\b`, "gi");
const SEVERAL = /\b(?:several|a few|some) (?:seconds|minutes)\b/i;
const ASKS_RETRY = /\b(retry|retries|try again|again|unreliable|flaky|fails?|failing)\b/i;
const READOUT = /\b\d+\s*s(?:ec(?:ond)?s?)?\s+of\s+(?:about\s+)?\d+/i;
const PROGRESS = /\b(?:loading|please wait|in progress|processing|counting down|remaining|elapsed|pending)\b/i;
/** A line that ends in an ellipsis after a verb in -ing ("Recomputing quarter…", "Saving..."). */
const DOING = /^\s*\p{L}+ing\b.*(?:…|\.\.\.)\s*$/iu;
/** Longer lines are prose: a handbook's "records-processing closure" is not a readout. */
const STATUS_LENGTH = 80;
const FAILURE = /\b(error|failed|failure|unavailable|timed? ?out|try again|could not|couldn.t|unable to|went wrong|HTTP 5\d\d)\b/i;
const RETRY_LABEL = /\b(retry|try again|reattempt)\b/i;

/** What to do while nothing scores: hold the page, click a control again, or neither. */
export type Patience = { kind: "wait" } | { kind: "retry"; action: Action } | null;

/** The wait budget the ask names, in ms: "about 10 seconds" gives 15 s. Zero when it names none. */
export function budgetOf(ask: string): number {
  if (SEVERAL.test(ask)) return READOUT_MS;
  let seconds = 0;
  for (const [, amount, unit] of ask.matchAll(BUDGET)) {
    const value = Number(amount) * (/^m/i.test(unit!) ? 60 : 1);
    if (Number.isFinite(value)) seconds = Math.max(seconds, value);
  }
  return Math.min(seconds * 1500, CEILING_MS);
}

/**
 * True when a short status line shows work in progress: a readout ("3s of
 * about 8s"), a progress word with a number or an ellipsis ("Processing 3 of
 * 10", "Loading…"), or an -ing verb that trails off ("Recomputing quarter…").
 * A progress word in prose or in a bare label ("Pending approval") is not one.
 */
export function working(text: string): boolean {
  return text.split("\n").some((line) => line.length <= STATUS_LENGTH &&
    (READOUT.test(line) || DOING.test(line) || (PROGRESS.test(line) && /\d|…|\.\.\./.test(line))));
}

/** True when a status line is short and names a failure. Long prose is content, not a status. */
export function failing(text: string): boolean {
  return text.split("\n").some((line) => line.length <= 120 && FAILURE.test(line));
}

const holding = (entry: HistoryEntry) => entry.kind === "wait";
const elapsed = (entry: HistoryEntry | undefined) => (typeof entry?.elapsedMs === "number" ? entry.elapsedMs : 0);

/**
 * Decide for the no-choice branch of `choose`. `ask` is the whole goal,
 * `parts` still lists what is not served, and `usable` rejects unsafe controls.
 */
export function patience(
  ask: string, parts: number, state: Page, history: HistoryEntry[], usable: (action: Action) => boolean,
): Patience {
  if (!history.length) return null;
  let run = 0;
  while (run < history.length && holding(history[history.length - 1 - run]!)) run += 1;
  const last = history[history.length - 1]!;
  const before = history[history.length - 1 - run];
  const waited = run ? elapsed(last) - elapsed(before) : 0;

  const clicked = [...history].reverse().find((entry) => entry.kind !== "wait" && entry.kind !== "scroll");
  const failed = failing(state.text);
  const busy = working(state.text);
  if (failed && !busy) {
    const asked = ASKS_RETRY.test(ask);
    const control = state.actions.find((a) => a.kind === "click" && usable(a) && RETRY_LABEL.test(a.label)) ??
      (asked && clicked?.kind === "click"
        ? state.actions.find((a) => a.kind === "click" && usable(a) && a.label === clicked.action)
        : undefined);
    const tries = control ? history.filter((h) => h.kind === "click" && h.action === control.label && h.requirement == null).length : 0;
    if (control && tries < MAX_RETRIES) {
      // A click just made has not been answered yet: one quiet look first, never a second click.
      return last === clicked && last.action === control.label ? { kind: "wait" } : { kind: "retry", action: control };
    }
  }

  const budget = budgetOf(ask);
  const limit = budget || (busy ? READOUT_MS : 0);
  if (limit && waited < limit) {
    // A page that changed and then stayed quiet has finished; a page that
    // never changed (an embargo) is held to the end of the budget.
    const flags = history.slice(history.length - run).map((entry) => entry.pageChanged);
    const quiet = flags.length >= SETTLED && flags.slice(-SETTLED).every((changed) => changed === false);
    if (!(quiet && flags.includes(true) && !busy)) return { kind: "wait" };
  }

  // A dropdown that fills from a request has no options yet: hold, while parts remain.
  if (parts > 0 && clicked?.kind === "select" && waited < CASCADE_MS) return { kind: "wait" };
  return null;
}
