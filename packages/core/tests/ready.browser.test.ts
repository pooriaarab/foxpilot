// ready() in Chromium: waits for results to finish drawing, never longer than its cap.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ready } from "@foxpilot/core/page/ready";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

async function wait(html: string, cap: number) {
  const page = await browser.newPage();
  await page.setContent(html);
  return page.evaluate(async ([fn, cap]) => {
    const t = performance.now(); await (0, eval)(fn as string)(cap); return performance.now() - t;
  }, [`(${ready})`, cap] as const);
}

it("returns at once on a page that is quiet and shows no progress bar", async () => {
  expect(await wait("<p>Results</p>", 3000)).toBeLessThan(600);
});

it("hits the cap on a page that never goes quiet", async () => {
  const ms = await wait("<div id=t></div><script>setInterval(()=>t.textContent=Date.now(),50)</script>", 1000);
  expect(ms).toBeGreaterThanOrEqual(950);
  expect(ms).toBeLessThan(1500);
});

it("hits the cap on a progress bar that never leaves", async () => {
  const ms = await wait('<div role="progressbar" style="width:50px;height:5px"></div>', 800);
  expect(ms).toBeGreaterThanOrEqual(750);
  expect(ms).toBeLessThan(1300);
});

it("waits for a progress bar to leave, then for quiet", async () => {
  const ms = await wait('<div id=p role="progressbar" style="width:50px;height:5px"></div><script>setTimeout(()=>p.remove(),1000)</script>', 3000);
  expect(ms).toBeGreaterThan(1000);
  expect(ms).toBeLessThan(1800);
});
