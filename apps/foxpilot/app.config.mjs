// How scripts/build.mjs builds this app into dist/foxpilot/. The gecko id and
// the version live in public/manifest.json.
export default {
  name: "foxpilot",
  // Entry name -> source, relative to this directory or a package export.
  // kit.js is injected into pages with scripting.executeScript({files}), so it is a plain script, not a module.
  entries: {
    sidepanel: "src/panel/sidepanel.ts",
    background: "src/background/background.ts",
    kit: { in: "@foxpilot/core/page/kit", format: "iife" },
  },
  // The panel runs GLiNER2 itself, so the build ships ONNX Runtime's wasm.
  model: "gliner2-multi-v1",
};
