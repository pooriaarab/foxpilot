# foxpilot as an app platform: plan

Goal: publish 5–10 Firefox add-ons from `pooriaarab/foxpilot`. Each add-on is an app in `apps/<name>/`. All apps share one model runtime, one page kit and one safety layer. Repo state read: main `69deb2d` (2026-10-08). This plan changes no code.

## 0. Facts that shape the design

- **The code is already layered, with three leaks.** `src/model/gliner2.ts` imports nothing from the agent. `kit.ts`, `snapshot.js`, `actuate.ts`, `settle.ts`, `types.ts`, `ask.ts`, `dates.ts`, `policy.ts` and `site.ts` are leaves. The leaks:
  1. `Scorer` and `Labels` are declared in `controller.ts` (line 14 and 17). `dialogs.ts`, `report.ts`, `verify.ts`, `fieldtext.ts` and `answer.ts` import them from there.
  2. `report.ts` imports the `Answer` type from `answer.ts`.
  3. `browser.ts` imports `MASK` from `policy.ts` (fine: both go to core).
- **The build is one esbuild script** with three entries (`sidepanel`, `background`, `kit` as IIFE). It copies `public/` and the ORT wasm to `dist/`.
- **`scripts/lib/firefox.mjs` hardcodes `dist/` and the gecko id** `foxpilot@pooriaarab.github.io`. `e2e.mjs`, `bin/foxpilot.mjs`, MCP and the zoo eval all go through it.
- **CI cannot run Firefox.** `ci.yml` runs typecheck, vitest (with Playwright Chromium), build and `web-ext lint`. The lead runs the Firefox E2E by hand.
- **No release tag exists yet** (`git tag` is empty). The tag scheme can change with no cost.
- **Model sizes.** multi-v1 fp16 is 614 MB and downloads from the HF Hub into the panel origin's Cache API. gliner2.5-small q8 is 86 MB (`model_quantized.onnx`, measured on the fxp-88 worktree); fp16 is 147 MB. Each add-on has its own `moz-extension://<uuid>` origin, so caches are never shared. Two apps on multi-v1 cost the user 1.2 GB.
- **pr-standards counting** (`~/Documents/Personal/scripts/pr-standards.mjs`):
  - A pure `git mv` (100 % similar) has 0 additions and 0 deletions, so it adds **0 counted lines but 1 counted file**. The file cap is **40**.
  - An edited rename counts only its changed lines.
  - Lines that leave one file and arrive in another are discounted as a move (`countMovedLines`), when GitHub gives a patch for every counted file.
  - `pnpm-lock.yaml`, `dist/**`, images and `**/generated/**` are not counted.
  - More than 3 top-level directories is a **warning**, not a failure.
  - So the binding limit for moves is **files**, not lines. Plan each move PR at ≤ 35 files to leave room.

## 1. Monorepo design

### 1.1 Layout

```text
pnpm-workspace.yaml        packages: [packages/*, apps/*]  (+ existing allowBuilds) package.json               root scripts only: build, typecheck, test, lint:ext, ci:local, e2e, eval tsconfig.json              one config, include: [packages, apps, scripts/types] vitest.config.ts           include: [packages/*/tests/**, apps/*/tests/**] scripts/ build.mjs                one engine: `pnpm build` = all apps; `pnpm build <app>` = one fetch-model.mjs          downloads a pinned model revision, checks sha256 (bundled models) release-plan.mjs         lists apps whose manifest version has no tag yet (release.yml) lib/firefox.mjs          launch({ app }) installs dist/<app>; gecko id read from its manifest zoo/                     unchanged; foxpilot-only packages/ core/                    @foxpilot/core  (no UI, no controller) package.json           "exports": { "./model": ..., "./page": ..., "./text": ..., "./dialogs": ..., "./report": ..., "./host": ... } src/model/             gliner2.ts, gliner25.ts, models.ts (registry), scorer.ts (Scorer, Labels) src/page/              snapshot.js, snapshot.d.ts, kit.ts, actuate.ts, settle.ts, browser.ts (TabBrowser), types.ts, site.ts src/text/              ask.ts, dates.ts, policy.ts src/dialogs.ts         consent/decline classification src/report.ts          value extraction (Reporter, reportSlots) src/model/host.ts      model host over runtime.Port for content-script apps (new, with app 1) tests/                 parity, dates, site, settle.browser, rules (moved) agent/                   @foxpilot/agent src/                   controller, agent, verify, answer, pick, search, fieldtext, patience tests/                 controller, verify, pick, fieldtext, answer.browser (moved), fixtures/, oracle.py apps/ foxpilot/                the browser agent (today's extension) app.config.mjs         entries, model, model delivery public/                manifest.json, sidepanel.html/.css, icons/ src/                   panel/sidepanel.ts, panel/tabgroup.ts, background.ts bin/foxpilot.mjs       CLI + MCP (moves from root bin/) listing/               amo.json, description.md, privacy.md, screenshots/ (git-tracked product assets) e2e/tasks.mjs          flights, maps, walking (today's scripts/e2e.mjs task table) pii-guard/ ...           same shape bench/                     stays at root; imports @foxpilot/core/model export/                    stays at root; Python export scripts for every model
```

Why `core` + `agent` and not more packages: every app needs the model, and most need the page kit, the ask rules or the safety layer. Only foxpilot needs the 1,120-line controller. Subpath exports keep each app's bundle to what it imports. esbuild tree-shakes per entry, so a PII app that imports `@foxpilot/core/model` and `@foxpilot/core/text` does not ship the kit.

Packages ship TypeScript source. There is no package build step. `moduleResolution: "Bundler"`, esbuild and vitest all read `.ts` through the workspace symlinks. `@huggingface/transformers` moves to `packages/core/package.json`. `scripts/build.mjs` resolves the ORT wasm from there (`realpathSync` already follows the symlink).

### 1.2 How an app builds

`apps/<app>/app.config.mjs` (data, not code paths into other apps):

```js
export default { entries: { sidepanel: "src/panel/sidepanel.ts", background: "src/background.ts", kit: { in: "@foxpilot/core/page/kit", format: "iife" }, // only apps that drive pages }, model: "gliner2-multi-v1",   // or "gliner2.5-small", or null };
```

`scripts/build.mjs <app>`:

1. `rm -rf dist/<app>`; copy `apps/<app>/public` to it.
2. When `model` is set: copy the ORT wasm to `dist/<app>/ort/`. When the registry says `delivery: "bundled"`: copy the model files from the `fetch-model.mjs` cache to `dist/<app>/models/<id>/`.
3. Build each entry with the shared esbuild options. `define: { __MODEL__: JSON.stringify(registry[model]) }` gives the runtime the id, device, dtype and delivery. This replaces the `__GLINER__` flag on fxp-88.
4. Fail when `manifest.version` is not a valid AMO version, or when the manifest asks for a permission that `app.config.mjs` does not list in `permissions` (a cheap guard against permission creep across apps).

`pnpm build` builds every app. `pnpm lint:ext` runs `web-ext lint -s dist/<app>` for each app. `ci:local` stays one command.

### 1.3 Per-app model choice

`packages/core/src/model/models.ts` is the registry:

| id | class | device | dtype | delivery | size | use |
|---|---|---|---|---|---|---|
| `gliner2-multi-v1` | `Gliner2` | webgpu | fp16 | hub (`onnx-community/gliner2-multi-v1-agent-ONNX`) | 614 MB | long or multilingual input; many labels per call |
| `gliner2.5-small` | `Gliner25` | wasm | q8 | bundled (pinned HF revision + sha256) | 86 MB | short English input; no GPU needed |

Rules:

- **Default to `gliner2.5-small` bundled.** 32 ms at 10 tokens and 230 ms at 128 tokens on wasm fits every short-input app. Bundled means the app makes **no network request ever**. AMO reviewers can check that, and the listing can say it. It also works offline and on machines with no WebGPU.
- **Use `multi-v1` only when the app needs it** (foxpilot itself; maybe Terms Audit for long text). It downloads on first use, as today.
- **Bundled models must build reproducibly.** AMO reviewers rebuild from the source zip. So `fetch-model.mjs` downloads the exact file from a pinned HF revision and checks its sha256. Prerequisite: publish the fxp-88 export of gliner2.5-small (Apache-2.0) to an HF repo the owner controls. That needs the owner's HF token (human step).
- **Size limit.** AMO's upload limit is 200 MB per file (check the current AMO docs before the first bundled release). 86 MB q8 + ~25 MB ORT wasm fits. fp16 (147 MB) is close; do not bundle it.
- **Update cost.** Firefox downloads the full `.xpi` on each update. A bundled app costs every user ~110 MB per version. Release bundled apps on purpose, not on every main merge.
- **Where the model runs.** foxpilot runs it in the sidebar page. Apps that act from a content script run it in the background event page (Firefox MV3 background pages have a DOM and allow `wasm-unsafe-eval`). `@foxpilot/core/model/host` gives two halves: `serveModel()` in the background and `remoteScorer()` in the content script, which implements `Scorer` over a `runtime.Port`. Firefox may unload an idle event page. The open ports then close, the content script rejects the calls in flight, and its next call wakes the page, which loads the model again. The host logs `[foxmind] model ready in N ms` for each load, warm-up call included. Measured reload of foxmind-small: 455-575 ms in Node with onnxruntime-node on CPU (Apple M3 Pro, 3 runs). That is not Firefox: wasm in an event page is slower. The Firefox number is not measured yet (target < 2 s).
- **Rejected: one "model host" add-on that the other apps call** through `runtime.onMessageExternal`. It saves disk but makes every app depend on a second install, and AMO reviews each add-on alone. Rejected for now.
- **Watch: Firefox `browser.trial.ml`.** Firefox caches its own models across extensions. It runs pipeline tasks, not GLiNER2's fused graph and custom decoding, so it does not fit today. Re-check when it accepts custom ONNX.

### 1.4 Tests, E2E and the zoo eval

- **vitest** runs once at the root over `packages/*/tests` and `apps/*/tests`. CI does not change shape.
- **`scripts/lib/firefox.mjs`** takes `{ app }`. It installs `dist/<app>` and reads the gecko id from `dist/<app>/manifest.json`. Today's `window.foxpilot` test hook is foxpilot-only; each app exposes its own hook in its own UI page (`window.<app>`), used only by its E2E.
- **`pnpm e2e <app> [task]`**: runs `apps/<app>/e2e/tasks.mjs`. foxpilot keeps `flights`, `maps`, `walking`. Each new app ships fixture pages (served by a local `node:http` server, as `settle.browser.test.ts` already does) and writes `artifacts/<app>-<task>-<ts>.json`. That JSON is the repeatable artifact the user rules ask for.
- **`pnpm eval`** (zoo-sites) stays foxpilot-only. Consent Shield reuses the zoo-sites consent and dialog tasks as its eval set (see 3.2).
- **The lead runs the Firefox E2E** on every migration PR, because CI cannot.

### 1.5 Release: N apps, one workflow

Trigger stays `push` to `release` (merge main into release).

```text
jobs: plan:     checkout (fetch tags) -> pnpm install -> pnpm ci:local (once, whole repo)
            -> node scripts/release-plan.mjs  => [{app, version, channel}] (an app is in the list when tag "<app>-v<version>" does not exist) sign:     needs: plan; if: list not empty strategy: matrix: ${{ fromJSON(needs.plan.outputs.apps) }}, max-parallel: 2, fail-fast: false pnpm build <app> -> git archive source.zip web-ext sign -s dist/<app> --channel=<channel> --amo-metadata apps/<app>/listing/amo.json
                        --upload-source-code source.zip (+ approval timeout 0 for listed) tag "<app>-v<version>"; gh release create (attach .xpi for unlisted)
```

- **Version per app** lives in `apps/<app>/public/manifest.json`, the one source. No version in the app `package.json`.
- **Bump-driven, not diff-driven.** A core change does not force a release of all apps. An app ships when its version moves. `release-plan.mjs` prints a warning (not a failure) for an app whose files or `packages/**` changed since its last tag with no bump. Nothing to release is a green run, not a failure (today's job fails when the tag exists; with N apps that would fail every run).
- **Channel per app** in `apps/<app>/listing/amo.json` (`"channel": "listed" | "unlisted"`). foxpilot stays unlisted while zoo-sites passes 0/80.
- **Unlisted apps need `update_url`.** Today's unlisted foxpilot has none, so installed copies never update. Add `gecko.update_url` pointing at an `updates.json` that the release job writes as a release asset (`releases/latest/download/<app>-updates.json`). Listed apps update through AMO and must not set it.
- **Listed apps:** `web-ext sign --channel=listed` uploads and returns before review when the approval timeout is 0. The job tags and writes a release with notes and the AMO link, no `.xpi`. Check the exact `web-ext` 10 flags (`--amo-metadata`, `--approval-timeout`) before the PR.
- **Source zip for AMO review:** the whole repo (`git archive`), plus `apps/<app>/listing/BUILD.md`: `pnpm install --frozen-lockfile && pnpm build <app>` and, for bundled models, `node scripts/fetch-model.mjs`.
- **One AMO key pair signs every app** (`AMO_JWT_ISSUER`/`AMO_JWT_SECRET` are per account).
- **Gecko id per app:** `<app>@pooriaarab.github.io`. It can never change after the first upload, so the PR that creates an app fixes it.

**What needs a human** (never in CI):

1. First listed submission of each app in the AMO Developer Hub: name, slug, categories, summary, description, icon, support email, license. CI can send the metadata JSON, but the owner must check the listing and answer reviewer mail. AMO account 2FA is needed.
2. Screenshots. The E2E harness can capture candidates (`apps/<app>/listing/screenshots/`); a person picks and uploads them.
3. Privacy policy. Each app collects nothing (`data_collection_permissions: required ["none"]`). Write a one-page `privacy.md` that says so anyway and paste it into the listing; host it on the repo's GitHub Pages.
4. Publish gliner2.5-small to the HF Hub (owner's token).
5. The listed or unlisted choice per app, and the name check (AMO does not allow "Firefox" as the first word of a name).

## 2. Migration sequence (each PR < 500 counted lines, ≤ 35 files)

Every PR keeps `pnpm ci:local` green. The lead runs `pnpm e2e flights`, `maps` and `walking` on each one and checks the baseline (flights PASS 4/4, maps PASS 2/2, walking 2/3) does not move. Moves use `git mv` with no edits in the same commit where possible, so GitHub reports them as 100 % renames (0 lines).

**Before M1:** land or close fxp-88 (gliner2.5-small, 404 lines on the old layout). A branch parked under six move PRs rots. If the bench decision is not made, merge it as-is behind its `GLINER` flag; M8 turns the flag into the registry.

| PR | Title | What moves / changes | Files | Counted lines (est.) |
|---|---|---|---|---|
| M1 | Add a pnpm workspace and packages/core | `pnpm-workspace.yaml` packages list; `packages/core/package.json`; `git mv src/model → packages/core/src/model`; transformers dep moves; import fixes in `sidepanel.ts`, `agent.ts`, `bench/bench.ts`, 2 tests; tsconfig include; build.mjs ORT path | ~12 | ~60 |
| M2 | Move the page kit and ask rules to core | `git mv` 11 files (snapshot.js/.d.ts, kit, actuate, settle, browser, types, site, ask, dates, policy) to `packages/core/src/{page,text}`; import fixes in 9 agent files, panel, ~8 tests; build.mjs kit entry | ~32 | ~90 |
| M3 | Move dialogs and report to core | New `core/src/model/scorer.ts` takes `Scorer` and `Labels` out of `controller.ts`; move `Answer` type to core; `git mv dialogs.ts report.ts`; fix importers | ~14 | ~80 |
| M4 | Move the controller to packages/agent | `packages/agent/package.json`; `git mv` the 8 remaining `src/agent` files; fix imports in panel and tests; `src/` is now only the shell | ~16 | ~50 |
| M5 | Move the extension shell to apps/foxpilot | `git mv public/ src/panel src/background bin/` into `apps/foxpilot/`; `app.config.mjs`; build.mjs becomes the per-app engine writing `dist/<app>`; firefox.mjs takes `{app}`; e2e.mjs, zoo cli, mcp, lint:ext, release.yml `-s dist/foxpilot`; README paths | ~30 | ~220 |
| M6 | Colocate tests with their packages | `git mv tests/*` to `packages/core/tests` and `packages/agent/tests` (fixtures and `oracle.py` with the controller tests); `vitest.config.ts` include glob; fixture paths | ~30 | ~40 |
| M7 | Sign each app in a release matrix | `release.yml` plan + matrix; `scripts/release-plan.mjs`; tag `<app>-v<version>`; `apps/foxpilot/listing/amo.json` (unlisted); README "Branches" section | ~5 | ~200 |
| M8 | Self-update unlisted apps via update_url | `gecko.update_url` in foxpilot manifest; release job writes and attaches `<app>-updates.json` | ~3 | ~60 |
| M9 | Pick the model per app at build time | `models.ts` registry; `scripts/fetch-model.mjs` (pinned revision + sha256); `__MODEL__` define replaces `__GLINER__`; `Dtype` gains `q8`; delete the `GLINER` flag | ~8 | ~180 |
| M10 | Serve the model to content scripts | `core/src/model/host.ts`: `serveModel()` + `remoteScorer()` over `runtime.Port`; one browser test with a fake model | ~3 | ~150 |

Notes:

- M2 is the tightest on files (~32). If it goes over 35, split page kit and ask rules into two PRs.
- M5 is the riskiest: it changes every path the E2E uses. Do it in one PR so main is never half-moved, and have the lead run all three tasks plus `node scripts/mcp-smoke.mjs`.
- No shims. Each move deletes the old path in the same PR. No re-export files in `src/`.
- M1–M6 touch 4 top-level directories at most; the checker warns above 3 and does not fail.
- The tag scheme changes from `v<version>` to `foxpilot-v<version>` in M7. No tag exists yet, so nothing breaks.

## 3. App shortlist (ranked)

Rank uses three tests: does GLiNER2 on device do something rules cannot; is the input short (so `gliner2.5-small` on wasm works); is the privacy story clean enough for a listed AMO add-on. ★ = build first.

### 0. foxpilot (exists)

The on-device browser agent. Stays unlisted until the zoo-sites pass rate is above zero. Uses everything; multi-v1 on WebGPU.

### 1. ★ PII Guard: warn before you send personal data to an AI chat

- **Pitch:** Highlights names, emails, phone numbers, card numbers and addresses in your ChatGPT or Claude message before it leaves, and redacts them with one click. Detection runs in your browser.
- **Core pieces:** `text/ask.ts` shapes (email, phone, card, ZIP, CVV, code) as the fast, exact first pass; `Gliner2.extractEntities` for person, address, organization, date of birth, account number, health condition; `host.ts`.
- **Model:** `gliner2.5-small` q8 bundled, wasm. A chat message is 10–200 tokens, so 32–300 ms after a 300 ms typing pause. No GPU, no download.
- **Firefox APIs:** content scripts on a fixed host list (chatgpt.com, claude.ai, gemini.google.com, chat.mistral.ai, perplexity.ai, copilot.microsoft.com); `permissions.request` for optional extra sites; `storage.local` for per-site settings; background event page for the model. No `<all_urls>`.
- **Privacy story:** the best possible one. The add-on reads text you type on six sites, makes no network request, and stores no text. Reviewers can read the host list and see no `fetch`.
- **MVP (2 PRs):** (a) detect and underline PII in the composer, with a count badge; (b) intercept send (Enter and the send button, capture phase) when PII is present: "Send anyway / Redact and send", where redact swaps spans for `[NAME_1]`, `[EMAIL_1]` with `execCommand("insertText")` so ProseMirror composers keep the send button live.
- **Later:** restore the real values in the model's reply from a per-tab map; file and paste scanning; a "blur PII on screen" mode for screen sharing (absorbs idea 7).
- **Risks:** chat sites change their DOM often (keep selectors per site in one table with a fixture page each); false positives annoy, so the add-on warns and never blocks silently; 2.5-small is English-only (non-English names fall back to the shape rules; multilingual later via multi-v1 q8 if a test shows it fits); AMO policy is low-risk because nothing leaves the device.

### 2. ★ Consent Shield: refuse optional cookies and decline nag dialogs

- **Pitch:** On each page, it finds the cookie or newsletter dialog, presses "Reject all" or switches off the optional toggles, and never presses "Accept all".
- **Core pieces:** `dialogs.ts` (stance, `refusing`, `declining`, `acceptsAll`, toggle handling with `REQUIRED` kept on), `page/snapshot.js` (dialog controls), `page/actuate.ts` (`strike`), `page/settle.ts`, `host.ts`.
- **Model:** `gliner2.5-small` q8 bundled, wasm. Button labels are 1–8 words; `dialogs.ts` sends at most 8 buttons per dialog. Rules decide first; GLiNER2 decides only when the rules do not.
- **Firefox APIs:** content script on `<all_urls>` at `document_idle`, plus a MutationObserver for late dialogs; `storage.local` for a per-site log and an allowlist; `browserAction` badge with the count of refusals.
- **Privacy story:** reads button labels only; sends nothing; keeps a local log ("Rejected 3 optional purposes on example.com").
- **MVP (2 PRs):** (a) detect consent and nag dialogs and show what it would press (dry run, badge only); (b) press it, with a hard rule that a control matching `acceptsAll` is never pressed, plus a per-site off switch.
- **Eval:** the zoo-sites consent and dialog tasks that `dialogs.ts` was built for, plus synthetic fixtures for OneTrust-, Cookiebot- and TCF-shaped banners (written here, not copied).
- **Risks:** `<all_urls>` draws a closer AMO review (state the reason in the approval notes); in-page clicks are `isTrusted: false` and some CMPs ignore them; EU banners are often not in English, which 2.5-small does not read (the rules carry non-English "Reject" words; measure the rest); overlap with Firefox's built-in cookie banner handling and Consent-O-Matic, so the difference to state is nag dialogs and pre-ticked toggles, not cookies only.

### 3. Terms Audit: a yes/no audit of a terms or privacy page

- **Pitch:** On a terms or privacy policy page, answers 12 fixed questions (sells your data? AI training on your content? forced arbitration? class action waiver? auto-renewal? deletion on request? ...) with yes / no / not stated and the quote behind each answer.
- **Core pieces:** `page/snapshot.js` text blocks (or a reader pass), a chunker, `Gliner2.classify` per chunk with the 12 questions as labels, `report.ts` span extraction for the quote.
- **Model:** start on `gliner2.5-small` wasm (a 5,000-word policy is ~50 chunks of 128 tokens, about 12 s); measure multi-v1 WebGPU batching for the long-text case.
- **Firefox APIs:** `activeTab` + `scripting` (runs only on click, so no `<all_urls>`), sidebar or popup.
- **Privacy story:** runs only when you click, on the page you are on.
- **MVP (2 PRs):** (a) eval set first: 20 policies with ToS;DR labels (CC BY-SA; credit it) and a scorer; (b) the audit UI with quotes.
- **Risks:** a wrong "no" reads like legal advice. Show "not stated" when the score is low, always show the quote, and say it is not legal advice. Build it after the eval set shows per-question precision.

### 4. Local Autofill: fill odd forms from a profile that stays on your device

- **Pitch:** Fills a form from a profile you keep in the add-on, even when the labels are unusual ("Nom de famille", "Where should we ship?").
- **Core pieces:** `page/snapshot.js` fields, `Gliner2.classify` field label → profile key, `actuate.fillField`, `policy.ts` (never submit, never press buy), `ask.ts` value shapes to check what it typed.
- **Model:** `gliner2.5-small` bundled (labels are short); multi-v1 is the multilingual upgrade.
- **Firefox APIs:** `activeTab` + `scripting` on a toolbar click or shortcut; `storage.local` (optional passphrase with WebCrypto).
- **Privacy story:** the profile never leaves the device; nothing is filled without a click.
- **MVP:** 2 PRs (profile editor; fill on click with a preview).
- **Risks:** Firefox has built-in address and card autofill; the value is the odd form. A wrong field is visible before submit, because it never submits.

### 5. Page Grabber: turn any page into a table

- **Pitch:** Type the columns you want ("name, price, rating") and get a table from the list on the page, ready to copy as CSV.
- **Core pieces:** `report.ts` (`reportSlots`, `Reporter`), snapshot lists, `extractEntities` per list item.
- **Model:** `gliner2.5-small` for short items; multi-v1 for long pages.
- **Firefox APIs:** `activeTab`, `scripting`, `clipboardWrite`, `downloads`.
- **Privacy story:** runs on click; nothing leaves.
- **MVP:** 1–2 PRs. **Risks:** low; accuracy on messy lists.

### 6. Look-alike Guard: warn when a login page claims a brand it is not

- **Pitch:** When a page with a password field says "PayPal" but the site is not paypal.com, it warns you before you type.
- **Core pieces:** `extractEntities` (organization/brand) over title, headings, form text and image alt text; a bundled brand → domain map (top sites); punycode and confusable checks in plain code; `site.ts`.
- **Model:** `gliner2.5-small` bundled.
- **Firefox APIs:** content script on `<all_urls>` that wakes only when a password field appears; `webNavigation`.
- **MVP:** 2 PRs. **Risks:** false positives on real SSO pages (Microsoft, Okta, Auth0 host other brands' logins) need an allowlist; Firefox Safe Browsing covers known sites, so the value is new look-alikes only; a missed warning can give false trust, so the copy must not say "safe".

### 7. Screen Blur: hide personal data on the page before you share your screen

Shares PII Guard's detector. Toggle blurs PII text nodes on the current page. Ship as a mode of PII Guard, not a separate add-on, unless the listing test shows demand.

### 8. Date Catcher: add an event on the page to your calendar

Select text → `.ics` download. Uses `dates.ts` and `extractEntities` (event, date, time, place). `gliner2.5-small`. 1 PR. Low value; build last.

### Why PII Guard and Consent Shield first

- Both run on short text, so both use the 86 MB bundled 2.5-small model. That proves the bundled-model path (M9, M10) that apps 3–8 reuse.
- PII Guard is the owner's idea with the cleanest AMO case (fixed host list, no network). Consent Shield reuses the most existing code (`dialogs.ts`, kit, actuate) and has a ready eval (zoo-sites dialog tasks).
- Terms Audit (owner's idea) is third because a wrong answer costs trust. It needs its eval set before UI work. Start the eval set in parallel.

## 4. Issues

| Epic | Issue | Slices |
| --- | --- | --- |
| Publish several apps from one repo | #108 | #109, #110, #111, #112, #113, #114, #115, #116, #117, #118, #119 |
| Ship PII Guard for AI chat sites | #120 | #121, #122, #123, #124 |
| Ship Consent Shield | #125 | #126, #127, #128, #129 |

The backlog apps (Terms Audit and its eval, Local Autofill, Page Grabber, Look-alike Guard, and a multilingual wasm measurement) are filed as single issues with the `triage` label.

## 5. Open decisions for the owner

1. Land fxp-88 before M1 (recommended) or port it in A10.
2. Bundle 2.5-small in each app (recommended: no network, ~110 MB per update) or download it from the Hub on first run (small updates, a network request).
3. Listed or unlisted per app. Recommended: PII Guard and Consent Shield listed; foxpilot unlisted.
4. App names and gecko ids. They are permanent after the first AMO upload.
