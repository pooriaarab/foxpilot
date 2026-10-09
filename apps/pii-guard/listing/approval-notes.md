# Notes for AMO reviewers

## What runs where

- `content.js` runs only on the AI chat sites in `content_scripts.matches`. It reads the text in the message box and draws marks in one overlay element that it adds to the page. It leaves the message box as the site made it, unless the user picks "Redact and send".
- `background.js` runs the foxmind-small model (ONNX, q8) with ONNX Runtime Web on WebAssembly. The content script sends the text to it over a `runtime.connect` port.
- `popup.js` is empty. The popup is static text.

## No network, no storage

The add-on makes no network request. The model and the ONNX Runtime wasm ship inside the package, and `packages/core/src/model/load.ts` sets `env.allowRemoteModels = false`. The add-on asks for no `storage` permission and keeps no text. The manifest declares `data_collection_permissions` as `required: ["none"]`.

## Why `wasm-unsafe-eval`

ONNX Runtime Web compiles its WebAssembly module in the background page. The extension-page CSP needs `'wasm-unsafe-eval'` for that. It does not allow `eval` or `new Function`.

## web-ext lint warnings

`web-ext lint` reports 0 errors and 3 warnings. All three are in third-party code:

- `DANGEROUS_EVAL` in `ort/ort-wasm-simd-threaded.asyncify.mjs`: ONNX Runtime Web, copied unchanged from the `onnxruntime-web` package.
- `DANGEROUS_EVAL` in `background.js`: a `new Function` call inside `@huggingface/transformers`, bundled by esbuild. The add-on code does not call it. If it ever ran, the extension-page CSP (`script-src 'self' 'wasm-unsafe-eval'`) would block it.
- `UNSAFE_VAR_ASSIGNMENT` in `background.js`: a dynamic `import()` in `@huggingface/transformers`. It loads the ONNX Runtime `.mjs` from the URL that `load.ts` sets with `chrome.runtime.getURL("ort/...")`, which is inside the package.

## Build

The bundles are minified and include a model. `BUILD.md` in this folder has the exact steps, the pinned model commit and the sha256 of each model file.
