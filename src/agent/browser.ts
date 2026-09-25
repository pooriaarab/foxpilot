// Port of gliner2-ultrafast browser.py (MIT) onto chrome.debugger: the same
// Chrome DevTools Protocol calls, sent from the extension to the user's tab.
// Actions target observed DOM nodes by code-owned ids, never model-written
// selectors, and are refused if the page moved since the decision.
import SNAPSHOT from "./snapshot.js";
import type { Action, Page } from "./types";

export class StalePage extends Error {}

const MARKER = `(() => { const state=${SNAPSHOT}; return state?.marker ?? null; })()`;
const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits after input: for autocomplete options to render, or a couple of frames. */
const SETTLE = `(action => new Promise(resolve => {
  const field=window.__glinerFast?.nodes.get(action.node);
  const autocomplete=action.kind==='fill' && (field?.getAttribute('role')==='combobox' ||
    field?.getAttribute('aria-autocomplete')==='list' || field?.hasAttribute('aria-controls'));
  let frames=0, stopped=false; const started=performance.now();
  const finish=()=>{stopped=true;resolve()};
  setTimeout(finish,autocomplete ? 600 : 250);
  const ready=()=>{
    if (stopped) return;
    const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'').split(/\\s+/).filter(Boolean);
    const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
    const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"],[role="gridcell"]')]);
    if (++frames>=2 && (autocomplete ? options.some(e=>{
      const r=e.getBoundingClientRect();
      return r.width && r.height && r.bottom>0 && r.top<innerHeight && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    }) : performance.now()-started>=150)) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
}))`;

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
  return {x,y};
})`;

export class TabBrowser {
  private afterInput: Action | null = null;

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
    const response = await this.call<{ result?: { value?: T }; exceptionDetails?: unknown }>("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise,
    });
    if (response.exceptionDetails) throw new StalePage("Document changed during evaluation");
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
    if (!(await this.fresh(page, action))) throw new StalePage("Page changed since this decision. Observe again.");
    const kind = action.kind;
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
      const target = await this.evaluate<{ x: number; y: number } | null>(`${TARGET}(${JSON.stringify(action)})`);
      if (!target) {
        if (kind === "select") throw new Error("Dropdown execution was not confirmed; inspect before retrying.");
        throw new StalePage("Target changed or is covered. Observe again.");
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
