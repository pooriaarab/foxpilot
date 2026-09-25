// Opens the bench page in Chromium with WebGPU and prints its log.
import { chromium } from "../../ad-spotter/node_modules/playwright/index.mjs";

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
const url = `http://localhost:5401/?dtype=${process.argv[2] ?? "fp16"}${process.argv[3] ? `&model=${process.argv[3]}` : ""}`;
await page.goto(url);
await page.waitForFunction(() => /DONE|ERROR/.test(document.getElementById("log")?.textContent ?? ""), null, { timeout: 600_000 });
console.log(await page.locator("#log").textContent());
await browser.close();
