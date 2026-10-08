// GLiNER2 in JavaScript: the two calls the agent makes, entity extraction and
// label classification, on one fused ONNX graph (see export/export_onnx.py).
// Encoding and decoding follow the Python gliner2 processor and runtime so
// token ids and results match it (tests/parity.test.ts).
import { AutoModel, AutoTokenizer, Tensor, env } from "@huggingface/transformers";
import type { PreTrainedModel, PreTrainedTokenizer } from "@huggingface/transformers";

export type Labels = Record<string, string | undefined>;
export type Entity = { text: string; confidence: number; start: number; end: number };
export type Device = "webgpu" | "wasm" | "cpu";
export type Dtype = "fp32" | "fp16" | "q8";

/** Same pattern as gliner2's WhitespaceTokenSplitter. */
const WORD =
  /(?:https?:\/\/[^\s]+|www\.[^\s]+)|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|@[a-z0-9_]+|\w+(?:[-_]\w+)*|\S/giu;

const SPECIAL = ["[P]", "[E]", "[L]", "[SEP_TEXT]", "[DESCRIPTION]"] as const;
type Special = (typeof SPECIAL)[number];

export type Encoded = {
  inputIds: number[];
  wordPositions: number[];
  schemaPositions: number[];
  /** Character offsets of each text word in the (period-terminated) text. */
  starts: number[];
  ends: number[];
  text: string;
};

export type EncodeTask = { name: string; marker: "[E]" | "[L]"; labels: Labels };

type Read = { data: number[]; dims: number[] };

export class Gliner2 {
  constructor(
    private readonly model: PreTrainedModel,
    private readonly tokenizer: PreTrainedTokenizer,
    private readonly ids: Record<Special, number>,
  ) {}

  /** Loads into the calling class, so Gliner25.load gives a Gliner25. */
  static async load<T extends Gliner2>(
    this: new (model: PreTrainedModel, tokenizer: PreTrainedTokenizer, ids: Record<Special, number>) => T,
    modelId: string,
    options: {
      device?: Device;
      dtype?: Dtype;
      progress_callback?: (info: unknown) => void;
      /** ONNX Runtime session options; bench/bench.ts uses them. */
      session_options?: Record<string, unknown>;
    } = {},
  ): Promise<T> {
    const device = options.device ?? "webgpu";
    const tokenizer = await AutoTokenizer.from_pretrained(modelId);
    const model = await AutoModel.from_pretrained(modelId, {
      device,
      dtype: options.dtype ?? "fp16",
      progress_callback: options.progress_callback,
      // On WebGPU, outputs stay on the GPU. Reading every output back costs
      // about 200 ms per call in Firefox (#70), so run() reads only what it needs.
      session_options: {
        ...(device === "webgpu" ? { preferredOutputLocation: "gpu-buffer" } : {}),
        ...options.session_options,
      },
    });
    // Added tokens encode to exactly one id.
    const ids = Object.fromEntries(
      SPECIAL.map((token) => {
        const { input_ids } = tokenizer(token, { add_special_tokens: false }) as { input_ids: Tensor };
        const encoded = Array.from(input_ids.data as ArrayLike<bigint | number>, Number);
        if (encoded.length !== 1) throw new Error(`tokenizer has no single id for ${token}`);
        return [token, encoded[0]!];
      }),
    ) as Record<Special, number>;
    return new this(model, tokenizer, ids);
  }

  private pieces(text: string): number[] {
    const { input_ids } = this.tokenizer(text, { add_special_tokens: false }) as { input_ids: Tensor };
    return Array.from(input_ids.data as ArrayLike<bigint | number>, Number);
  }

  /**
   * `( [P] name [DESCRIPTION] label: desc … ( [E] label … ) ) [SEP_TEXT] words`.
   * The prompt and labels keep their case and are tokenized whole; the text
   * gets a terminal "." if it has none, is split with WORD and lowercased,
   * and each word is tokenized on its own (its first piece is its position).
   */
  encode(input: string, task: EncodeTask): Encoded {
    const text = !input ? "." : /[.!?]$/.test(input) ? input : `${input}.`;
    const labelNames = Object.keys(task.labels);
    const prompt =
      task.name +
      labelNames
        .map((label) => (task.labels[label] ? ` [DESCRIPTION] ${label}: ${task.labels[label]}` : ""))
        .join("");

    const inputIds: number[] = [];
    const schemaPositions: number[] = [];
    const push = (ids: number[]) => inputIds.push(...ids);
    const special = (token: Special) => {
      if (token === "[P]" || token === task.marker) schemaPositions.push(inputIds.length);
      inputIds.push(this.ids[token]);
    };
    push(this.pieces("("));
    special("[P]");
    // Whole string, as the processor does; the tokenizer maps [DESCRIPTION] itself.
    push(this.pieces(prompt));
    push(this.pieces("("));
    for (const label of labelNames) {
      special(task.marker);
      push(this.pieces(label));
    }
    push(this.pieces(")"));
    push(this.pieces(")"));
    special("[SEP_TEXT]");

    const wordPositions: number[] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    for (const match of text.matchAll(WORD)) {
      wordPositions.push(inputIds.length);
      starts.push(match.index);
      ends.push(match.index + match[0].length);
      push(this.pieces(match[0].toLowerCase()));
    }
    return { inputIds, wordPositions, schemaPositions, starts, ends, text };
  }

  /** Runs the graph and reads back only `names`. Every output on the GPU is released. */
  protected async run<K extends string>(encoded: Encoded, names: K[]): Promise<Record<K, Read>> {
    const n = encoded.inputIds.length;
    const long = (values: number[]) => new Tensor("int64", BigInt64Array.from(values, BigInt), [1, values.length]);
    const outputs = (await this.model({
      input_ids: long(encoded.inputIds),
      attention_mask: long(new Array<number>(n).fill(1)),
      word_positions: long(encoded.wordPositions),
      schema_positions: long(encoded.schemaPositions),
    })) as Record<string, Tensor>;
    try {
      const read = await readBack(names.map((name) => outputs[name]!));
      return Object.fromEntries(
        names.map((name, i) => [name, { data: Array.from(read[i]!.to("float32").data as Float32Array), dims: read[i]!.dims }]),
      ) as Record<K, Read>;
    } finally {
      for (const tensor of Object.values(outputs)) if (tensor.location === "gpu-buffer") tensor.dispose();
    }
  }

  /** Softmax over the labels, like ClassificationSchema().single(..., activation="softmax"). */
  async classify(text: string, name: string, labels: Labels): Promise<Record<string, number>> {
    const encoded = this.encode(text, { name, marker: "[L]", labels });
    const cls = (await this.run(encoded, ["cls_logits"])).cls_logits.data;
    const max = Math.max(...cls);
    const exp = cls.map((x) => Math.exp(x - max));
    const sum = exp.reduce((a, b) => a + b, 0);
    return Object.fromEntries(Object.keys(labels).map((label, i) => [label, exp[i]! / sum]));
  }

  /** extract_entities(text, types) with include_confidence and include_spans. */
  async extractEntities(text: string, types: Labels, threshold = 0.5): Promise<Record<string, Entity[]>> {
    const encoded = this.encode(text, { name: "entities", marker: "[E]", labels: types });
    const read = await this.run(encoded, ["count_logits", "span_logits"]);
    const count = read.count_logits.data;
    const span = read.span_logits.data;
    const names = Object.keys(types);
    const result: Record<string, Entity[]> = Object.fromEntries(names.map((name) => [name, []]));
    if (argmax(count) <= 0) return result;

    const [, , words, width] = read.span_logits.dims as [number, number, number, number];
    names.forEach((name, li) => {
      const raw: Entity[] = [];
      for (let start = 0; start < words; start++) {
        for (let w = 0; w < width; w++) {
          const end = start + w + 1;
          if (end > words) continue;
          const confidence = sigmoid(span[(li * words + start) * width + w]!);
          if (confidence < threshold) continue;
          const charStart = encoded.starts[start]!;
          const charEnd = encoded.ends[end - 1]!;
          const surface = encoded.text.slice(charStart, charEnd).trim();
          if (surface) raw.push({ text: surface, confidence, start: charStart, end: charEnd });
        }
      }
      result[name] = finalizeSpans(raw);
    });
    return result;
  }
}

type GpuBuffer = { mapAsync(mode: number): Promise<void>; getMappedRange(): ArrayBuffer; destroy(): void };
type GpuDevice = {
  createBuffer(descriptor: { size: number; usage: number }): GpuBuffer;
  createCommandEncoder(): {
    copyBufferToBuffer(source: unknown, sourceOffset: number, target: GpuBuffer, targetOffset: number, size: number): void;
    finish(): unknown;
  };
  queue: { submit(buffers: unknown[]): void };
};

/**
 * Copies every GPU tensor in `tensors` to the CPU with one mapAsync: each
 * GPU to CPU round trip costs about 90 ms in Firefox (#70). CPU tensors pass
 * through unchanged.
 */
async function readBack(tensors: Tensor[]): Promise<Tensor[]> {
  const onGpu = tensors.filter((tensor) => tensor.location === "gpu-buffer");
  if (!onGpu.length) return tensors;
  const device = (env.backends.onnx as { webgpu?: { device?: GpuDevice } }).webgpu?.device;
  if (!device) throw new Error("ONNX Runtime has no WebGPU device");
  // ONNX Runtime pads GPU buffers to 16 bytes, so each padded copy stays inside its buffer.
  const bytes = onGpu.map((tensor) => {
    if (tensor.type !== "float32" && tensor.type !== "float16") throw new Error(`cannot read back ${tensor.type}`);
    return tensor.size * (tensor.type === "float16" ? 2 : 4);
  });
  const padded = bytes.map((size) => Math.ceil(size / 16) * 16);
  const offsets = padded.map((_, i) => padded.slice(0, i).reduce((a, b) => a + b, 0));
  // MAP_READ | COPY_DST
  const staging = device.createBuffer({ size: padded.reduce((a, b) => a + b, 0), usage: 0x01 | 0x08 });
  try {
    const encoder = device.createCommandEncoder();
    onGpu.forEach((tensor, i) => encoder.copyBufferToBuffer(tensor.ort_tensor.gpuBuffer, 0, staging, offsets[i]!, padded[i]!));
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(0x01); // GPUMapMode.READ
    const data = staging.getMappedRange().slice(0);
    return tensors.map((tensor) => {
      const i = onGpu.indexOf(tensor);
      if (i < 0) return tensor;
      const values =
        tensor.type === "float16" ? new Uint16Array(data, offsets[i], tensor.size) : new Float32Array(data, offsets[i], tensor.size);
      return new Tensor(tensor.type as "float16" | "float32", values, tensor.dims);
    });
  } finally {
    staging.destroy();
  }
}

/** gliner2's default span decoder: confidence-first greedy, no character overlaps. */
export function finalizeSpans(raw: Entity[]): Entity[] {
  const kept: Entity[] = [];
  for (const candidate of [...raw].sort((a, b) => b.confidence - a.confidence)) {
    if (kept.some((existing) => candidate.start < existing.end && existing.start < candidate.end)) continue;
    kept.push(candidate);
  }
  return kept;
}

function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

function argmax(values: number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i]! > values[best]!) best = i;
  return best;
}
