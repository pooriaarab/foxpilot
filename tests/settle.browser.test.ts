// SETTLE in Chromium: after a picker's "Done", the page is read once the picker has gone.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { SETTLE } from "../src/agent/settle";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const PAGE = `<div role="dialog" id="d" style="transition:opacity .4s"><div role="grid"><div role="gridcell">Friday, October 2, 2026</div></div>
  <button id="done">Done</button></div>
  <script>document.getElementById('done').onclick=()=>{const d=document.getElementById('d');d.style.opacity='0';setTimeout(()=>d.remove(),450)};
  window.__glinerFast={nodes:new Map([[1,document.getElementById('done')],[2,document.querySelector('[role=gridcell]')]])};</script>`;

it("waits for a closing picker, not for a click on a day", async () => {
  const page = await browser.newPage();
  await page.setContent(PAGE);
  const day = await page.evaluate(async (settle) => {
    const t = performance.now(); await (0, eval)(settle)({ kind: "click", node: 2 }); return performance.now() - t;
  }, SETTLE);
  expect(day).toBeLessThan(300);
  const done = await page.evaluate(async (settle) => {
    document.getElementById("done")!.click();
    const t = performance.now(); await (0, eval)(settle)({ kind: "click", node: 1 });
    return { ms: performance.now() - t, open: !!document.getElementById("d") && parseFloat(getComputedStyle(document.getElementById("d")!).opacity) >= 0.05 };
  }, SETTLE);
  expect(done.ms).toBeGreaterThan(300);
  expect(done.ms).toBeLessThan(900);
  expect(done.open).toBe(false);
});
