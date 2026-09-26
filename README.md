# Zipline

A browser agent that runs entirely on your device. Type a goal in the side panel; [GLiNER2](https://github.com/fastino-ai/GLiNER2) runs on your GPU with WebGPU, reads the page and drives it until the goal is done. No server, no API key, nothing about the page or your goal leaves the browser.

On Google Flights, "Find a one-way ticket from New York to San Francisco on October 9, 2026. I prefer the cheapest nonstop morning flight." takes 10 actions and about 16 seconds: ticket type, both cities with their autocompletes, the date in the calendar, Search. Then it checks the results page against every part of the goal and highlights the cheapest nonstop that leaves in the morning.

## How it works

It is a port of [gliner2-ultrafast](https://github.com/sahibzada-allahyar/gliner2-ultrafast) (MIT) from Python to a Chrome extension:

- **GLiNER2 decides.** One model, [`fastino/gliner2-multi-v1`](https://huggingface.co/fastino/gliner2-multi-v1), does both jobs: it extracts values from the goal ("New York", "October 9, 2026") and scores the page's controls against each part of the goal. It runs as a single ONNX graph ([`onnx-community/gliner2-multi-v1-agent-ONNX`](https://huggingface.co/onnx-community/gliner2-multi-v1-agent-ONNX), 614 MB at fp16) in about 40 ms per call on an M-series Mac.
- **Code controls.** Requirement order, one-to-one matching of requirements to controls, autocompletes, calendars, form submission and termination are explicit rules, ported from the Python controller (`src/agent/controller.ts`). The model picks among observed controls; it never writes selectors or code.
- **Chrome acts.** The page is read with the original `snapshot.js`, and clicks and typing are sent through `chrome.debugger` with the same DevTools Protocol calls the Python version sends. Before every action it checks the page has not changed since the decision.
- **Field text, two ways.** By default it types the value GLiNER extracted for that part of the goal. Switch on *Local LLM* and Qwen3-0.6B (WebGPU, about 0.5 GB) writes the value instead, from the goal, the requirement and GLiNER's candidates.

**Checked, not assumed.** "Done" only means the controller found nothing left to do. Afterwards Zipline checks the finished page against each part of the goal and shows a checklist: a form field holding each value ("Where from?: New York", "Departure: Fri, Oct 9"), a control showing each setting (GLiNER2 picks "one-way ticket" out of the goal; the page shows "Change ticket type. One way"), the form actually sent, and not an error, empty or captcha page. The page's own form counts over cards beside it that name the same words. The answer is highlighted only on a verified page. It checks what the page's form says, not whether the results below it match.

The tab being driven goes into a **Zipline** tab group whose title shows the run: ⚡ step N, ✅ done with the time, ⛔ blocked.

## Try it

```bash
pnpm install
pnpm build            # writes dist/
```

1. Open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked** and choose `dist/`.
2. Click the Zipline icon to open the side panel. The first time, GLiNER2 downloads (614 MB) and is cached.
3. Pick an example (it opens the page) or type your own goal for the current tab, then **Run**.

Chrome shows a "started debugging this browser" bar while Zipline drives a tab; that is the permission it uses to click and type.

## Verification

- `tests/parity.test.ts`: the JavaScript GLiNER2 runtime reproduces the Python library's token ids and outputs on 14 recorded calls (fp32 and fp16).
- `tests/verify.test.ts`: the goal check passes a sent, complete form and fails a Round-trip form beside "One way trip from New York…" cards, a form never sent and a captcha page.
- `tests/controller.test.ts`: the TypeScript controller makes the same decisions as the Python controller on captured Google Flights and Maps pages (`tests/oracle.py` produces the reference).
- `scripts/e2e.mjs [flights|maps|walking] [--llm]`: runs a task end to end in Playwright's Chromium.
- `scripts/record-demo.mjs`: records the page and the panel side by side in real time.

## Limits

- The controller is heuristic, as in the original: "done" means it found nothing left to do, so check the page.
- Scores below 0.5 are not acted on. On Google Maps, "Select Walking" scores 0.44 against "Walking 20 min" once a route is shown, so that step is skipped (the Python controller makes the same call).
- It reads text and ARIA labels, not pixels, and supports common HTML and ARIA controls.
- English and other languages the multilingual model covers for extraction; date parsing understands English month names, ISO and US numeric dates.

## Credits

Controller, loop, page snapshot and date parsing adapted from [gliner2-ultrafast](https://github.com/sahibzada-allahyar/gliner2-ultrafast) by Sahibzada Allahyar (MIT, copyright Browser Use), which began from Browser Use's [jev-ultrafast](https://github.com/browser-use/jev-ultrafast). GLiNER2 by [Fastino](https://fastino.ai) (Apache-2.0). Runs on [Transformers.js](https://github.com/huggingface/transformers.js).

MIT licensed.
