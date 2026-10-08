// Port of gliner2-ultrafast browser.py (MIT) onto Firefox's scripting API, in
// place of the Chrome DevTools Protocol calls Zipline made. Actions target
// observed DOM nodes by code-owned ids, never model-written selectors, and
// are refused if the page moved since the decision.
//
// Everything runs in the extension's isolated world of the tab. Page CSP and
// Trusted Types do not apply there, page scripts cannot change its globals,
// and Firefox keeps one isolated world per document, so snapshot.js's
// window.__glinerFast cache stays between calls.
import { snapshot } from "./snapshot.js";
import type { Action, Page } from "./types";
import { settle } from "./settle";
import { fillField, pressKey, scrollAt, strike } from "./actuate";

export class StalePage extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function actionLabel(action: Action, text?: string | null): string {
  if (action.kind === "fill") return `type "${(text ?? "").slice(0, 40)}"`;
  if (action.kind === "select") return `select ${action.label.split(" → ").pop()}`;
  return "click";
}

type FrameEvent = { tabId: number; frameId: number };
type Injected = (...args: never[]) => unknown;

/** Calls to one injected function: how many, and their total ms. */
export type Calls = { count: number; ms: number };

/** Injected functions by name. The build minifies function names; object keys stay. */
const names = new Map<Injected, string>();

/** Names injected functions, so `TabBrowser.calls` can count them. */
export function nameInjected(functions: Record<string, Injected>): void {
  for (const [name, func] of Object.entries(functions)) names.set(func, name);
}

function attached() { return true; }

function readyState() { return document.readyState; }

function nodeGuard(node: number) {
  const c = window.__glinerFast;
  return c ? [c.pageKey(), c.guard(c.nodes.get(node))] : null;
}

nameInjected({ attached, readyState, nodeGuard, snapshot, settle, fillField, pressKey, scrollAt, strike });

export class TabBrowser {
  private afterInput: Action | null = null;
  /** Outline each element before acting on it. */
  showActions = true;
  /** Every `evaluate` call since attaching, by function name. */
  readonly calls: Record<string, Calls> = {};
  /** Which check failed when `fresh` last returned false. */
  stale = "";

  private constructor(readonly tabId: number) {}

  /** Main-frame loads started since attaching, and whether one is in progress. */
  navigations = 0;
  loading = false;
  private started = ({ tabId, frameId }: FrameEvent) => {
    if (tabId !== this.tabId || frameId !== 0) return;
    this.navigations++;
    this.loading = true;
  };
  private stopped = ({ tabId, frameId }: FrameEvent) => {
    if (tabId === this.tabId && frameId === 0) this.loading = false;
  };

  static async attach(tabId: number): Promise<TabBrowser> {
    const browser = new TabBrowser(tabId);
    // Fails here, not mid-run, when the page cannot be scripted. The panel decides from the URL what to do.
    await browser.evaluate(attached).catch((error: Error) => {
      throw new Error(`Cannot attach to this page: ${error.message}`);
    });
    // Load events tell a search that navigates (Amazon) from one that updates in place.
    chrome.webNavigation.onBeforeNavigate.addListener(browser.started);
    chrome.webNavigation.onCompleted.addListener(browser.stopped);
    chrome.webNavigation.onErrorOccurred.addListener(browser.stopped);
    return browser;
  }

  async detach(): Promise<void> {
    chrome.webNavigation.onBeforeNavigate.removeListener(this.started);
    chrome.webNavigation.onCompleted.removeListener(this.stopped);
    chrome.webNavigation.onErrorOccurred.removeListener(this.stopped);
  }

  /** Loads a URL in the tab and waits for it. */
  async navigate(url: string, maxMs = 15_000): Promise<void> {
    const since = this.navigations;
    await chrome.tabs.update(this.tabId, { url });
    await this.settleNavigation(since, 2000, maxMs);
  }

  /**
   * After a send: if the page starts loading a new document within `startMs`,
   * wait for it to finish (up to `maxMs`). Returns whether one loaded.
   */
  async settleNavigation(since: number, startMs = 150, maxMs = 8000): Promise<boolean> {
    const start = performance.now();
    while (this.navigations === since && performance.now() - start < startMs) await sleep(50);
    if (this.navigations === since) return false;
    while (this.loading && performance.now() - start < maxMs) await sleep(50);
    await this.waitForLoad(Math.max(0, maxMs - (performance.now() - start)));
    return true;
  }

  /**
   * Runs `func` in the tab's top frame with JSON `args`; a promise it returns is awaited.
   * Firefox sends only the source of `func`, so it must use nothing from module scope.
   */
  async evaluate<A extends unknown[], T>(func: (...args: A) => T, ...args: A): Promise<Awaited<T>> {
    let results: { result?: unknown; error?: unknown }[];
    const calls = (this.calls[names.get(func as Injected) ?? "unnamed"] ??= { count: 0, ms: 0 });
    const started = performance.now();
    try {
      results = await chrome.scripting.executeScript({ target: { tabId: this.tabId }, world: "ISOLATED", injectImmediately: true, func, args });
    } catch (error) {
      // Usually the document navigated mid-evaluation; keep the browser's own message for the rest.
      throw new StalePage(`Document changed during evaluation (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      calls.count++;
      calls.ms += performance.now() - started;
    }
    const [first] = results;
    if (!first || first.error) throw new StalePage(`Document changed during evaluation${first?.error ? ` (${String(first.error)})` : ""}`);
    return first.result as Awaited<T>;
  }

  async waitForLoad(timeoutMs = 15_000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      try {
        if ((await this.evaluate(readyState)) === "complete") return;
      } catch {
        // navigating
      }
      await sleep(50);
    }
  }

  /** Reads the page. After input, or with `quiet`, first waits for it to settle. */
  async observe(quiet = false): Promise<Page> {
    const action = this.afterInput ?? (quiet ? ({ id: "", kind: "wait", label: "" } as Action) : null);
    if (action) {
      this.afterInput = null;
      try {
        await this.evaluate(settle, action);
      } catch {
        // navigation interrupted the wait; observe anyway
      }
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const info = await this.evaluate(snapshot);
        if (!info) throw new StalePage("Document is navigating");
        info.fingerprint = await fingerprint(info);
        return info;
      } catch (error) {
        if (!(error instanceof StalePage) || attempt === 9) throw error;
        await sleep(50);
      }
    }
    throw new StalePage("Page did not settle");
  }

  /** Is the page still the one `page` read? When not, `stale` names the check that failed. */
  async fresh(page: Page, action?: Action): Promise<boolean> {
    if (action && (action.kind === "click" || action.kind === "select")) {
      if (typeof action.node !== "number") return this.failed("no node");
      const current = await this.evaluate(nodeGuard, action.node);
      if (!current) return this.failed("node gone");
      if (!sameValue(current[1], page.guards[String(action.node)])) return this.failed("guard");
      return unchanged(page.page_key, current[0] as unknown[]) || this.failed("page key");
    }
    return sameValue((await this.evaluate(snapshot))?.marker ?? null, page.marker) || this.failed("marker");
  }

  private failed(check: string): false {
    this.stale = check;
    return false;
  }

  async act(action: Action, page: Page, text?: string | null): Promise<void> {
    const kind = action.kind;
    // Waiting and scrolling cannot hit the wrong target, so a page that keeps
    // changing on its own (live results, tickers) must not block them.
    if (kind !== "wait" && kind !== "scroll" && !(await this.fresh(page, action))) {
      throw new StalePage(`Page changed since this decision (${this.stale}). Observe again.`);
    }
    if (kind === "wait") {
      await sleep(600);
    } else if (kind === "scroll") {
      await this.evaluate(scrollAt, action.delta ?? 0);
    } else if (kind === "key") {
      await this.evaluate(pressKey, "Enter");
    } else {
      if (typeof action.node !== "number") throw new Error("Invalid observed node");
      // One call resolves, outlines, waits and clicks, right after the stale check above.
      if (!(await this.evaluate(strike, action, this.showActions ? actionLabel(action, text) : null))) {
        if (kind === "select") throw new Error("Dropdown execution was not confirmed; inspect before retrying.");
        throw new StalePage("Target changed or is covered. Observe again.");
      }
      if (kind === "fill" && (await this.evaluate(fillField, action.node, text ?? "")) == null) {
        throw new StalePage("Field went away before typing. Observe again.");
      }
    }
    this.afterInput = kind !== "wait" && kind !== "key" ? action : null;
  }
}

/**
 * Did anything this decision was based on move? A field that appears after
 * the observation was not part of the decision, so only observed ones count.
 */
function unchanged(before: unknown[], now: unknown[]): boolean {
  if (!sameValue(before.slice(0, 6), now.slice(0, 6))) return false;
  const current = new Map((now[6] as unknown[][]).map((row) => [row[0], row]));
  return (before[6] as unknown[][]).every((row) => sameValue(current.get(row[0]), row));
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function fingerprint(page: Page): Promise<string> {
  const content = stableStringify({ url: page.url, text: page.text, actions: page.actions, scroll: (page as { scroll?: unknown }).scroll });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
