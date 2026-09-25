// GLiNER2 in JavaScript: the two calls the agent makes, entity extraction and
// label classification, on one fused ONNX graph (see export/export_onnx.py).
// Encoding and decoding follow the Python gliner2 processor and runtime so
// token ids and results match it (tests/parity.test.ts).
import { AutoModel, AutoTokenizer, Tensor } from "@huggingface/transformers";
import type { PreTrainedModel, PreTrainedTokenizer } from "@huggingface/transformers";

export type Labels = Record<string, string | undefined>;
export type Entity = { text: string; confidence: number; start: number; end: number };
export type Device = "webgpu" | "wasm" | "cpu";
export type Dtype = "fp32" | "fp16";

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

export class Gliner2 {
  private constructor(
    private readonly model: PreTrainedModel,
    private readonly tokenizer: PreTrainedTokenizer,
    private readonly ids: Record<Special, number>,
  ) {}

  static async load(
    modelId: string,
    options: { device?: Device; dtype?: Dtype; progress_callback?: (info: unknown) => void } = {},
  ): Promise<Gliner2> {
    const tokenizer = await AutoTokenizer.from_pretrained(modelId);
    const model = await AutoModel.from_pretrained(modelId, {
      device: options.device ?? "webgpu",
      dtype: options.dtype ?? "fp16",
      progress_callback: options.progress_callback,
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
    return new Gliner2(model, tokenizer, ids);
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

  private async run(encoded: Encoded) {
    const n = encoded.inputIds.length;
    const long = (values: number[]) => new Tensor("int64", BigInt64Array.from(values, BigInt), [1, values.length]);
    const outputs = (await this.model({
      input_ids: long(encoded.inputIds),
      attention_mask: long(new Array<number>(n).fill(1)),
      word_positions: long(encoded.wordPositions),
      schema_positions: long(encoded.schemaPositions),
    })) as Record<"cls_logits" | "count_logits" | "span_logits", Tensor>;
    const floats = (tensor: Tensor) => Array.from(tensor.to("float32").data as Float32Array);
    return {
      cls: floats(outputs.cls_logits),
      count: floats(outputs.count_logits),
      span: floats(outputs.span_logits),
      spanDims: outputs.span_logits.dims as number[],
    };
  }

  /** Softmax over the labels, like ClassificationSchema().single(..., activation="softmax"). */
  async classify(text: string, name: string, labels: Labels): Promise<Record<string, number>> {
    const encoded = this.encode(text, { name, marker: "[L]", labels });
    const { cls } = await this.run(encoded);
    const max = Math.max(...cls);
    const exp = cls.map((x) => Math.exp(x - max));
    const sum = exp.reduce((a, b) => a + b, 0);
    return Object.fromEntries(Object.keys(labels).map((label, i) => [label, exp[i]! / sum]));
  }

  /** extract_entities(text, types) with include_confidence and include_spans. */
  async extractEntities(text: string, types: Labels, threshold = 0.5): Promise<Record<string, Entity[]>> {
    const encoded = this.encode(text, { name: "entities", marker: "[E]", labels: types });
    const { count, span, spanDims } = await this.run(encoded);
    const names = Object.keys(types);
    const result: Record<string, Entity[]> = Object.fromEntries(names.map((name) => [name, []]));
    if (argmax(count) <= 0) return result;

    const [, , words, width] = spanDims as [number, number, number, number];
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
