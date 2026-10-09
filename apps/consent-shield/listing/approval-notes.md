# Notes for AMO reviewers

## Why `<all_urls>`

A consent dialog can appear on any site. The user does not choose the sites in advance, so no fixed host list can work.

The content script runs in the top frame of every page at `document_idle`. It does these steps:

1. It finds dialogs that float over the page: `dialog[open]`, `role="dialog"`, `aria-modal`, and fixed or sticky boxes with buttons within three levels of `<body>`. It reads a dialog's text to tell a cookie dialog from a newsletter or notification prompt. It skips every other dialog.
2. It sends the labels of the dialog's controls to the background page. The model there picks the next step.
3. It takes one step: it switches off an optional toggle, opens the next layer, goes back a layer, scrolls the dialog, or presses "Reject", "Save" or "No thanks".
4. It waits for the page to change, and then plans the next step.

A hard guard in `content.ts` checks the label on screen right before each click. It never presses a control whose label matches `accept`, `agree`, `allow all`, `enable all` or `consent`. It never switches off a toggle labelled `essential`, `necessary`, `required` or `strictly`. It clicks only controls inside the dialog. It takes at most 60 steps on a page and spends at most 60 seconds on a dialog. When a step fails, it stops and leaves the page as it is.

The user can switch the add-on off for each site in the popup. That list of host names is in `storage.local`. The log of steps for each tab is in `storage.session`, and the popup shows it. The background page deletes a tab's log when the tab closes.

## No network

The add-on makes no network request. The model (foxmind-small, ONNX, q8) and the ONNX Runtime wasm ship inside the package and run in the background page with WebAssembly. `packages/core/src/model/load.ts` sets `env.allowRemoteModels = false`. The manifest declares `data_collection_permissions` as `required: ["none"]`.

## web-ext lint warnings

`web-ext lint` reports 0 errors and 3 warnings. All three are in third-party code:

- `DANGEROUS_EVAL` in `ort/ort-wasm-simd-threaded.asyncify.mjs`: ONNX Runtime Web, copied unchanged from the `onnxruntime-web` package.
- `DANGEROUS_EVAL` in `background.js`: a `new Function` call inside `@huggingface/transformers`, bundled by esbuild. The add-on code does not call it. If it ever ran, the extension-page CSP (`script-src 'self' 'wasm-unsafe-eval'`) would block it.
- `UNSAFE_VAR_ASSIGNMENT` in `background.js`: a dynamic `import()` in `@huggingface/transformers`. It loads the ONNX Runtime `.mjs` from the URL that `load.ts` sets with `chrome.runtime.getURL("ort/...")`, which is inside the package.

## Build

The bundles are minified and include a model. `BUILD.md` in this folder has the exact steps, the pinned model commit and the sha256 of each model file.
