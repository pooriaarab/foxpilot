# foxpilot: where the time goes, and what to change

Research for issue #10. Repo state: main `aedbc76`. Baselines: Firefox 157.0.1,
macOS, WebGPU, three `pnpm e2e` runs on 2026-10-08 (artifacts in
`artifacts/*-2026-10-08T18-2*.json`). Upstream numbers come from zipline's
README (`git show 1f35afe:README.md`). This report is read-only research. No
code was changed. Numbers marked "measured" come from the artifacts. Numbers
marked "estimate" come from reading the code and must be confirmed by
proposal 1.

## 1. Baseline (measured)

| Task | Result | Actions | Predictions | Refused | Run→verdict | Model load | Sum of decide `latencyMs` |
|---|---|---|---|---|---|---|---|
| flights | PASS 4/4 | 10 | 12 | 2 | 38.2 s | 17.0 s (cached) | 18.4 s |
| maps | PASS 2/2 | 7 | 11 | 3 | 20.4 s | 18.6 s | 5.2 s |
| walking | FAIL 2/3 | 8 | 13 | 4 | 31.2 s | 20.8 s | 12.2 s |

Upstream zipline in Chrome (README): flights in 9 actions, 8.0 s of actions,
8.4 s to the answer, "about 40 ms per call" for GLiNER2 on an M-series Mac
(bench: 35–37 ms per extraction, 43–44 ms per 12-label classification, commit
message of the bench import). foxpilot is about 4.5x slower end to end.

How to read the artifact `steps` array:

- A line that starts with `→` is a prediction (`render()`,
  `src/panel/sidepanel.ts:186-190`). A numbered line is an executed action
  (`history.push`, `src/agent/agent.ts:321-322`).
- Two `→` lines in a row mean the first prediction was refused as stale
  (`StalePage` in `browser.ts:155-156`) and the agent decided again. It was
  NOT executed. "Duplicate actions" in the logs are refused predictions, not
  double clicks.
- The `N ms` in a numbered line is `decision.latencyMs`. It counts only the
  `match()` classify calls (`controller.ts:369-372`). It leaves out the
  refused decision, `unsentForm`, `suggestion` and `dialog` calls
  (`controller.ts:494, 555, 591, 603`) and the final `verify`.
- `ms` is the gap between two log lines, taken by a MutationObserver in the
  panel (`scripts/e2e.mjs:115-136`).

Flights step gaps (measured, ms): prediction → card (act) 5,509 total; time
spent on refused predictions (act attempt + observe + new decision) 6,198;
tail after the last card (observe, `finishIfVerified`, verify, answer) 3,835.

## 2. Where the time goes per step

### 2.1 Model inference is most of it (measured + estimate)

- Flights: 18.4 s of counted decide time, plus about 4.9 s for the two refused
  first decisions (gap before each refused `→` minus settle), plus the
  uncounted suggestion and verify calls. Estimate: 23–25 s of 38.2 s, so
  60–65 % of the run.
- One decision costs 1.2–4.3 s in Firefox. A decision is one classify call per
  unserved requirement, run in sequence (`controller.ts:371`), plus a second
  pass for "unsure" value parts (`controller.ts:344-348`). Flights step 1 has
  4 requirements, so 4–8 calls take 4,323 ms. That is about 0.5–1 s per call,
  against about 40 ms in Chrome: 12–25x slower per call.
- Each call has a new input shape. The label schema (every control label on
  the page) and the requirement text both change the sequence length
  (`gliner2.ts:72-111`). Even the 4 calls in one step differ, because
  "Find a one-way ticket" and "from New York" have different word counts.
  The graph has dynamic `seq`, `words` and `schema` axes and a fixed batch of 1
  (`export/export_onnx.py:41-43, 91-95`).
- Likely cause (hypothesis, needs proposal 2's experiment): ONNX Runtime's
  WebGPU EP builds new compute pipelines when a shape is new. Chrome's Dawn
  keeps an in-memory and on-disk shader cache. wgpu on Metal has no pipeline
  cache yet ([gfx-rs/wgpu#8526](https://github.com/gfx-rs/wgpu/issues/8526)),
  so Firefox compiles WGSL → MSL → Metal again for each new pipeline. Upstream
  already saw shape cost in Chrome: the controller comment says scoring 50 day
  labels "cost 1.3–3 s per step" (`controller.ts:648-650`), and
  `bench/bench.ts` has a "new shape vs same shape" sweep.
- Second suspect: readback latency. Each `session.run` reads three outputs
  back (`gliner2.ts:122-127`, `tensor.to("float32")`). `mapAsync` round trips
  of 5–15 ms are reported even for trivial work
  ([gpuweb#4432](https://github.com/gpuweb/gpuweb/issues/4432)). This adds
  ms per call, not seconds. It cannot explain 1 s per call by itself.
- Settings checked: same Transformers.js 4.3.0, same ORT
  `ort-wasm-simd-threaded.asyncify` build, `device: "webgpu"`, `dtype: "fp16"`
  as zipline (`sidepanel.ts:15-20, 103-106`). Transformers.js throws if the
  adapter lacks `shader-f16` (`transformers.web.js:19569-19572`). The model
  loaded, so Firefox 157 exposes `shader-f16`. No session options are set
  (no `preferredOutputLocation`, no graph capture). The warm-up call uses
  2 labels (`sidepanel.ts:114`), so it compiles none of the real shapes.
- Agent.create's goal extraction is cheap: Run → first `→` is 4,860 ms, and
  4,323 ms of that is step 1's decide. Attach + goal extraction + first
  observe ≈ 540 ms. A short input with few labels is fast, which fits the
  "long or new shape is slow" reading.

### 2.2 Refused predictions double the model bill (measured)

| Task | Refused | Cost of the redo |
|---|---|---|
| flights | 2 (`One way`, `Where from?`) | 2,074 + 4,124 ms (new decision missed the memory cache) |
| maps | 3 | 106 + 1,974 + 34 ms (two hit the memory cache) |
| walking | 4 | 3,232 + 2,780 + 35 + 1,370 ms |

Why they happen:

- A fill is checked against the whole-page `marker`: title, all visible text,
  all control semantics (`snapshot.js:174-175`, `browser.ts:148`). A click is
  checked against the node's guard, which includes the `innerText` of its
  scope, up to 6,000 characters (`snapshot.js:80-87`, `browser.ts:139-146`).
  Any text change in that scope refuses the action.
- `settle()` ends early: 250 ms after a plain click, 150 ms plus two frames
  when nothing is pending (`settle.ts:24, 41`). Google pages keep animating
  after that. The page is read mid-transition, the decision takes 1–4 s, and
  by then the page has moved.
- The race window equals the decision time. With 40 ms decisions in Chrome
  the window is tiny. With 1–4 s decisions in Firefox it is wide. Faster
  inference alone reduces refusals.
- walking `CLICK Walking` was refused because the button's name became
  "Walking 20 min" when the route time loaded. That refusal is correct; the
  redo still cost 1,370 ms.

### 2.3 executeScript round trips (measured + estimate)

Calls per step, all through `TabBrowser.evaluate` (`browser.ts:89-100`):

| Step kind | Calls | Heavy `snapshot` calls | Fixed sleeps |
|---|---|---|---|
| click | 7: predict `fresh` snapshot (`agent.ts:208` → `browser.ts:148`), `fresh` guard (`browser.ts:141`), `resolveTarget` (:173), `markTarget` (:179), `clickAt` (:183), `settle` (:119), `snapshot` (:126) | 2 | 120 ms (:180) + settle 150–800 ms |
| fill | 9: as click, plus `fresh` marker in `agent.ts:264`, `fresh` marker again in `browser.ts:155` (fill is not click/select, so it takes the snapshot path at :148), `fillField` (:184) | 4 | 120 ms + settle up to 600 ms |
| refusal | +3: failed `fresh`, `observe` snapshot, predict `fresh` snapshot | 2 |: |
| offscreen target | +1 `scrollIntoView` | 0 | +50 ms (:171) |
| wait | 0 | 0 | 600 ms (:159) |

- The predict `fresh` snapshot (`agent.ts:208`) runs right after `observe()`
  (`agent.ts:324` or `:203`). It reads the same page twice. One redundant
  heavy call per step.
- A fill takes three marker snapshots before it types (`agent.ts:208`, `:264`,
  `browser.ts:155`).
- Measured cost per call: flights step 1 act = 202 ms for 4 light calls plus
  the 120 ms sleep, so a light call ≈ 20 ms. Maps "→ WAIT" 83 ms after a card
  = 2 snapshots + fingerprint, so a heavy call ≈ 40 ms on Maps. Flights redo
  non-model time 31 ms for 1 light + 2 heavy calls.
- Flights total (estimate): 7 clicks × 7 + 3 fills × 9 + 2 refusals × 3 ≈ 82
  calls × ~20 ms ≈ 1.6 s (about 4 %). Each call also re-parses the injected
  function source (`snapshot` is ~10 KB).
- `clickAt` runs the page's own click handlers synchronously inside the call.
  Flights step 6 act (1,119 ms) and step 10 act (1,043 ms, "Search") are page
  work, not round trips.
- `fingerprint` (SHA-256 over a stable JSON of up to 250 actions and 6 KB of
  text, `browser.ts:207-219`) costs a few ms. Not worth changing.
- `snapshot` walks the whole tree for shadow roots three times per call
  (`deep()` at `snapshot.js:49-53`, used at :78, :91, :102) and reads
  `innerText` of a scope for every action's guard (:86, :171). This is the
  heavy part of a heavy call.

### 2.4 Fixed waits and polls (estimate)

- `showActions` ring: 10 × 120 ms = 1.2 s on flights (`browser.ts:178-181`).
- `settle` timeouts: 600 ms autocomplete, 800 ms menu or closing dialog, 250 ms
  else (`settle.ts:24`). They end early when options show. Upper bound on
  flights ≈ 5 s; likely 2–4 s.
- `finishIfVerified`: `settleNavigation` polls every 50 ms for 150 ms
  (`browser.ts:78`), then up to 1,000 ms of 150 ms looks until two
  fingerprints match (`agent.ts:359-366`), then `verify` makes model calls
  (`verify.ts:86, 99`). Flights tail = 3.8 s.
- `waitForLoad` polls `document.readyState` with one executeScript every 50 ms
  (`browser.ts:102-112`). It only runs after a navigation.
- None of these waits was tuned for CDP events. Zipline used the same in-page
  `SETTLE` and the same 50 ms polls (`git show 1f35afe:src/agent/browser.ts`,
  lines 134-138, 168, 190). Navigation events now come from `webNavigation`
  (`browser.ts:53-55`), which Firefox delivers.

### 2.5 The E2E panel is a background tab (measurement risk)

- `scripts/e2e.mjs` opens the panel as a second tab, then calls
  `page.bringToFront()` on the task tab (line 121). The panel, where every
  `sleep()` and the agent loop run, is now an inactive tab.
- MDN: "Firefox Desktop has a minimum timeout of 1 second for inactive tabs"
  ([setTimeout](https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout)).
- Evidence is mixed. The 600 ms WAIT took 715–917 ms (maps, walking), so
  timers ARE late by 115–317 ms. But the 120 ms sleep in flights step 1 fit in
  202 ms, so there is no hard 1 s clamp. The real sidebar is visible and is
  not throttled. The baseline may overstate the gaps by an unknown amount.
  Proposal 1 fixes this before any other number is trusted.

### 2.6 Accuracy: the walking failure is a verifier false negative

- The screenshot shows the start field as "Berlin Central Station, Mitte,
  10557 Berlin". The agent typed "Berlin Hauptbahnhof" and took the suggestion
  "Transit Berlin Hauptbahnhof Mitte, Berlin, Germany" (step 3). After the
  Walking click, Google Maps rewrote the field to its English name.
  `verify()` matches values literally (`verify.ts:47`), so it reports
  "berlin hauptbahnhof not on the page".
- Issue #28 says the agent "clicked Your location first". The log shows
  `→ CLICK Your location` with no numbered card after it. That was a refused
  prediction, never executed. The stale check stopped a wrong choice. #28's
  reproduction text should be corrected.
- The `Your location` prediction is a real accuracy risk: a generic
  suggestion outranked the named place for a valued part. The page moved in
  time to stop it, which is luck, not design.

## 3. Ranked proposals

Gain = expected change in the artifact. Cost = counted lines and risk.
"Firefox run" = the lead must run real Firefox to confirm before or after
the change.

### Top 5

**1. Put real timing in the artifact and stop panel throttling in E2E** (A, do first): #43. The throttling half shipped in #36: the E2E panel now runs in its own window.
- What: in `scripts/e2e.mjs`, save `window.__zipline.history[].timing`
  (decide, calls, model, act, observe already exist: `agent.ts:32, 229, 325`),
  `decisions[].ms/calls`, and `textCalls`. Count calls and ms per function name
  in `TabBrowser.evaluate`, expose them on the panel window, and save them.
  Run the panel in its own window, or set `extraPrefsFirefox`
  `dom.min_background_timeout_value: 4` and
  `dom.timeout.enable_budget_timer_throttling: false` for E2E only.
- Gain: every later number becomes measured. Maybe 1–3 s less noise per run.
- Cost: about 30 lines (e2e.mjs + browser.ts counters). Risk low.
- Measure: new `timing` fields; WAIT step should drop to about 600–620 ms.
- Firefox run: yes, rerun all three tasks.

**2. Pad GLiNER2 inputs to fixed shape buckets and warm them at load** (A): #44
- First run the experiment: copy `bench/run.mjs` to drive Firefox with
  Puppeteer (as `e2e.mjs` does) and run `SWEEP=1` with
  `model=onnx-community/gliner2-multi-v1-agent-ONNX`. Compare "new shape" vs
  "same shape" ms in Firefox and Chrome.
- If "same shape" is far lower: in `Gliner2.run` (`gliner2.ts:113-129`) pad
  `input_ids` to a bucket (for example multiples of 64) with
  `attention_mask` 0; pad `word_positions` and `schema_positions` to buckets
  by repeating the last index; slice `cls`, `span` and the word count back
  before decoding. Warm the common buckets after load
  (`sidepanel.ts:114`).
- Gain (estimate): decide from 1.2–4.3 s to 0.2–0.6 s per step; flights
  −12 to −20 s; fewer refusals as a side effect (2.2).
- Cost: about 50 lines in `gliner2.ts` plus a parity case at fp32 in
  `tests/parity.test.ts` (needs `dist-model/`). Risk: padded outputs must match
  unpadded within tolerance; the encoder must honour the mask.
- Measure: `timing.model` per step, sum of decide `latencyMs`, `totalMs`.
- Firefox run: yes, before (bench) and after (E2E).
- If "same shape" is also slow, the cost is per dispatch, not compile. Then
  drop this and go to proposals A1 and A2 below (fewer tokens, one batched call).

**3. Read the page once it is quiet, and redo less after a refusal** (A + B): #45
- What: in `settle.ts`, after the current condition, also wait until a
  MutationObserver sees no DOM change for about 120 ms, capped at about
  1,200 ms. In `predict()`, skip the decide when the re-observed page has the
  same label schema (the memory cache already makes that call free,
  `controller.ts:366-372`), and record each refusal with its reason.
- Gain: flights −4 to −6 s (2 redos), walking −5 to −7 s (4 redos); decisions
  made on a settled page, which removes stale suggestion lists like
  `Your location`. Cost of the wait: +100–300 ms per step.
- Cost: about 30 lines in `settle.ts` (it must stay self-contained). Risk:
  pages that never stop changing (maps, tickers) hit the cap every step; keep
  the cap short.
- Measure: count of `→` lines without a card (refusals), `totalMs`.
- Firefox run: yes.

**4. Accept a value the page renamed after the agent committed it** (B): #28
- What: when the agent takes a suggestion for a valued part, store the field's
  value in the observation right after it (`agent.ts:324`, the field with the
  committed node). In `evidenceFor` (`verify.ts:39-56`), accept that field if
  it still shows the stored value, or a value the page wrote without another
  agent input to that field. Keep the literal check as the first path.
- Gain: walking 2/3 → 3/3 (fixes #28 at its real cause).
- Cost: about 25 lines. Risk: a weaker check could pass a wrong value; limit
  it to the exact node the agent filled and committed, with no later fill.
- Measure: `checks[]` in `walking-*.json`; flights and maps must stay green.
- Firefox run: yes, all three tasks.

**5. Drop redundant executeScript calls** (A): #46
- What: skip the predict `fresh` snapshot when `observe()` just ran
  (`agent.ts:208`); make the fill path take one marker check, not three
  (`agent.ts:264`, `browser.ts:155`); merge `resolveTarget`, `markTarget`,
  the 120 ms delay and `clickAt` into one injected function that waits in the
  page and then clicks (`browser.ts:173-183`).
- Gain (estimate): click step −1 heavy and −2 light calls, fill step −3 heavy
  and −2 light calls. Flights ≈ 25–35 calls fewer, −0.6 to −1.2 s.
- Cost: about 40 lines. Risk low: the stale check still runs once, right
  before input, in the same document.
- Measure: evaluate call count and ms (from proposal 1); act and observe ms.
- Firefox run: yes, one E2E per task.

### A. Speed (rest)

| # | Proposal | Gain | Cost / risk | Measure | Firefox run |
|---|---|---|---|---|---|
| A1 (#48) | Fewer labels per classify: score only controls in the open dialog or the active form, cap labels per call (the schema is every control, `controller.ts:362`) | Shorter sequences; maybe −30 % model time | 30–60 lines in `controller.ts`; accuracy risk, needs the controller oracle tests | `timing.labels`, `timing.model`, checks | yes |
| A2 (not filed: revisit after #44, it needs a new 614 MB export) | Re-export the graph with a batch axis; score all requirements in one call (`export_onnx.py:43` indexes batch 0) | 4–8 calls → 1–2 per step | High: new export, new 614 MB upload, parity work | `timing.calls`, `timing.model` | yes |
| A3 (not filed: product choice, the marker is the visible feedback) | Make `showActions` delay optional (fast mode) | −1.2 s on flights | 5 lines; less visible feedback | act ms | no |
| A4 (in #49) | Event-driven `settleNavigation` and `waitForLoad` from `webNavigation.onCompleted` instead of 50 ms polls (`browser.ts:76-112`) | −50–300 ms per navigation; fewer failed calls | 25 lines; low | tail ms | yes |
| A5 (in #44) | Bench `dtype=fp32` and `device=wasm` in Firefox | Unknown; rules out an fp16 or EP problem | 0 lines (bench params exist) | bench ms | yes |
| A6 (in #43: measure the tail first) | Prefilter verify's per-part extraction with literal matches first (`verify.ts:86`) | −0.5–1 s tail | 10 lines; low | tail ms | yes |

### B. Accuracy (rest)

| # | Proposal | Gain | Cost / risk | Measure | Firefox run |
|---|---|---|---|---|---|
| B1 (#47) | A suggestion serves a valued part only if it names the value (same rule as select options, `controller.ts:414-418`); "Your location" never serves "from Berlin Hauptbahnhof" | Removes the walking/maps mis-prediction | 10 lines; low | refusals, checks | yes |
| B2 (in #43) | Log every refusal with its reason (marker vs guard, which field) | Shows which pages need a narrower check | 10 lines | new artifact field | yes |
| B3 (done: #28 updated) | Fix #28's reproduction text: the "Your location" line is a refused prediction | Correct diagnosis | issue edit |: | no |

### C. Firefox primitives

| Primitive | Verdict | Why |
|---|---|---|
| Inject the page kit once per document (#49) (`scripting.executeScript({files})` on attach, or `scripting.registerContentScripts` while a run is active) + `runtime.Port` | **Helps, medium.** | Saves the per-call parse of `snapshot`/`actuate` source and some IPC; about 5–15 ms × 7–9 calls per step (estimate, confirm with proposal 1). The real gain: the page can push "DOM changed" and "quiet now" events, which proposal 3 needs. Cost about 150 lines; risk in port lifetime across navigation and bfcache. Prefer on-attach injection over manifest `content_scripts` with `<all_urls>`, which runs in every page the user opens. [registerContentScripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/registerContentScripts), [runtime.Port](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/Port) |
| `webNavigation` / `tabs.onUpdated` instead of polling `readyState` | **Helps, small.** | Already used for load start and stop (`browser.ts:53-55`). Only `waitForLoad` still polls. See A4. |
| `menus` + `menus.getTargetElement` (#50) ("foxpilot: do this here") | **Helps accuracy as a feature.** | The user points at a form; the agent scores only controls under that element, so fewer labels (faster) and fewer distractors. Firefox-only `getTargetElement`. Feature work, about 80 lines. [getTargetElement](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/menus/getTargetElement) |
| `browser.trial.ml` | **Does not help.** | Only models from Mozilla's hub or the Hugging Face orgs "Mozilla and Xenova" may load. The GLiNER2 graph lives in `onnx-community` and has 4 custom inputs, not a pipeline task. The Qwen3 writer is also in `onnx-community`. On Release it needs `browser.ml.enable` and `extensions.ml.enabled` set in about:config, and the optional `trialML` permission. [Firefox ML extension API docs](https://firefox-source-docs.mozilla.org/toolkit/components/ml/extensions.html) |
| `tabs.captureTab` | **Does not help speed or accuracy.** | The agent reads text and ARIA, not pixels. Use only for proof screenshots in the run log. |
| `find` API | **Does not help.** | It searches page text, which `snapshot` already has. It runs only in background scripts, so it adds a hop. It could highlight the answer; that is cosmetic. [find.find](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/find/find) |
| `sidebarAction` per-window panels | **Does not help; a risk.** | Each window's sidebar is its own document, so each would load its own 614 MB model on the GPU. Add a guard against a second load; no speed gain. |
| `userScripts` | **Does not help.** | It is for user-supplied scripts and needs an extra opt-in permission. `executeScript` in the isolated world already gives what the agent needs. |
| `dom.webgpu.*` prefs | **Does not help users.** | An extension cannot set prefs, and asking users to change them is not a product fix. Use only in E2E for diagnosis. |
| Trusted input | **No primitive exists.** | Firefox has no `debugger` API. Synthetic events stay `isTrusted: false` (`actuate.ts:4-6`). Only WebDriver BiDi from outside the browser makes trusted input. |

## 4. Suggested order

1 (measure) → 2 (bench first, then pad) → 3 → 5 → 4 → B1. Rerun
`pnpm e2e flights|maps|walking` after each, and compare `totalMs`, refusal
count, sum of `timing.model`, and `checks`.

## 5. What this report could not verify

- No Firefox run was possible in this sandbox. Per-call model ms, per-call
  executeScript ms, and the throttling effect are inferred from step gaps.
- The shader-recompile cause is a hypothesis. Proposal 2's bench decides it.
- Settle-wait totals are upper bounds from the code, not measurements.

## Sources

- [gfx-rs/wgpu#8526 Pipeline cache (DX12 & Metal)](https://github.com/gfx-rs/wgpu/issues/8526)
- [gpuweb/gpuweb#4432 mapAsync latency](https://github.com/gpuweb/gpuweb/issues/4432)
- [MDN setTimeout: inactive tabs](https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout)
- [Firefox ML WebExtensions API](https://firefox-source-docs.mozilla.org/toolkit/components/ml/extensions.html)
- [MDN scripting.registerContentScripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/registerContentScripts)
- [MDN find.find](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/find/find)

## 6. Bench result: shape padding rejected (#44)

`pnpm bench:firefox` on Firefox 157.0.1, macOS, 2026-10-08. Times are ms per GLiNER2 classify call.

| device | dtype | load | cold (first call) | same shape, median | new shape, median | new / same |
| --- | --- | --- | --- | --- | --- | --- |
| webgpu | fp16 | 14097 | 808 | 522 | 622 | 1.2x |
| webgpu | fp32 | 26862 | 2577 | 522 | 615 | 1.2x |
| wasm | fp32 | 5890 | 1058 | 1283 | 1352 | 1.1x |

A new input shape costs only 1.2x a repeated one, so pipeline recompiles are not
the main cost, and proposal 2's padding is dropped. Each call costs about 520 ms
in Firefox against about 40 ms upstream in Chrome, whatever the shape. The cost is
per dispatch. fp16 runs no faster than fp32, which suggests Firefox does not use
an f16 path here. WebGPU is still 2.5x faster than wasm.

What follows: cut the number of model calls. Fewer refused decisions (#45), fewer
labels per call (#48), and one batched call per step (A2) now rank above padding.

## 7. Where the per-call time goes (#70)

`pnpm bench:firefox` and `pnpm bench:firefox --browser chromium`, macOS, 2026-10-08. ms per GLiNER2 call.

| run | Firefox 157 | Chromium 153 | Firefox / Chromium |
| --- | --- | --- | --- |
| webgpu fp16 | 510 | 36 | 14.2x |
| webgpu fp32 | 513 | 35 | 14.8x |
| webgpu fp32, outputs kept on the GPU | 311 | 34 | 9.3x |
| webgpu fp32, graph capture | 311 | 34 | 9.3x |
| wasm fp32, 1 thread | 1047 | 1045 | 1.0x |
| wasm fp32, 4 threads (cross-origin isolated) | 229 | 247 | 0.9x |

- A fixed per-call cost dominates in Firefox. A 15-token call takes 514 ms and a 128-token call 509 ms. Each token adds only 0.63 ms.
- Most of that cost is reading outputs back to the CPU. With outputs kept on the GPU, the call takes 311 ms, and reading back `cls_logits` alone takes 93 ms of it.
- wasm runs at the same speed in both browsers, so the gap is Firefox's WebGPU path, not the model.
- Threaded wasm is the fastest Firefox option, but extension pages cannot be cross-origin isolated today (bug 1750654, bug 1673477).

What follows, in order:
1. Keep outputs on the GPU and read back only what each call needs (1.65x per call, available now).
2. Score every open requirement in one GLiNER2 call per step. Each call costs a fixed ~300–500 ms, so one call instead of four saves most of a step.
3. Report the readback cost to Mozilla with this bench as a reproducer.
