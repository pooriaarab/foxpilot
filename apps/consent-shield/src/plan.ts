// Finds consent and nag dialogs in the page and plans the clicks that refuse
// them. Nothing here presses a control: the plan is a dry run. dialogs.ts
// picks each control; this file only finds the dialog and replays the picks
// on a copy of its controls, so one plan covers one layer.
import { acceptsAll, declining, refusing, type Control, type Stance } from "@foxpilot/core/dialogs";
import type { Scorer } from "@foxpilot/core/model/scorer";
import type { Action, HistoryEntry } from "@foxpilot/core/page/types";
import { firstDate } from "@foxpilot/core/text/dates";

export type Step = { kind: "toggle" | "expand" | "press" | "scroll"; label: string };
export type Plan = { dialog: number; stance: Stance; title: string; steps: Step[]; summary: string };

// The page's own dialog markup, and the containers CMPs inject at the end of
// the body: fixed or sticky boxes with buttons. Vendor names are not needed.
const MARKED = 'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
const SHALLOW = ":scope>*,:scope>*>*,:scope>*>*>*";
const LANDMARKS = 'header,nav,footer,[role="banner"],[role="navigation"],[role="contentinfo"]';
const CONSENT = /\b(?:cookies?|consent|legitimate interest|vendors?|partners|purposes|tracking|personali[sz]ed (?:ads|content))\b/i;
const NAG = /\b(?:subscribe|newsletter|sign up|notifications?|offers?|discount|digest)\b|\d+% off/i;
/** A floating box with more text than this is a page shell, not a banner. */
const BANNER_TEXT = 1500;
const REJECT = /\b(?:reject|refuse|deny|decline)\b/i;
const OPTION_ROLES = new Set(["option", "menuitemradio", "menuitemcheckbox", "radio", "tab"]);
const TOGGLES = new Set(["switch", "checkbox"]);
const CONTROLS = 'button,a[href],input,select,[role="button"],[role="switch"],[role="checkbox"]';

const ids = new WeakMap<Element, number>();
/** A dialog keeps the stance it first showed: a TCF purposes layer no longer says "cookies". */
const stances = new WeakMap<Element, Stance>();
let next = 0;
const idOf = (e: Element) => ids.get(e) ?? (ids.set(e, ++next), next);

const shown = (e: Element) =>
  !e.closest('[aria-hidden="true"],[inert]') && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
  e.getBoundingClientRect().width > 0;
const floats = (e: Element) => /^(?:fixed|sticky)$/.test(getComputedStyle(e).position);

/** The visible dialogs that ask for consent or push a prompt, in page order; the last is on top. */
export function dialogs(): { element: Element; stance: Stance }[] {
  const found = new Set<Element>(document.querySelectorAll(MARKED));
  for (const e of document.body.querySelectorAll(SHALLOW)) {
    if (floats(e) && !e.matches(LANDMARKS) && e.querySelector('button,[role="button"],a[href]') &&
      (e as HTMLElement).innerText.length <= BANNER_TEXT) found.add(e);
  }
  // A veil holds the dialog box: keep the innermost box, not the veil around it.
  const boxes = [...found].filter((e) => shown(e) && ![...found].some((o) => o !== e && e.contains(o) && shown(o)));
  return boxes.flatMap((element) => {
    const text = (element as HTMLElement).innerText.slice(0, 3000);
    const stance: Stance = stances.get(element) ?? (CONSENT.test(text) ? "refuse" : NAG.test(text) ? "decline" : "none");
    if (stance === "none") return [];
    stances.set(element, stance);
    return [{ element, stance }];
  });
}

const tidy = (label: string) => label.replace(/\s+/g, " ").trim().slice(0, 90);

/** Controls of the dialog below the viewport, or below its own scroll edge. The snapshot leaves them out. */
function below(element: Element): boolean {
  const style = getComputedStyle(element);
  const edge = /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1
    ? Math.min(innerHeight, element.getBoundingClientRect().bottom) : innerHeight;
  return [...element.querySelectorAll(CONTROLS)].some((e) => shown(e) && e.getBoundingClientRect().top >= edge - 1);
}

/**
 * The plan for one dialog. `actions` come from the page kit snapshot and
 * `nodeOf` maps an action to its element. Controls the user already pressed
 * (`pressed`, by snapshot node) are not offered again, as in the agent.
 */
export async function plan(
  model: Scorer, element: Element, stance: Stance, actions: Action[], nodeOf: (a: Action) => Element | undefined, pressed: Set<number>,
): Promise<Plan | null> {
  const controls: Control[] = actions
    .filter((a) => a.kind === "click" && element.contains(nodeOf(a) ?? null))
    .map((a) => {
      const label = tidy(a.label);
      const pick = !a.offscreen && !firstDate(label) && !OPTION_ROLES.has(a.role ?? "") && !(pressed.has(a.node!) && !TOGGLES.has(a.role ?? ""));
      return { label, action: { ...a }, pick };
    });
  const steps: Step[] = [];
  if (stance === "decline") {
    const found = await declining(model, stance, controls);
    if (found && !acceptsAll(found.label)) steps.push({ kind: "press", label: found.label });
  } else {
    const history: HistoryEntry[] = [];
    // Replay refusing() on the copy: a switched toggle reads as off, and the next pick follows.
    for (let found = await refusing(model, controls, history); found; found = await refusing(model, controls, history)) {
      const label = found.label;
      const toggle = controls.find((c) => c.label === label && TOGGLES.has(c.action.role ?? "") && c.action.checked === "true");
      if (toggle) {
        toggle.action.checked = "false";
        history.push({ kind: "click", action: label });
        steps.push({ kind: "toggle", label });
        continue;
      }
      // Expanding a section or opening a layer shows controls this plan cannot see yet.
      const expands = controls.some((c) => c.label === label && c.action.expanded === "false");
      if (!acceptsAll(label)) steps.push({ kind: expands ? "expand" : "press", label });
      break;
    }
    // refusing() walks the layers and passes over "Reject all". A one-layer banner offers nothing else,
    // but a long layer shows its Save button only after a scroll.
    const last = steps.at(-1);
    if ((!last || last.kind === "toggle") && below(element)) steps.push({ kind: "scroll", label: "Scroll down" });
    else if (!last || last.kind === "toggle") {
      const reject = controls.find((c) => c.pick && !TOGGLES.has(c.action.role ?? "") && REJECT.test(c.label) && !acceptsAll(c.label));
      if (reject) steps.push({ kind: "press", label: reject.label });
    }
  }
  if (!steps.length) return null;
  const title = tidy((element.querySelector("h1,h2,h3,[id*=title i]")?.textContent ?? element.getAttribute("aria-label") ?? "").slice(0, 80));
  return { dialog: idOf(element), stance, title, steps, summary: describe(steps) };
}

/** One step for people: 'press "Save my choices"'. */
export function says(step: Step): string {
  return step.kind === "scroll" ? "scroll down" : `${{ toggle: "turn off", expand: "open", press: "press" }[step.kind]} "${step.label}"`;
}

/** 'Would turn off 9 toggles and press "Save my choices"'. */
export function describe(steps: Step[]): string {
  const toggles = steps.filter((s) => s.kind === "toggle").length;
  const end = steps.filter((s) => s.kind !== "toggle").map(says);
  const parts = [...(toggles ? [`turn off ${toggles} toggle${toggles === 1 ? "" : "s"}`] : []), ...end];
  return `Would ${parts.join(" and ")}`;
}
