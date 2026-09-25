// Values to type into fields. Two writers, both local:
// - SpanWriter types the value GLiNER extracted from the goal for the
//   requirement that chose the field (no extra model).
// - LlmWriter asks a small local LLM (Qwen3 on WebGPU) for the value, like
//   gliner2-ultrafast's text helper but without leaving the browser.
// Either may refuse; the agent then stops offering that field.
import { pipeline, type TextGenerationPipeline } from "@huggingface/transformers";
import type { Part } from "./controller";
import { isSearchField, searchQuery } from "./search";

export { isSearchField, searchQuery };

export class Refused extends Error {}

export type FieldContext = {
  goal: string;
  requirement: string | null;
  field: { label: string; role?: string; value?: string };
  page: { title: string; text: string };
  recent_actions: { action: string; text?: string | null }[];
  /** The requirement's parsed date, when it has one. */
  date: string | null;
  /** Values GLiNER extracted from the requirement (surface form). */
  candidates: string[];
  /** How many distinct text fields the page offers. */
  textFields: number;
};

export interface FieldWriter {
  readonly name: string;
  write(context: FieldContext): Promise<string>;
}

/** Types the extracted span for the requirement; dates go in as ISO. */
export class SpanWriter implements FieldWriter {
  readonly name = "GLiNER spans";

  constructor(
    private readonly parts: Part[],
    /** Lowercased value → its surface form in the goal. */
    private readonly surfaces: Map<string, string>,
  ) {}

  async write(context: FieldContext): Promise<string> {
    // Into a search box, the goal is the query itself ("Weather in Seattle"),
    // not the value one part of it names ("Seattle"): always for short goals,
    // and for any goal when the search box is the page's only text field (a
    // search engine home page given a whole trip to find).
    if (isSearchField(context.field) && (this.parts.length <= 2 || context.textFields === 1)) {
      return searchQuery(context.goal);
    }
    const part = this.parts.find((p) => p.text === context.requirement);
    if (!part) throw new Refused("No requirement chose this field");
    if (part.date) return part.date;
    if (!part.values.length) throw new Refused(`"${part.text}" names no value to type`);
    const lowered = part.text.toLowerCase();
    const first = [...part.values].sort((a, b) => lowered.indexOf(a) - lowered.indexOf(b))[0]!;
    return this.surfaces.get(first) ?? first;
  }
}

// From gliner2-ultrafast questions.py (MIT).
// Adapted: a 0.6B model copies values it sees on the page (a pre-filled
// "Where from? Seattle" beat "from New York" in the goal), so it gets the
// goal, the requirement, the field and GLiNER's candidate values, not page text.
const TEXT_VALUE = `Return a JSON object with exactly one key, text: the exact string to enter in the selected field.
Take the value from the selected requirement of the goal. Prefer one of the candidate values when one fits.
When the goal names multiple values, use only the value for the selected requirement; do not jump ahead.
No commentary, code, or browser actions. Never invent personal information.
If the requirement names no value for this field, return {"text": null}. Otherwise return {"text": "the field value"}.`;

export const LLM_MODEL = "onnx-community/Qwen3-0.6B-ONNX";

/** Qwen3-0.6B on WebGPU writes the value, as JSON, from the goal and field. */
export class LlmWriter implements FieldWriter {
  readonly name = "Qwen3-0.6B (local)";
  private generator: Promise<TextGenerationPipeline> | null = null;

  constructor(private readonly onProgress?: (progress: number) => void) {}

  load(): Promise<TextGenerationPipeline> {
    this.generator ??= pipeline("text-generation", LLM_MODEL, {
      dtype: "q4f16",
      device: "webgpu",
      progress_callback: (info: { status?: string; progress?: number }) => {
        if (info.status === "progress_total" && typeof info.progress === "number") this.onProgress?.(info.progress / 100);
      },
    }) as Promise<TextGenerationPipeline>;
    return this.generator;
  }

  async write(context: FieldContext): Promise<string> {
    if (isSearchField(context.field) && context.textFields === 1) return searchQuery(context.goal);
    const generator = await this.load();
    const messages = [
      { role: "system", content: TEXT_VALUE },
      {
        role: "user",
        content: JSON.stringify({
          goal: context.goal,
          requirement: context.requirement,
          field: context.field.label,
          candidates: context.candidates,
          ...(context.date ? { date: context.date } : {}),
        }),
      },
    ];
    // enable_thinking reaches Qwen3's template through apply_chat_template's
    // extra kwargs, which the typings don't list.
    const options = { tokenize: false as const, add_generation_prompt: true, enable_thinking: false };
    const prompt = generator.tokenizer.apply_chat_template(messages, options as { tokenize: false; add_generation_prompt: boolean }) as string;
    // One malformed reply is a bad sample, not a missing value; ask once more.
    for (let attempt = 0; attempt < 2; attempt++) {
      const [output] = (await generator(prompt, { max_new_tokens: 48, do_sample: false, return_full_text: false })) as {
        generated_text: string;
      }[];
      const value = parseValue(output?.generated_text ?? "");
      if (value === null) throw new Refused("The goal supplies no value for this field");
      if (value !== undefined) return value;
    }
    throw new Refused("The text model returned no valid field value");
  }
}

/** The "text" of the reply's JSON object; null when it says there is none, undefined when malformed. */
export function parseValue(reply: string): string | null | undefined {
  const match = reply.match(/\{[\s\S]*?\}/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (Object.keys(parsed).length !== 1 || !("text" in parsed)) return undefined;
    if (parsed.text === null) return null;
    if (typeof parsed.text !== "string" || !parsed.text.trim() || parsed.text.length > 2000) return undefined;
    return parsed.text;
  } catch {
    return undefined;
  }
}
