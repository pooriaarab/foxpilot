// Dialogs the goal does not ask for, and consent walls the goal says to refuse.
// The controller picks controls for the goal; this file picks the control that
// says no. GLiNER2 classifies each button; code applies the order and the limits.
import { firstDate } from "@foxpilot/core/text/dates";
import type { Labels, Scorer } from "./controller";
import type { Action, HistoryEntry } from "@foxpilot/core/page/types";

/** What the goal says about dialogs: refuse optional consent, decline prompts, or nothing. */
export type Stance = "refuse" | "decline" | "none";

/** One control inside a dialog. `pick` is false when the controller may not press it. */
export type Control = { label: string; action: Action; pick: boolean };

const REFUSE = /\b(?:refuse|reject|decline|deny|turn off|switch off|opt out of?|disable)\b[^.;]*\b(?:all|every)\b[^.;]*\b(?:non-?essential|optional|cookies?|tracking|purposes?|consent)\b/i;
const DECLINE = /\b(?:decline|dismiss|close|refuse|reject|skip|deny)\b[^.;]*\b(?:prompts?|pop-?ups?|dialogs?|modals?|offers?|banners?|notifications?|subscriptions?|newsletters?)\b/i;
const ACCEPT_ALL = /\b(?:accept|agree|allow all|enable all|consent)\b/i;
const CLOSER = /^(?:close|dismiss|cancel|no,? thanks?|not now|maybe later|skip|[×xX✕✖✗])$/;
const WORDS: [string, RegExp][] = [
  ["other", /\b(?:reject|refuse|deny|decline|object)\b/i],
  ["save", /\b(?:save|confirm|apply|submit)\b/i],
  ["back", /^(?:back|return|previous|go back)\b/i],
  ["more", /\b(?:manage|options|preferences|settings|vendors?|partners?|customi[sz]e|more)\b/i],
];
const REQUIRED = /\b(?:essential|necessary|required|strictly)\b/i;
const BUTTONS = new Set(["button", "link", "menuitem"]);
const TOGGLES = new Set(["switch", "checkbox"]);
/** At most this many buttons of one dialog go to GLiNER2, and at most this many toggles are switched. */
const BUTTON_CAP = 8;
const TOGGLE_CAP = 40;
const FLOOR = 0.5;
const STEP_FLOOR = 0.35;

const SIDES: Labels = {
  decline: "close, not now, no thanks, skip, reject",
  accept: "subscribe, enable, accept, allow, upgrade, claim",
  neutral: "done, apply, save or confirm a choice",
};
const STEPS: Labels = {
  more: "opens another layer of privacy options such as manage options, preferences, vendors or partners",
  save: "saves or confirms the privacy choices",
  back: "goes back to the previous layer",
  other: "anything else",
};

export function stanceOf(goal: string): Stance {
  if (REFUSE.test(goal)) return "refuse";
  return DECLINE.test(goal) ? "decline" : "none";
}

/** Never press these while refusing: they grant every purpose. */
export function acceptsAll(label: string): boolean {
  return ACCEPT_ALL.test(label);
}

const seen = new Map<string, [string, number]>();

/** The best class of a button label under one label set. A label keeps its class for the run. */
async function sort(model: Scorer, label: string, name: string, labels: Labels): Promise<[string, number]> {
  const key = `${name}\u0000${label}`;
  let found = seen.get(key);
  if (!found) {
    const scores = Object.entries(await model.classify(label, name, labels));
    found = scores.reduce((a, b) => (b[1] > a[1] ? b : a));
    seen.set(key, found);
  }
  return found;
}

const presses = (c: Control) => c.action.kind === "click" && BUTTONS.has(c.action.role ?? "") && !firstDate(c.label);

/**
 * The control that declines a prompt. When the goal names prompts, a decline
 * control is enough. Otherwise the dialog must also offer an accept control
 * (subscribe, enable): a picker that has "Cancel" and "Done" is not a prompt.
 */
export async function declining(model: Scorer, stance: Stance, controls: Control[]): Promise<{ label: string; score: number } | null> {
  let best: { label: string; score: number } | null = null;
  let offers = false;
  for (const control of controls.filter(presses).slice(0, BUTTON_CAP)) {
    const [side, score] = CLOSER.test(control.label.trim())
      ? (["decline", 1] as [string, number])
      : await sort(model, control.label, "dialog", SIDES);
    if (side === "accept" && score >= FLOOR) offers = true;
    // Stacked prompts share one level: the last one in the page is on top, and only it takes a click.
    if (side === "decline" && score >= FLOOR && control.pick) best = { label: control.label, score };
  }
  return best && (stance === "decline" || offers) ? best : null;
}

/**
 * The next control that refuses optional consent: switch off a toggle that is
 * on, expand a collapsed section, open another layer, save, and only then go
 * back. A layer is entered once, because the controller does not press a
 * control twice. Accept-all is never returned.
 */
export async function refusing(model: Scorer, controls: Control[], history: HistoryEntry[]): Promise<{ label: string; score: number } | null> {
  const open = controls.filter((c) => c.pick);
  const toggles = controls.filter((c) => TOGGLES.has(c.action.role ?? ""));
  const switched = history.filter((e) => e.kind === "click" && toggles.some((t) => t.label === e.action)).length;
  const on = open.find((c) => TOGGLES.has(c.action.role ?? "") && c.action.checked === "true" && !REQUIRED.test(c.label));
  if (on && switched < TOGGLE_CAP) return { label: on.label, score: 1 };
  const collapsed = open.find((c) => c.action.expanded === "false" && c.action.kind === "click");
  if (collapsed) return { label: collapsed.label, score: 1 };
  const found: Record<string, { label: string; score: number }> = {};
  for (const control of open.filter((c) => presses(c) && !acceptsAll(c.label) && c.action.expanded == null).slice(0, BUTTON_CAP)) {
    const word = WORDS.find(([, pattern]) => pattern.test(control.label));
    const [step, score] = word ? ([word[0], 1] as [string, number]) : await sort(model, control.label, "dialog button", STEPS);
    if (step === "other" || score < STEP_FLOOR) continue;
    if (!found[step] || score > found[step]!.score) found[step] = { label: control.label, score };
  }
  return found.more ?? found.save ?? found.back ?? null;
}
