// The per-tab store. The content script reports; the background keeps the
// latest plans and a log in storage.session; the popup and the E2E runner read it.
import type { Plan } from "./plan";

/** What a content script sends: the plans for the dialogs on screen, or that its site is off. */
export type Report = { type: "plans"; url: string; plans: Plan[] } | { type: "off"; url: string };

/** One tab. `log` keeps every distinct plan of the page, oldest first. */
export type TabLog = { url: string; off: boolean; plans: Plan[]; log: (Plan & { at: number })[] };

export const tabKey = (tabId: number) => `tab:${tabId}`;
