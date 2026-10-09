// Underlines personal data in the chat composer as you type. The shape rules
// (text/ask.ts) mark emails, phones and cards at once; GLiNER2 in the
// background page then adds names, addresses and the rest. The text goes to
// this add-on's background page only. The marks are boxes in a layer over the
// page, so the composer DOM stays as the site made it.
//
// One listener on the document finds the composer from each input event, so a
// site that replaces its composer element needs no new listener.
//
// When marked spans exist, Enter and the site's send button stop in the capture
// phase, and a prompt offers "Redact and send", "Send anyway" or "Cancel".
import { remoteScorer } from "@foxpilot/core/model/host";
import type { Labels } from "@foxpilot/core/model/scorer";
import { SHAPES, type Kind } from "@foxpilot/core/text/ask";

type Span = { type: string; start: number; end: number; text: string; by: "shape" | "model" };
type Composer = HTMLTextAreaElement | HTMLInputElement | HTMLElement;
type Read = { text: string; nodes: { node: Text; at: number }[] };
/** "empty": no text. "shapes": the model has not answered yet. "shapes-only": the model failed. */
type State = "empty" | "shapes" | "shapes-only" | "model";

/** Email and card numbers come from the shape rules only: they are exact there, and the model guesses. */
const LABELS: Labels = {
  "person name": "first or last name of a person",
  phone: "phone number",
  "street address": "street or postal address of a home or office",
  "ID number": "passport, social security, licence, tax or account number",
  "date of birth": "the date a person was born",
  "health condition": "illness, diagnosis, medication or medical condition",
};
const DEBOUNCE_MS = 300;
/** The shape rules read this much text. Text past it gets no marks. */
const MAX_CHARS = 20_000;
/** GLiNER2.5 small reads about 512 tokens; the labels take part of them. */
const MAX_MODEL_CHARS = 1_500;
/** A code is an ID number only after words like these ("passport no. X12-55"); else it is a product code. */
const ID_BEFORE = /\b(?:id|passport|licen[cs]e|ssn|social security|insurance|account|member|patient|policy|tax)\b[^.!?\n]{0,24}$/i;
const SHAPE_TYPE: Partial<Record<Kind, string>> = {
  email: "email", card: "card number", phone: "phone", cvv: "card number", expiry: "card number", zip: "street address", code: "ID number",
};
/** Redact puts [TAG_n] in place of each span. One value keeps one number. */
const TAGS: Record<string, string> = {
  "person name": "NAME", email: "EMAIL", phone: "PHONE", "card number": "CARD", "street address": "ADDRESS", "ID number": "ID", "date of birth": "DOB", "health condition": "HEALTH",
};
/** The send button on the supported sites (ChatGPT: data-testid; Claude, Gemini: "Send message"; Copilot, Perplexity: "Submit"). */
const SEND = '[data-testid="send-button"], button[aria-label*="send" i], button[aria-label*="submit" i]';
/** After a guarded send, the prompt waits this long at most for the model (warm call about 205 ms). */
const WAIT_MS = 400;
const BLOCKS = new Set(["P", "DIV", "LI", "BR", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "BLOCKQUOTE"]);

const scorer = remoteScorer();
const layer = document.createElement("div");
layer.id = "pii-guard-layer";
layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
let mirror: HTMLDivElement | undefined;
let current: { composer: Composer; text: string; spans: Span[] } | undefined;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let pending: Composer | undefined;
let sentCount = -1;
/** The send that waits for the user's choice. */
let held: { composer: Composer; replay: () => void } | undefined;
let replaying = false;
let host: HTMLDivElement | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The editable element an input event came from, or null. */
function composerOf(target: EventTarget | null): Composer | null {
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement) return target.type === "text" || target.type === "search" ? target : null;
  if (!(target instanceof HTMLElement) || !target.isContentEditable) return null;
  let host = target;
  while (host.parentElement?.isContentEditable) host = host.parentElement;
  return host;
}

const isField = (c: Composer): c is HTMLTextAreaElement | HTMLInputElement =>
  c instanceof HTMLTextAreaElement || c instanceof HTMLInputElement;

/** The composer text, and where each text node starts in it. A block or <br> adds "\n". */
function read(composer: Composer): Read {
  if (isField(composer)) return { text: composer.value.slice(0, MAX_CHARS), nodes: [] };
  const nodes: Read["nodes"] = [];
  let text = "";
  const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n && text.length < MAX_CHARS; n = walker.nextNode()) {
    if (n instanceof Text) {
      nodes.push({ node: n, at: text.length });
      text += n.data;
    } else if (BLOCKS.has((n as Element).tagName) && text && !text.endsWith("\n")) text += "\n";
  }
  // A trailing <br> or empty block is not text.
  return { text: text.slice(0, MAX_CHARS).replace(/\n+$/, ""), nodes };
}

function shapes(text: string): Span[] {
  const spans: Span[] = [];
  for (const [kind, shape] of SHAPES) {
    const type = SHAPE_TYPE[kind];
    if (!type) continue;
    for (const m of text.matchAll(shape)) {
      const start = m.index + (m[1] ? m[0].indexOf(m[1]) : 0);
      const value = m[1] ?? m[0];
      if (kind === "code" && !ID_BEFORE.test(text.slice(Math.max(0, start - 40), start))) continue;
      spans.push({ type, start, end: start + value.length, text: value, by: "shape" });
    }
  }
  return spans;
}

/** The model marks some span for most labels ("I" as a name, "3pm" as a phone). Keep the ones with the right shape. */
function plausible(type: string, span: string, before: string): boolean {
  const digits = span.replace(/\D/g, "").length;
  if (type === "person name") return span.split(/\s+/).every((word) => /^\p{Lu}/u.test(word) && /\p{Ll}/u.test(word));
  if (type === "phone") return digits >= 10;
  if (type === "ID number") return digits >= 4 && ID_BEFORE.test(before);
  if (type === "date of birth") return digits > 0;
  return true;
}

/** The model's plausible spans, minus the ones that overlap a shape span or a longer model span. */
function merge(shaped: Span[], found: Record<string, { text: string; start?: number }[]>, text: string): Span[] {
  const spans = [...shaped];
  const free = (s: number, e: number) => spans.every((x) => e <= x.start || s >= x.end);
  const model = Object.entries(found).flatMap(([type, list]) => list.map((e) => {
    const start = e.start ?? text.indexOf(e.text);
    return { type, start, end: Math.min(text.length, start + e.text.length), text: e.text, by: "model" as const };
  }));
  const kept = model.filter((s) => s.start >= 0 && plausible(s.type, s.text, text.slice(0, s.start)));
  for (const span of kept.sort((a, b) => b.end - b.start - (a.end - a.start))) {
    if (free(span.start, span.end)) spans.push(span);
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** extractEntities, once more when the port closed (the event page unloaded or restarted). */
async function extract(text: string) {
  try {
    return await scorer.extractEntities(text, LABELS);
  } catch (error) {
    if (!/disconnect/i.test(String(error))) throw error;
    return scorer.extractEntities(text, LABELS);
  }
}

/** Cut at the last space before the limit, so the model gets no half word. */
function cut(text: string): string {
  if (text.length <= MAX_MODEL_CHARS) return text;
  const space = text.lastIndexOf(" ", MAX_MODEL_CHARS);
  return text.slice(0, space > 0 ? space : MAX_MODEL_CHARS);
}

async function detect(composer: Composer) {
  const id = ++seq;
  const { text } = read(composer);
  current = { composer, text, spans: [] };
  if (!text.trim()) return show(id, [], "empty");
  const shaped = shapes(text);
  show(id, shaped, "shapes");
  const modelText = cut(text);
  const started = performance.now();
  try {
    const found = await extract(modelText);
    layer.dataset.modelMs = String(Math.round(performance.now() - started));
    show(id, merge(shaped, found, modelText), "model");
  } catch (error) {
    console.warn("[pii-guard] model unavailable, shape rules only:", error);
    // Kept for the E2E report: why the model did not answer.
    layer.dataset.modelError = String(error instanceof Error ? error.message : error).slice(0, 300);
    show(id, shaped, "shapes-only");
  }
}

function show(id: number, spans: Span[], state: State) {
  if (id !== seq || !current) return;
  current.spans = spans;
  // The E2E runner (apps/pii-guard/e2e/run.mjs) reads these. The page already has the text.
  Object.assign(layer.dataset, { seq: String(id), state, length: String(current.text.length), spans: JSON.stringify(spans), truncated: String(current.text.length > MAX_MODEL_CHARS) });
  draw();
  if (spans.length !== sentCount) {
    sentCount = spans.length;
    chrome.runtime.sendMessage({ type: "pii-count", count: spans.length }).catch(() => {});
  }
}

/** A hidden copy of a textarea at the same place, so a Range can measure where its text sits. */
function measure(field: HTMLTextAreaElement | HTMLInputElement): Text {
  mirror ??= layer.appendChild(document.createElement("div"));
  const style = getComputedStyle(field);
  const box = field.getBoundingClientRect();
  // Longhands only: a computed shorthand can read as "".
  for (const p of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "wordSpacing", "lineHeight", "textIndent", "tabSize", "boxSizing",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"] as const) {
    mirror.style[p] = style[p];
  }
  Object.assign(mirror.style, {
    position: "fixed", visibility: "hidden", overflow: "hidden", borderStyle: "solid", borderColor: "transparent",
    whiteSpace: field instanceof HTMLTextAreaElement ? "pre-wrap" : "pre", overflowWrap: "break-word",
    left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`,
  });
  mirror.textContent = field.value.slice(0, MAX_CHARS);
  mirror.scrollTop = field.scrollTop;
  mirror.scrollLeft = field.scrollLeft;
  return (mirror.firstChild ?? mirror.appendChild(document.createTextNode(""))) as Text;
}

function rangeFor(composer: Composer, span: Span): Range | null {
  const range = document.createRange();
  if (isField(composer)) {
    const node = measure(composer);
    range.setStart(node, Math.min(span.start, node.length));
    range.setEnd(node, Math.min(span.end, node.length));
    return range;
  }
  const { nodes } = read(composer);
  const place = (offset: number, end: boolean) => {
    let hit = nodes[0];
    for (const n of nodes) if (end ? n.at < offset : n.at <= offset) hit = n;
    return hit && ([hit.node, Math.min(offset - hit.at, hit.node.length)] as const);
  };
  const [from, to] = [place(span.start, false), place(span.end, true)];
  if (!from || !to) return null;
  range.setStart(...from);
  range.setEnd(...to);
  return range;
}

/** Puts one box under each line of each span, clipped to the composer. */
function draw() {
  for (const box of [...layer.querySelectorAll(".pii-mark")]) box.remove();
  if (!current?.composer.isConnected) return;
  if (!layer.isConnected) document.documentElement.append(layer);
  const clip = current.composer.getBoundingClientRect();
  for (const span of current.spans) {
    for (const r of rangeFor(current.composer, span)?.getClientRects() ?? []) {
      if (r.bottom < clip.top || r.top > clip.bottom || r.right < clip.left || r.left > clip.right) continue;
      const box = layer.appendChild(document.createElement("div"));
      box.className = "pii-mark";
      box.title = span.type;
      box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;` +
        `border-bottom:2px solid #c50042;background:rgba(197,0,66,${span.by === "shape" ? 0.14 : 0.08});`;
    }
  }
}

function schedule(composer: Composer) {
  clearTimeout(timer);
  pending = composer;
  timer = setTimeout(() => void detect(composer), DEBOUNCE_MS);
}

document.addEventListener("input", (event) => {
  const composer = composerOf(event.target);
  if (composer) schedule(composer);
}, true);
// The site can re-render the composer (new text nodes, a new element) or move it. Redraw, or detect again if the text changed.
// A detached composer clears the marks; the next input in the new one detects again.
let frame = 0;
const redraw = () => {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    if (current && !current.composer.isConnected) {
      if (pending === current.composer) clearTimeout(timer);
      current.text = "";
      show(++seq, [], "empty");
      current = undefined;
    } else if (current && read(current.composer).text !== current.text) schedule(current.composer);
    else draw();
  });
};
new MutationObserver(redraw).observe(document.body, { childList: true, subtree: true, characterData: true });
addEventListener("scroll", redraw, true);
addEventListener("resize", redraw);

type Choice = "redact" | "send" | "cancel";
type Now = { text: string; spans: Span[]; answered: boolean };

/** Keeps the longest of overlapping spans, so a redaction never cuts into another one. */
function disjoint(spans: Span[]): Span[] {
  const kept: Span[] = [];
  for (const s of [...spans].sort((a, b) => b.end - b.start - (a.end - a.start))) {
    if (kept.every((k) => s.end <= k.start || s.start >= k.end)) kept.push(s);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * The spans for the composer text now. When the model has not answered for this text, the shape
 * spans count, plus earlier model spans whose text is still at the same place.
 */
function spansNow(composer: Composer): Now {
  const { text } = read(composer);
  const mine = current?.composer === composer ? current : undefined;
  if (mine?.text === text) return { text, spans: mine.spans, answered: layer.dataset.state === "model" || layer.dataset.state === "shapes-only" };
  const kept = (mine?.spans ?? []).filter((s) => s.by === "model" && text.slice(s.start, s.end) === s.text);
  return { text, spans: disjoint([...shapes(text), ...kept]), answered: false };
}

/**
 * Stops a send when the composer has marked spans. A send with no spans goes on at once, with no wait.
 * The choice to stop is made on the spans known now: the shape spans, or the model's when it answered.
 * The model only waits (WAIT_MS at most) after the send stops, to add names to the prompt. So a message
 * with a name and no shape, sent before the model answers (about 0.5 s after the last key), is not stopped.
 */
function guard(event: Event, composer: Composer, replay: () => void) {
  if (replaying) return;
  if (!held) {
    const now = spansNow(composer);
    if (!now.spans.length) return;
    held = { composer, replay };
    void decide(held, now);
  }
  event.preventDefault();
  event.stopImmediatePropagation();
}

async function decide(send: NonNullable<typeof held>, now: Now) {
  let { spans } = now;
  if (!now.answered) {
    clearTimeout(timer);
    await Promise.race([detect(send.composer), sleep(WAIT_MS)]);
    const later = spansNow(send.composer);
    if (later.answered && later.text === now.text) spans = disjoint([...spans, ...later.spans]);
  }
  let note = "";
  for (;;) {
    const choice = await choose(send.composer, spans, note);
    if (choice === "redact") {
      redact(send.composer, disjoint(spans));
      // Give the site one frame to take the change into its own state.
      await new Promise((r) => requestAnimationFrame(r));
      const after = read(send.composer).text;
      if (after === now.text || spans.some((s) => after.includes(s.text))) {
        layer.dataset.decision = "redact-failed";
        note = "PII Guard could not change the text in this composer. Edit it yourself, or choose below.";
        continue;
      }
    }
    held = undefined;
    layer.dataset.decision = choice;
    send.composer.focus();
    if (choice === "cancel") return;
    replaying = true;
    try {
      send.replay();
    } finally {
      replaying = false;
    }
    return;
  }
}

function tagged(spans: Span[]): { tag: string; span: Span }[] {
  const named = new Map<string, string>();
  const counts: Record<string, number> = {};
  return spans.map((span) => {
    const type = TAGS[span.type] ?? "PII";
    const key = `${type}:${span.text}`;
    if (!named.has(key)) named.set(key, `[${type}_${(counts[type] = (counts[type] ?? 0) + 1)}]`);
    return { tag: named.get(key)!, span };
  });
}

/** Puts a tag in place of each span, last span first so the earlier offsets stay true. */
function redact(composer: Composer, spans: Span[]) {
  const swaps = tagged(spans).reverse();
  if (isField(composer)) {
    let value = composer.value;
    for (const { tag, span } of swaps) value = value.slice(0, span.start) + tag + value.slice(span.end);
    // The prototype setter: a framework that wraps the element's own setter (React) then sees the input event as a change.
    const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(composer, value);
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }));
    return;
  }
  composer.focus();
  const selection = getSelection();
  for (const { tag, span } of swaps) {
    const range = rangeFor(composer, span);
    if (!range || !selection) continue;
    selection.removeAllRanges();
    selection.addRange(range);
    // insertText fires beforeinput and input, so ProseMirror and other editors update their own state.
    document.execCommand("insertText", false, tag);
  }
}

/** Shows the choice over the composer, in a shadow root in the layer, and waits for it. Escape cancels. */
function choose(composer: Composer, spans: Span[], note: string): Promise<Choice> {
  if (!layer.isConnected) document.documentElement.append(layer);
  host ??= Object.assign(layer.appendChild(document.createElement("div")), { className: "pii-prompt" });
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const box = composer.getBoundingClientRect();
  const panel = document.createElement("div");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "PII Guard");
  panel.style.cssText = `position:fixed;left:${Math.max(8, box.left)}px;top:${Math.max(8, box.top - 8)}px;transform:translateY(-100%);` +
    "pointer-events:auto;max-width:420px;padding:10px 12px;border-radius:10px;background:#fff;color:#15141a;" +
    "box-shadow:0 2px 12px rgba(0,0,0,.25);font:14px/1.4 system-ui,sans-serif;";
  const text = panel.appendChild(document.createElement("p"));
  text.style.margin = "0 0 8px";
  text.textContent = note || `This message has personal data: ${[...new Set(spans.map((s) => s.type))].join(", ")}.`;
  const actions: [Choice, string][] = [["redact", "Redact and send"], ["send", "Send anyway"], ["cancel", "Cancel"]];
  layer.dataset.prompt = "open";
  return new Promise((resolve) => {
    const done = (choice: Choice) => {
      root.replaceChildren();
      layer.dataset.prompt = "closed";
      resolve(choice);
    };
    for (const [choice, label] of actions.filter(([c]) => !note || c !== "redact")) {
      const button = panel.appendChild(document.createElement("button"));
      button.dataset.action = choice;
      button.textContent = label;
      button.style.cssText = "margin-right:6px;padding:4px 10px;font:inherit;cursor:pointer;";
      button.addEventListener("click", () => done(choice));
    }
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") done("cancel");
    });
    root.replaceChildren(panel);
    panel.querySelector("button")?.focus();
  });
}

// Window capture phase, so the guard runs before the site's own Enter and click handlers.
addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  const composer = composerOf(event.target);
  if (!composer) return;
  guard(event, composer, () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true })));
}, true);
addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLElement>(SEND) : null;
  const composer = current?.composer;
  if (!button || !composer?.isConnected) return;
  // The site can re-render its send button after a redaction.
  guard(event, composer, () => (button.isConnected ? button : document.querySelector<HTMLElement>(SEND))?.click());
}, true);
