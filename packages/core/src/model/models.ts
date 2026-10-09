// The models an app can name in its app.config.mjs `model`. scripts/build.mjs
// reads this file (Node strips the types) and gives the chosen entry to the
// app as __MODEL__. Keep it data only: no imports.

export type Device = "webgpu" | "wasm" | "cpu";
export type Dtype = "fp32" | "fp16" | "q8";

export type Model = {
  /** Hugging Face Hub repo. */
  repo: string;
  /** Commit on the Hub. Hub models download this commit; bundled models were fetched from it. */
  revision: string;
  /** "hub": downloads on first use into the panel's Cache API. "bundle": ships in the .xpi, no network. */
  delivery: "hub" | "bundle";
  device: Device;
  dtype: Dtype;
  /** The runtime class: Gliner2 (span_logits) or Gliner25 (boundary span pool). */
  decoder: "gliner2" | "gliner25";
  /** Bundled models only: every file the runtime loads, and its sha256. */
  files?: Record<string, string>;
};

export const models = {
  // GLiNER2 multi-v1, 614 MB fp16. Long or multilingual input, many labels per call.
  foxmind: {
    repo: "pooria/foxmind",
    revision: "ba964330dcace558314de2bf3c230934d05aed36",
    delivery: "hub",
    device: "webgpu",
    dtype: "fp16",
    decoder: "gliner2",
  },
  // GLiNER2.5 small, 86 MB q8. Short English input; needs no GPU (#88).
  "foxmind-small": {
    repo: "pooria/foxmind-small",
    revision: "bcd5cdcaa66a4d8b16ed22e4a9858becc9f7e4d7",
    delivery: "bundle",
    device: "wasm",
    dtype: "q8",
    decoder: "gliner25",
    files: {
      "config.json": "fcde8187356470580834e033600f3d7d81ed312b3837f5aad8b60c019d52283b",
      "tokenizer.json": "cbc8ae6037812709c9c26f2a160f8dc48b0440bcb79c8141804259ae2d6adac3",
      "tokenizer_config.json": "fd4a31dc2f1f17e31638c5f0e783b81cdb2fbe6bddd116a8d9e5d50d78148cf1",
      "onnx/model_quantized.onnx": "c479c7b8090e72da2fc82a72a0904697c32a0a6f61cbb93c4aff4ea4ed29836b",
    },
  },
} satisfies Record<string, Model>;

export type ModelName = keyof typeof models;
