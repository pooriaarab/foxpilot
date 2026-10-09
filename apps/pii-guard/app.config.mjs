// How scripts/build.mjs builds this app into dist/pii-guard/. The gecko id and
// the version live in public/manifest.json.
export default {
  name: "pii-guard",
  // Entry name -> source, relative to this directory. A content script is a plain script, not a module.
  entries: {
    background: "src/background/background.ts",
    content: { in: "src/content/content.ts", format: "iife" },
    popup: "src/popup/popup.ts",
  },
  // A key of packages/core/src/model/models.ts. foxmind-small ships inside the add-on,
  // so the app makes no network request for it. The background page runs it (B2).
  model: "foxmind-small",
};
