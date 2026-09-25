// After a run: find the block on the page that answers the goal and outline it.
// Candidates are the page's visible text blocks; GLiNER2 scores each as the
// the answer card vs. questions, links, social posts, ads and page chrome;
// among the ones that look like answers, a second call asks which one the
// goal refers to. Nothing is highlighted below 0.5.
import type { TabBrowser } from "./browser";
import type { Scorer } from "./controller";

export type Answer = { text: string; score: number };

const MAX_CANDIDATES = 24;

/** Collects visible text blocks (20–500 chars, the largest that are not a list of pieces) near the top. */
const COLLECT = `(() => {
  document.getElementById('zipline-answer')?.remove();
  // A run often ends on exploratory scrolls; the answer is usually near the top.
  scrollTo(0, 0);
  const limit = innerHeight * 2.2;
  const text = e => (e.innerText || '').replace(/\\s+/g, ' ').trim();
  const out = [];
  const visit = e => {
    if (out.length >= ${MAX_CANDIDATES}) return;
    const r = e.getBoundingClientRect();
    if (r.bottom < 0 || r.top > limit || r.width < 40 || r.height < 16) return;
    if (!e.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})) return;
    if (e.closest('nav,header,footer,[role="navigation"],[role="banner"],[role="contentinfo"],form,[role="search"]')) return;
    const t = text(e);
    if (t.length < 20) return;
    // A long block made of two or more substantial pieces (a card and a result)
    // is split; a short one (a single card or result with its lines) is not.
    const pieces = [...e.children].filter(c => text(c).length >= 20).length;
    if (t.length <= 500 && (pieces < 2 || t.length <= 280)) { out.push(e); return; }
    for (const child of e.children) visit(child);
  };
  for (const child of document.body.children) visit(child);
  window.__ziplineBlocks = out;
  return out.map((e, i) => ({ i, text: text(e).slice(0, 300) }));
})()`;

const HIGHLIGHT = (index: number) => `((index) => {
  const e = window.__ziplineBlocks?.[index];
  if (!e) return false;
  e.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const host = document.createElement('div');
  host.id = 'zipline-answer';
  host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' +
    '.box{position:absolute;border-radius:14px;outline:3px solid #2cc4ad;outline-offset:6px;' +
    'box-shadow:0 0 0 9999px rgba(8,10,12,.28),0 0 42px 8px rgba(44,196,173,.55);transition:all .35s ease;animation:pulse 1.6s ease-in-out 2}' +
    '@keyframes pulse{50%{box-shadow:0 0 0 9999px rgba(8,10,12,.28),0 0 64px 16px rgba(183,227,77,.6)}}' +
    '.chip{position:absolute;transform:translateY(-100%);margin-top:-12px;padding:5px 11px;border-radius:999px;' +
    'background:linear-gradient(135deg,#0f9d8a,#b7e34d);color:#06201c;font:700 13px/1.2 system-ui,-apple-system,sans-serif;' +
    'box-shadow:0 6px 20px rgba(0,0,0,.35);white-space:nowrap}' +
    '</style><div class="box"></div><div class="chip">✦ Zipline found this</div>';
  document.body.append(host);
  const place = () => {
    const r = e.getBoundingClientRect();
    const box = root.querySelector('.box'), chip = root.querySelector('.chip');
    Object.assign(box.style, { left: r.left + scrollX + 'px', top: r.top + scrollY + 'px', width: r.width + 'px', height: r.height + 'px' });
    Object.assign(chip.style, { left: r.left + scrollX + 'px', top: r.top + scrollY + 'px' });
  };
  place();
  addEventListener('resize', place);
  new ResizeObserver(place).observe(e);
  // Dismiss on the first click anywhere.
  addEventListener('pointerdown', () => host.remove(), { once: true });
  return true;
})(${index})`;

/** Candidate scores from the last search, for debugging. */
export let lastScores: { text: string; score: number }[] = [];

export async function findAnswer(browser: TabBrowser, model: Scorer, goal: string): Promise<Answer | null> {
  const blocks = await browser.evaluate<{ i: number; text: string }[]>(COLLECT);
  if (!blocks?.length) return null;
  // Naming what an answer card is, and what the other blocks are, matters: with
  // just "answer vs other", anything about the topic ("People also ask …")
  // scored as the answer. Measured on a real results page: card 1.00, next 0.81.
  const labels = {
    answer: `the answer card: the facts or figures that answer "${goal}" directly on this page`,
    questions: "a list of questions or related searches",
    link: "a search result linking to another site, with a title and snippet",
    social: "a social media post or profile",
    ad: "an ad or sponsored offer",
    other: "navigation, menus or page chrome",
  };
  let best: { i: number; text: string; score: number } | null = null;
  const scored: { text: string; score: number }[] = [];
  const blocksWithScores: { i: number; text: string; score: number }[] = [];
  for (const block of blocks) {
    const probabilities = await model.classify(block.text, "answer", labels);
    const score = probabilities.answer ?? 0;
    scored.push({ text: block.text.slice(0, 80), score });
    blocksWithScores.push({ ...block, score });
    if (!best || score > best.score) best = { ...block, score };
  }
  lastScores = scored;
  if (!best || best.score < 0.5) return null;

  // Round 2: several blocks can all look like "facts and figures" (a price, a
  // chart's stats, related tickers). Ask which one the goal refers to, the way
  // the agent matches a requirement to controls: goal as text, blocks as labels.
  const finalists = blocksWithScores
    .filter((b) => b.score >= Math.min(0.9, best!.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  if (finalists.length > 1) {
    const byLabel = new Map<string, (typeof finalists)[number]>();
    for (const f of finalists) {
      const label = f.text.slice(0, 90);
      if (!byLabel.has(label)) byLabel.set(label, f);
    }
    const probabilities = await model.classify(
      `the answer to: ${goal}`, "answer", Object.fromEntries([...byLabel.keys()].map((l) => [l, undefined])),
    );
    const [label] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
    best = byLabel.get(label) ?? best;
  }
  await browser.evaluate(HIGHLIGHT(best.i));
  return { text: best.text, score: best.score };
}

/** Removes a previous run's highlight. */
export const CLEAR = `document.getElementById('zipline-answer')?.remove()`;
