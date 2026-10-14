// How scripts/build.mjs builds this app into dist/consent-shield/. The gecko id and
// the version live in public/manifest.json.
export default {
  name: "consent-shield",
  // Entry name -> source, relative to this directory.
  // content.js is a manifest content script, so it is a plain script, not a module.
  entries: {
    background: "src/background.ts",
    content: { in: "src/content.ts", format: "iife" },
    popup: "src/popup.ts",
  },
  // A key of packages/core/src/model/models.ts. foxmind-small ships inside the add-on,
  // so the app makes no network request for it. The build adds ONNX Runtime's wasm.
  model: "foxmind-small",
};
