// Port of gliner2-ultrafast browser.py (MIT) onto chrome.debugger: the same
// Chrome DevTools Protocol calls, sent from the extension to the user's tab.
// Actions target observed DOM nodes by code-owned ids, never model-written
// selectors, and are refused if the page moved since the decision.
import SNAPSHOT from "./snapshot.js";
import type { Action, Page } from "./types";
import { SETTLE } from "./settle";

export class StalePage extends Error {}

const MARKER = `(() => { const state=${SNAPSHOT}; return state?.marker ?? null; })()`;
const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves the target node, checks it is visible, enabled and not covered, and returns its centre. */
const TARGET = `(action => {
  const e=window.__glinerFast?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
  const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
  if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
  let hit=document.elementFromPoint(x,y);
  while (hit?.shadowRoot) { const inner=hit.shadowRoot.elementFromPoint(x,y); if (!inner || inner===hit) break; hit=inner; }
  const path=[]; for (let n=hit; n; n=n.parentElement||n.parentNode?.host) path.push(n);
  if (!path.includes(e)) return null;
  if (action.kind==='select') {
    if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value && !o.disabled && !o.closest('optgroup[disabled]'))) return null;
    e.value=action.value;
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return {x,y,rect:{left:r.left,top:r.top,width:r.width,height:r.height}};
})`;

/**
 * Shows what Zipline is about to touch: a ring around the element, a label
 * for the action and a ripple at the click point. Drawn in a shadow root with
 * pointer-events off, so it never intercepts input or reads as a control.
 */
const MARK = (target: { x: number; y: number; rect: { left: number; top: number; width: number; height: number } }, label: string) => `((t, label) => {
  document.getElementById('zipline-action')?.remove();
  const host = document.createElement('div');
  host.id = 'zipline-action';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  const root = host.attachShadow({ mode: 'open' });
  // Built without innerHTML: pages that enforce Trusted Types (Google Flights)
  // reject HTML strings, and a constructed stylesheet is not blocked by CSP.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('.ring{position:fixed;border-radius:10px;outline:3px solid #2cc4ad;outline-offset:4px;background:rgba(44,196,173,.12);box-shadow:0 0 24px 4px rgba(44,196,173,.55);animation:in .18s ease-out}' +
    '.tag{position:fixed;transform:translateY(-100%);margin-top:-10px;padding:3px 9px;border-radius:999px;background:#0f9d8a;color:#fff;' +
    'font:600 12px/1.4 system-ui,-apple-system,sans-serif;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.35);max-width:420px;overflow:hidden;text-overflow:ellipsis}' +
    '.dot{position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(183,227,77,.9);animation:ripple .6s ease-out forwards}' +
    '@keyframes in{from{opacity:0;transform:scale(1.06)}}' +
    '@keyframes ripple{to{transform:scale(3.2);opacity:0}}' +
    '.fade{transition:opacity .35s ease;opacity:0}');
  root.adoptedStyleSheets = [sheet];
  for (const name of ['ring', 'tag', 'dot']) { const el = document.createElement('div'); el.className = name; root.append(el); }
  const ring = root.querySelector('.ring'), tag = root.querySelector('.tag'), dot = root.querySelector('.dot');
  Object.assign(ring.style, { left: t.rect.left + 'px', top: t.rect.top + 'px', width: t.rect.width + 'px', height: t.rect.height + 'px' });
  Object.assign(tag.style, { left: t.rect.left + 'px', top: t.rect.top + 'px' });
  Object.assign(dot.style, { left: t.x + 'px', top: t.y + 'px' });
  tag.textContent = '⚡ ' + label;
  document.documentElement.append(host);
  setTimeout(() => root.querySelectorAll('.ring,.tag').forEach(e => e.classList.add('fade')), 650);
  setTimeout(() => host.remove(), 1100);
  return true;
})(${JSON.stringify(target)}, ${JSON.stringify(label)})`;

function actionLabel(action: Action, text?: string | null): string {
  if (action.kind === "fill") return `type "${(text ?? "").slice(0, 40)}"`;
  if (action.kind === "select") return `select ${action.label.split(" → ").pop()}`;
  return "click";
}

export class TabBrowser {
  private afterInput: Action | null = null;
  /** Outline each element before acting on it. */
  showActions = true;

  private constructor(readonly tabId: number) {}

  static async attach(tabId: number): Promise<TabBrowser> {
    await chrome.debugger.attach({ tabId }, "1.3");
    const browser = new TabBrowser(tabId);
    // Keep menus and animations rendering while focus is in the side panel.
    await browser.call("Emulation.setFocusEmulationEnabled", { enabled: true });
    return browser;
  }

  async detach(): Promise<void> {
    await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params) as Promise<T>;
  }

  async evaluate<T = unknown>(expression: string, awaitPromise = false): Promise<T> {
    const response = await this.call<{
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (response.exceptionDetails) {
      // Usually the document navigated mid-evaluation; keep the page's own message for the rest.
      const detail = response.exceptionDetails.exception?.description?.split("\n")[0] ?? response.exceptionDetails.text;
      throw new StalePage(`Document changed during evaluation${detail ? ` (${detail})` : ""}`);
    }
    return response.result?.value as T;
  }

  async waitForLoad(timeoutMs = 15_000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      try {
        if ((await this.evaluate("document.readyState")) === "complete") return;
      } catch {
        // navigating
      }
      await sleep(50);
    }
  }

  async observe(): Promise<Page> {
    if (this.afterInput) {
      const action = this.afterInput;
      this.afterInput = null;
      try {
        await this.evaluate(`${SETTLE}(${JSON.stringify(action)})`, true);
      } catch {
        // navigation interrupted the wait; observe anyway
      }
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const info = await this.evaluate<Page | null>(SNAPSHOT);
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

  async fresh(page: Page, action?: Action): Promise<boolean> {
    if (action && (action.kind === "click" || action.kind === "select")) {
      if (typeof action.node !== "number") return false;
      const current = await this.evaluate<[unknown[], unknown] | null>(
        `(() => { const c=window.__glinerFast; return c ? [c.pageKey(),c.guard(c.nodes.get(${action.node}))] : null; })()`,
      );
      if (!current || !sameValue(current[1], page.guards[String(action.node)])) return false;
      return unchanged(page.page_key, current[0]);
    }
    return sameValue(await this.evaluate(MARKER), page.marker);
  }

  async act(action: Action, page: Page, text?: string | null): Promise<void> {
    const kind = action.kind;
    // Waiting and scrolling cannot hit the wrong target, so a page that keeps
    // changing on its own (live results, tickers) must not block them.
    if (kind !== "wait" && kind !== "scroll" && !(await this.fresh(page, action))) {
      throw new StalePage("Page changed since this decision. Observe again.");
    }
    if (kind === "wait") {
      await sleep(600);
    } else if (kind === "scroll") {
      await this.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: 550, y: 650, deltaX: 0, deltaY: action.delta });
    } else if (kind === "key") {
      for (const [type, extra] of [["rawKeyDown", {}], ["char", { text: "\r" }], ["keyUp", {}]] as const) {
        await this.call("Input.dispatchKeyEvent", {
          type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...extra,
        });
      }
    } else {
      if (typeof action.node !== "number") throw new Error("Invalid observed node");
      if (action.offscreen) {
        await this.evaluate(
          `(action => { const e=window.__glinerFast?.nodes.get(action.node); if (e) e.scrollIntoView({block:'center', inline:'center'}); return true; })(${JSON.stringify(action)})`,
        );
        await sleep(50);
      }
      const target = await this.evaluate<{ x: number; y: number; rect: { left: number; top: number; width: number; height: number } } | null>(
        `${TARGET}(${JSON.stringify(action)})`,
      );
      if (!target) {
        if (kind === "select") throw new Error("Dropdown execution was not confirmed; inspect before retrying.");
        throw new StalePage("Target changed or is covered. Observe again.");
      }
      if (this.showActions) {
        await this.evaluate(MARK(target, actionLabel(action, text))).catch(() => {});
        await sleep(120);
      }
      if (kind !== "select") {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await this.call("Input.dispatchMouseEvent", { type, x: target.x, y: target.y, button: "left", clickCount: 1 });
        }
        if (kind === "fill") {
          const modifiers = isMac ? 4 : 2;
          await this.call("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers, commands: ["selectAll"] });
          await this.call("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers });
          await this.call("Input.insertText", { text: text ?? "" });
        }
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
