// The per-tab store. The content script reports each step it takes; the
// background keeps the page's log in storage.session; the popup and the E2E runner read it.
import type { Step } from "./plan";

/** One step the content script took. `failed` says why it did not, and the page was left as it was. */
export type Entry = Step & { dialog: number; title: string; failed?: string };

/** What a content script sends: a new page, that its site is off, or one step. */
export type Report = { type: "start" | "off"; url: string } | { type: "step"; url: string; entry: Entry };

/** One tab. `log` keeps every step of the page, oldest first. `stopped` is the reason of the failed step. */
export type TabLog = { url: string; off: boolean; stopped: string | null; log: (Entry & { at: number })[] };

export const tabKey = (tabId: number) => `tab:${tabId}`;
