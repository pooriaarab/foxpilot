# Build PII Guard from source

These steps are for AMO reviewers. They rebuild the submitted package from the source archive, byte for byte.

The package is minified by esbuild. It also holds files that are not built from this repo: the foxmind-small model and the ONNX Runtime WebAssembly files. The steps below say where each one comes from and how the build checks it.

## Requirements

- macOS or Linux. The release build runs on `ubuntu-latest` in GitHub Actions (`.github/workflows/release.yml`).
- Node.js 24. CI uses `actions/setup-node` with `node-version: 24`. We also built it with Node 25.9.0.
- pnpm 10.11.0. The root `package.json` pins it in `packageManager`. Run `corepack enable` to get that version.
- Network access to `registry.npmjs.org` and `huggingface.co`, for the first build only.
- About 250 MB of free disk space for the model cache and `dist/`.

## Steps

Run these from the root of the source archive.

1. Install the dependencies at the versions in `pnpm-lock.yaml`:

   ```sh
   PUPPETEER_SKIP_DOWNLOAD=1 pnpm install --frozen-lockfile
   ```

   `PUPPETEER_SKIP_DOWNLOAD=1` skips a browser download that only the end-to-end tests use. It does not change the build.

2. Build the add-on:

   ```sh
   node scripts/build.mjs pii-guard
   ```

   The output is in `dist/pii-guard/`. The script ends with `built .../dist/pii-guard (122.2 MB)`.

## What the build does

`scripts/build.mjs` reads `apps/pii-guard/app.config.mjs` and does these steps:

1. It copies `apps/pii-guard/public/` (manifest, popup HTML, icons) to `dist/pii-guard/`.
2. It copies two ONNX Runtime files from the installed `onnxruntime-web` package (`node_modules/.pnpm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/node_modules/onnxruntime-web/dist/`) to `dist/pii-guard/ort/`: `ort-wasm-simd-threaded.asyncify.mjs` and `ort-wasm-simd-threaded.asyncify.wasm`. The lockfile pins the version (1.31.0-dev.20260914-8d85527a0, a dependency of `@huggingface/transformers` 4.3.0). Firefox does not allow remote code in an extension, so the wasm must ship inside it.
3. It gets the model files and copies them to `dist/pii-guard/models/foxmind-small/`. See "Where the model comes from".
4. It bundles and minifies `background.js`, `content.js` and `popup.js` from `apps/pii-guard/src/` with esbuild (target `firefox157`). The bundles include the shared code in `packages/core/` and `@huggingface/transformers`.

## Where the model comes from

The model is foxmind-small, a GLiNER2.5 small model exported to ONNX and quantized to q8. It is public on the Hugging Face Hub under the Apache-2.0 license: https://huggingface.co/pooria/foxmind-small

`packages/core/src/model/models.ts` pins the Hub commit and the sha256 of every file:

| File | sha256 |
| --- | --- |
| `config.json` | `fcde8187356470580834e033600f3d7d81ed312b3837f5aad8b60c019d52283b` |
| `tokenizer.json` | `cbc8ae6037812709c9c26f2a160f8dc48b0440bcb79c8141804259ae2d6adac3` |
| `tokenizer_config.json` | `fd4a31dc2f1f17e31638c5f0e783b81cdb2fbe6bddd116a8d9e5d50d78148cf1` |
| `onnx/model_quantized.onnx` | `c479c7b8090e72da2fc82a72a0904697c32a0a6f61cbb93c4aff4ea4ed29836b` |

The pinned commit is `bcd5cdcaa66a4d8b16ed22e4a9858becc9f7e4d7`. `scripts/fetch-model.mjs` downloads each file from `https://huggingface.co/pooria/foxmind-small/resolve/<commit>/<file>` into `~/.cache/foxpilot/models/pooria/foxmind-small@<commit>/`. Then it checks each sha256. If a file does not match, the script deletes it and the build fails. To fetch the model alone, run `node scripts/fetch-model.mjs foxmind-small`.

At run time the add-on loads the model from inside the package only. `packages/core/src/model/load.ts` sets `env.allowRemoteModels = false` for a bundled model.

## Compare the output with the submitted package

1. Unzip the package from AMO into a new folder:

   ```sh
   mkdir /tmp/amo-pii-guard && unzip -q <downloaded>.xpi -d /tmp/amo-pii-guard
   ```

2. Compare it with your build. A signed package also has a `META-INF/` folder with the signature, which the build does not make:

   ```sh
   diff -r -x META-INF dist/pii-guard /tmp/amo-pii-guard
   ```

   No output means the files are the same.

We built `pii-guard` twice from a clean `dist/` and got the same sha256 for every file.

## Third-party code in the package

- `@huggingface/transformers` 4.3.0 (Apache-2.0), bundled into `background.js`.
- ONNX Runtime Web 1.31.0-dev.20260914-8d85527a0 (MIT), in `ort/`.
- foxmind-small model files (Apache-2.0), in `models/foxmind-small/`.

## Screenshots

The AMO screenshot candidates live on GitHub, not in the repo (the repo keeps no media). They are real Firefox screenshots from the end-to-end test page (`apps/pii-guard/e2e/fixtures/composer.html`), not from a live chat site.

- [pii-guard-prompt.png](https://github.com/user-attachments/assets/8a39456d-a698-4821-b69c-428a5ecef7c3): the marks in a message box, and the prompt that shows when you send a message with personal data.
- [pii-guard-redacted.png](https://github.com/user-attachments/assets/40975a2e-ccba-412c-ac09-2d5c9d6f1c6c): the message after "Redact and send", with numbered tags.
