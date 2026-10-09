// In-page input for TabBrowser, in place of Chrome DevTools Input.* calls.
// Each function is injected on its own by scripting.executeScript, so each
// one must be self-contained: no imports, no module helpers, JSON arguments.
// Events made here have isTrusted false. Pages that act on click, pointer,
// key, input and submit events still respond; what needs a real user gesture
// (popups, native pickers, file dialogs, fullscreen) does not open.

type Target = { x: number; y: number; rect: { left: number; top: number; width: number; height: number } };
type Acted = { kind: string; node?: number; value?: string; offscreen?: boolean };

declare global {
  interface Window {
    __glinerFast?: {
      nodes: Map<number, HTMLElement>;
      /** The element a run is limited to. The context menu sets it; the panel clears it after the run. */
      scope?: Element | null;
      pageKey(): unknown[];
      guard(e?: Element): unknown;
    };
    __focusBeforeClick?: Element | null;
  }
}

/**
 * Acts on one observed node in a single call: scrolls it into view when it is
 * offscreen, checks it is visible, enabled and not covered, outlines it when
 * `label` is set and waits a moment so the outline shows, then clicks its
 * centre. A select gets its option instead of a click. Returns false, before
 * any input, when the target is gone, covered or not usable.
 */
export async function strike(action: Acted, label: string | null): Promise<boolean> {
  /**
   * Clicks the topmost element at (x, y) the way a mouse does: hover, press
   * (which moves focus unless the page cancels it), release, click.
   */
  function clickAt(x: number, y: number): boolean {
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner; }
    if (!hit) return false;
    const at = hit;
    // fillField reads this to tell a focus move made by this click from a stale one.
    let before: Element | null = document.activeElement;
    while (before?.shadowRoot?.activeElement) before = before.shadowRoot.activeElement;
    window.__focusBeforeClick = before;
    const mouse = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y,
      screenX: screenX + x, screenY: screenY + y, button: 0, detail: 1 };
    const pointer = { ...mouse, pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1 };
    const fire = (type: string, buttons: number, bubbles = true) => at.dispatchEvent(type.startsWith("pointer")
      ? new PointerEvent(type, { ...pointer, buttons, bubbles }) : new MouseEvent(type, { ...mouse, buttons, bubbles }));
    fire("pointerover", 0); fire("pointerenter", 0, false); fire("mouseover", 0); fire("mouseenter", 0, false);
    fire("pointermove", 0); fire("mousemove", 0);
    // A cancelled pointerdown suppresses the mouse events after it, not the click.
    const mouseEvents = fire("pointerdown", 1);
    if (mouseEvents && fire("mousedown", 1)) {
      const focusable = 'a[href],area[href],button,input,select,textarea,summary,iframe,[tabindex],[contenteditable]:not([contenteditable="false"])';
      let n: Element | null | undefined = at;
      while (n && !(n.matches(focusable) && !n.matches(":disabled"))) n = n.parentElement || (n.parentNode as ShadowRoot | null)?.host;
      if (n) (n as HTMLElement).focus({ preventScroll: true });
      else (document.activeElement as HTMLElement | null)?.blur?.();
    }
    fire("pointerup", 0);
    if (mouseEvents) fire("mouseup", 0);
    fire("click", 0);
    return true;
  }

  /**
   * Shows what Zipline is about to touch: a ring around the element, a label
   * for the action and a ripple at the click point. Drawn in a shadow root with
   * pointer-events off, so it never intercepts input or reads as a control.
   */
  function markTarget(t: Target, label: string): boolean {
    document.getElementById("zipline-action")?.remove();
    const host = document.createElement("div");
    host.id = "zipline-action";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const root = host.attachShadow({ mode: "open" });
    // Built without innerHTML: pages that enforce Trusted Types (Google Flights)
    // reject HTML strings, and a constructed stylesheet is not blocked by CSP.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(".ring{position:fixed;border-radius:10px;outline:3px solid #2cc4ad;outline-offset:4px;background:rgba(44,196,173,.12);box-shadow:0 0 24px 4px rgba(44,196,173,.55);animation:in .18s ease-out}" +
      ".tag{position:fixed;transform:translateY(-100%);margin-top:-10px;padding:3px 9px;border-radius:999px;background:#0f9d8a;color:#fff;" +
      "font:600 12px/1.4 system-ui,-apple-system,sans-serif;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.35);max-width:420px;overflow:hidden;text-overflow:ellipsis}" +
      ".dot{position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(183,227,77,.9);animation:ripple .6s ease-out forwards}" +
      "@keyframes in{from{opacity:0;transform:scale(1.06)}}" +
      "@keyframes ripple{to{transform:scale(3.2);opacity:0}}" +
      ".fade{transition:opacity .35s ease;opacity:0}");
    root.adoptedStyleSheets = [sheet];
    const [ring, tag, dot] = ["ring", "tag", "dot"].map((name) => {
      const el = document.createElement("div");
      el.className = name;
      root.append(el);
      return el;
    }) as [HTMLDivElement, HTMLDivElement, HTMLDivElement];
    Object.assign(ring.style, { left: t.rect.left + "px", top: t.rect.top + "px", width: t.rect.width + "px", height: t.rect.height + "px" });
    Object.assign(tag.style, { left: t.rect.left + "px", top: t.rect.top + "px" });
    Object.assign(dot.style, { left: t.x + "px", top: t.y + "px" });
    tag.textContent = "⚡ " + label;
    document.documentElement.append(host);
    setTimeout(() => root.querySelectorAll(".ring,.tag").forEach((e) => e.classList.add("fade")), 650);
    setTimeout(() => host.remove(), 1100);
    return true;
  }

  const e = window.__glinerFast?.nodes.get(action.node!);
  if (action.offscreen && e?.isConnected) {
    e.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!e?.isConnected || e.matches(":disabled") || e.closest('[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  if (action.kind === "fill" && ((e as HTMLInputElement).readOnly || e.getAttribute("aria-readonly") === "true")) return false;
  const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
  if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner; }
  const path: Node[] = [];
  for (let n: Node | null | undefined = hit; n; n = (n as Element).parentElement || (n.parentNode as ShadowRoot | null)?.host) path.push(n);
  if (!path.includes(e)) return false;
  if (action.kind === "select") {
    const select = e as HTMLSelectElement;
    if (e.tagName !== "SELECT" || ![...select.options].some((o) => o.value === action.value && !o.disabled && !o.closest("optgroup[disabled]"))) return false;
    select.value = action.value!;
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (label) {
    try {
      markTarget({ x, y, rect: { left: r.left, top: r.top, width: r.width, height: r.height } }, label);
    } catch {
      // the outline is only feedback
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  if (action.kind !== "select") clickAt(x, y);
  return true;
}

/**
 * Replaces the text of a field. execCommand inserts like typing, with the
 * beforeinput and input events React, Angular and editors listen for. When it
 * cannot, the value goes in through the native setter, past React's value
 * tracker, so React still sees a change on the input event. Returns null when
 * there is no editable target. A password field takes text only when it is
 * the target, and focus never moves text into or out of one.
 */
export function fillField(node: number, text: string): string | null {
  const target = window.__glinerFast?.nodes.get(node);
  if (!target?.isConnected) return null;
  const parent = (e: Element) => e.parentElement || (e.parentNode as ShadowRoot | null)?.host || null;
  const within = (e: Element, box: Element) => { for (let n: Element | null = e; n; n = parent(n)) if (n === box) return true; return false; };
  const editable = (e: Element | null | undefined): e is HTMLElement =>
    e instanceof HTMLTextAreaElement || (e instanceof HTMLInputElement && /^(text|search|email|url|tel|number|password|date|)$/.test(e.type)) ||
    (e instanceof HTMLElement && !(e instanceof HTMLInputElement) && e.isContentEditable);
  // Type where focus is, as CDP Input.insertText did: clicking a field often
  // moves focus to a new input (an overlay or combobox). Use that input only
  // when it belongs to the target: inside it, inside a popup it names with
  // aria-controls or aria-owns, or inside a dialog or listbox that took focus
  // on this click. Else type into the observed field.
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  const owned = (e: Element) => {
    for (let n: Element | null = target; n; n = parent(n)) {
      const root = n.getRootNode() as Document | ShadowRoot;
      for (const id of `${n.getAttribute("aria-controls") ?? ""} ${n.getAttribute("aria-owns") ?? ""}`.split(/\s+/)) {
        const box = id && root.getElementById(id);
        if (box && within(e, box)) return true;
      }
    }
    return false;
  };
  const popup = (e: Element) => e !== window.__focusBeforeClick &&
    !!e.closest('dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="listbox"]');
  const secret = (e: Element) => e instanceof HTMLInputElement && e.type === "password";
  const field = editable(active) && secret(active) === secret(target) &&
    (within(active, target) || owned(active) || popup(active)) ? active : target;
  if (!editable(field)) return null;
  const plain = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement;
  const read = () => (plain ? field.value : field.textContent ?? "");
  field.focus({ preventScroll: true });
  if (plain) field.select();
  else getSelection()?.selectAllChildren(field);
  const before = read();
  const inserted = document.execCommand(text ? "insertText" : "delete", false, text);
  if (!inserted || (read() === before && before !== text)) {
    if (plain) {
      const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, text);
    } else field.textContent = text;
    field.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return read();
}

/**
 * Presses a key on the focused element. Enter in a form field also does the
 * browser's implicit submission, unless the page handled the key or already
 * submitted or navigated by itself. Tab does not move focus.
 */
export function pressKey(key: string): boolean {
  const codes: Record<string, number> = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38 };
  const keyCode = codes[key] ?? 0;
  let target: Element = document.activeElement ?? document.body;
  while (target.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
  const init = { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true, view: window };
  const href = location.href;
  let submitted = false;
  const onSubmit = () => { submitted = true; };
  addEventListener("submit", onSubmit, true);
  try {
    const down = target.dispatchEvent(new KeyboardEvent("keydown", init));
    const press = down && key === "Enter" && target.dispatchEvent(new KeyboardEvent("keypress", { ...init, charCode: 13 }));
    const form = target instanceof HTMLInputElement ? target.form : null;
    if (press && form && !submitted && location.href === href) {
      const button = [...form.elements].find((e): e is HTMLButtonElement | HTMLInputElement =>
        (e instanceof HTMLButtonElement || e instanceof HTMLInputElement) && (e.type === "submit" || e.type === "image"));
      // HTML implicit submission: with no submit button, Enter submits only
      // when the form has at most one field that blocks it.
      const blocking = /^(text|search|url|tel|email|password|date|month|week|time|datetime-local|number)$/;
      const blockers = [...form.elements].filter((e) => e instanceof HTMLInputElement && blocking.test(e.type)).length;
      if (button) { if (!button.disabled) button.click(); }
      else if (blockers <= 1) form.requestSubmit();
    }
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  } finally {
    removeEventListener("submit", onSubmit, true);
  }
  return true;
}

/** Scrolls what a wheel at the old CDP point (550, 650) would scroll: the nearest scrollable box, else the page. */
export function scrollAt(delta: number): boolean {
  let n = document.elementFromPoint(Math.min(550, innerWidth - 1), Math.min(650, innerHeight - 1));
  for (; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    const room = delta > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0;
    if (room && /auto|scroll|overlay/.test(getComputedStyle(n).overflowY)) {
      n.scrollBy({ top: delta, behavior: "instant" });
      return true;
    }
  }
  scrollBy({ top: delta, behavior: "instant" });
  return true;
}
