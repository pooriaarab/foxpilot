# foxpilot

An on-device browser agent for Firefox. [GLiNER2](https://github.com/fastino-ai/GLiNER2) runs on your GPU with WebGPU, reads the page and drives it until your goal is done. No server, no API key. Nothing about the page or your goal leaves the browser.

foxpilot is a port of [shreyaskarnik/zipline](https://github.com/shreyaskarnik/zipline), a Chrome extension. Two things changed. The UI is a Firefox sidebar instead of a Chrome side panel. Actions run in the page through `scripting.executeScript` and in-page events instead of the Chrome DevTools Protocol, so Firefox shows no "started debugging this browser" bar. It needs Firefox 157 or later. The rest of the upstream design is unchanged.

<!-- TODO: add a demo recording here once the Firefox run is captured. -->

Firefox timings are not published yet. The Chrome numbers in zipline do not apply here. `pnpm e2e` measures each run in Firefox and writes the result to `artifacts/`.

## How it works

It is a port of [gliner2-ultrafast](https://github.com/sahibzada-allahyar/gliner2-ultrafast) (MIT) from Python to a browser extension:

- **GLiNER2 decides.** One model, [`fastino/gliner2-multi-v1`](https://huggingface.co/fastino/gliner2-multi-v1), does two jobs. It extracts values from the goal ("New York", "October 9, 2026"). It also scores the controls on the page against each part of the goal. It runs as a single ONNX graph ([`onnx-community/gliner2-multi-v1-agent-ONNX`](https://huggingface.co/onnx-community/gliner2-multi-v1-agent-ONNX), 614 MB at fp16).
- **Code controls.** Explicit rules handle requirement order, one-to-one matching of requirements to controls, autocompletes, calendars, form submission and termination. They are ported from the Python controller (`src/agent/controller.ts`). The model picks among observed controls. It never writes selectors or code.
- **The page acts.** foxpilot reads the page with the original `snapshot.js`. It sends clicks and typing as in-page events through `scripting.executeScript`. Before every action, it checks that the page has not changed since the decision.
- **Field text, two ways.** By default, foxpilot types the value that GLiNER extracted for that part of the goal. If you switch on *Local LLM*, Qwen3-0.6B (WebGPU, about 0.5 GB) writes the value from the goal, the requirement and the GLiNER candidates.

**Checked, not assumed.** "Done" only means the controller found nothing left to do. Afterwards, foxpilot checks the finished page against each part of the goal and shows a checklist:

- a form field that holds each value ("Where from?: New York", "Departure: Fri, Oct 9");
- a control that shows each setting (GLiNER2 picks "one-way ticket" from the goal, and the page shows "Change ticket type. One way");
- the form was sent;
- the page is not an error page, an empty page or a captcha page.

The page's own form counts, not the cards beside it that use the same words. The answer is highlighted only on a verified page. The check covers what the form says. It does not check that the results below the form match.

The tab that foxpilot drives goes into a **foxpilot** tab group. The group title shows the run: step N, done with the time, or blocked.

## Try it

```bash
pnpm install
pnpm build            # writes dist/
```

1. In Firefox, open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and choose `dist/manifest.json`.
3. Click the foxpilot toolbar button to open the sidebar. On the first run, GLiNER2 downloads (614 MB) and is cached. The download happens once.
4. Pick an example (it opens the page), or type your own goal for the current tab. Then click **Run**.

A temporary add-on is removed when you close Firefox. Load it again for the next session.

## Verification

- `pnpm ci:local`: runs the same checks as CI.
- `pnpm e2e [flights|maps|walking] [--llm]`: runs a task end to end in Firefox. It writes a JSON result and a screenshot to `artifacts/`.
- `node bin/foxpilot.mjs run --url <url> --goal <goal> [--llm] [--json]`: runs one goal in Firefox and prints the result. `--file tasks.jsonl` runs one `{"url", "goal"}` per line in one session, so the model loads once. Scripts can use the same session from `scripts/lib/firefox.mjs`, or call `window.foxpilot.run({ goal, tabId, llm })` in the panel.
- `tests/parity.test.ts`: the JavaScript GLiNER2 runtime reproduces the token ids and outputs of the Python library on 14 recorded calls (fp32 and fp16).
- `tests/verify.test.ts`: the goal check passes a sent, complete form. It fails a Round-trip form beside "One way trip from New York..." cards, a form that was never sent and a captcha page.
- `tests/controller.test.ts`: the TypeScript controller makes the same decisions as the Python controller on captured Google Flights and Maps pages. `tests/oracle.py` produces the reference.

## Limits

- The controller is heuristic, as in the original. "Done" means it found nothing left to do, so check the page.
- Scores below 0.5 are not acted on. On Google Maps, "Select Walking" scores 0.44 against "Walking 20 min" once a route is shown, so foxpilot skips that step. The Python controller makes the same call.
- It reads text and ARIA labels, not pixels. It supports common HTML and ARIA controls.
- It works in English and in other languages that the multilingual model covers for extraction. Date parsing understands English month names, ISO dates and US numeric dates.
- In-page events have `isTrusted: false`. A site that checks for trusted input may ignore a click.
- WebGPU must be on. Firefox 157 on macOS and Windows has it by default. On Linux, you may need to set `dom.webgpu.enabled` to `true` in `about:config`.

## Branches

- `main` is staging.
- `release` is production. To release, merge `main` into `release`. The release workflow signs the `.xpi` with AMO (addons.mozilla.org).
- A release needs a version bump in `public/manifest.json`. The workflow fails when tag `v<version>` already exists.

## Credits

foxpilot is a port of [zipline](https://github.com/shreyaskarnik/zipline) by Shreyas Karnik (MIT).

Controller, loop, page snapshot and date parsing are adapted from [gliner2-ultrafast](https://github.com/sahibzada-allahyar/gliner2-ultrafast) by Sahibzada Allahyar (MIT, copyright Browser Use). That project began from Browser Use's [jev-ultrafast](https://github.com/browser-use/jev-ultrafast). GLiNER2 is by [Fastino](https://fastino.ai) (Apache-2.0). foxpilot runs on [Transformers.js](https://github.com/huggingface/transformers.js).

MIT licensed.
