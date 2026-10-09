// GLiNER2.5 (foxmind-small: fastino/gliner2.5-small-v1, boundary architecture)
// behind the same two calls as Gliner2. Its graph takes the same inputs and
// gives the same cls_logits, so encode and classify are inherited. Only entity decoding differs: the graph scores one shared pool of
// candidate spans for each label, and the spans are then resolved with
// gliner2's "flat" overlap policy, as BoundaryExtractor._decode_entities does.
import { Gliner2, type Entity } from "./gliner2";
import type { Labels } from "./scorer";

/** A candidate span in word boundaries: words start .. end - 1. */
type Scored = { confidence: number; start: number; end: number; index: number };

export class Gliner25 extends Gliner2 {
  /** The foxmind-small graph has a fixed batch of 1, so each text is its own run. */
  override async classifyMany(texts: string[], name: string, labels: Labels): Promise<Record<string, number>[]> {
    const results: Record<string, number>[] = [];
    for (const text of texts) results.push(...(await super.classifyMany([text], name, labels)));
    return results;
  }

  /** extract_entities(text, types) with include_confidence and include_spans. */
  override async extractEntities(text: string, types: Labels, threshold = 0.5): Promise<Record<string, Entity[]>> {
    const started = this.recorder ? performance.now() : 0;
    const encoded = this.encode(text, { name: "entities", marker: "[E]", labels: types });
    // span_probs is 0 where a label abstains or a pool slot is empty.
    const read = await this.run([encoded], ["span_probs", "span_bounds"]);
    const probs = read.span_probs.data;
    const bounds = read.span_bounds.data;
    const pool = read.span_probs.dims[2]!;
    const words = encoded.starts.length;
    const result: Record<string, Entity[]> = Object.fromEntries(
      Object.keys(types).map((name, li) => {
        const scored: Scored[] = [];
        for (let c = 0; c < pool; c++) {
          const confidence = probs[li * pool + c]!;
          const start = bounds[c * 2]!;
          const end = bounds[c * 2 + 1]!;
          if (confidence >= threshold && start < end && end <= words) scored.push({ confidence, start, end, index: scored.length });
        }
        const entities: Entity[] = [];
        for (const span of flat(scored)) {
          const charStart = encoded.starts[span.start]!;
          const charEnd = encoded.ends[span.end - 1]!;
          const surface = encoded.text.slice(charStart, charEnd).trim();
          if (surface) entities.push({ text: surface, confidence: span.confidence, start: charStart, end: charEnd });
        }
        return [name, entities];
      }),
    );
    this.recorder?.push({ kind: "extractEntities", text, name: "entities", labels: types, output: result, ms: Math.round(performance.now() - started) });
    return result;
  }
}

/** gliner2's rank_key: confidence first, then start, end and input order. */
const rank = (a: Scored, b: Scored) => b.confidence - a.confidence || a.start - b.start || a.end - b.end || a.index - b.index;

/**
 * gliner2's resolve_overlaps(policy="flat"): drop repeated boundaries, then
 * take the non-overlapping set with the highest total confidence (weighted
 * interval scheduling), with the same tie rules. Ranked by confidence.
 */
export function flat(items: Scored[]): Scored[] {
  const seen = new Set<string>();
  const distinct = [...items].sort(rank).filter(({ start, end }) => !seen.has(`${start}:${end}`) && !!seen.add(`${start}:${end}`));
  const byEnd = distinct.sort((a, b) => a.end - b.end || a.start - b.start || b.confidence - a.confidence || a.index - b.index);
  const ranked = (picks: number[]) => picks.map((i) => byEnd[i]!).sort(rank);
  const before = (a: number[], b: number[]) => {
    const [x, y] = [ranked(a), ranked(b)];
    for (let i = 0; i < x.length; i++) if (rank(x[i]!, y[i]!)) return rank(x[i]!, y[i]!) < 0;
    return false;
  };
  const best: { score: number; picks: number[] }[] = [{ score: 0, picks: [] }];
  byEnd.forEach((item, i) => {
    let previous = i - 1;
    while (previous >= 0 && byEnd[previous]!.end > item.start) previous--;
    const withItem = { score: best[previous + 1]!.score + item.confidence, picks: [...best[previous + 1]!.picks, i] };
    const without = best[i]!;
    if (withItem.score !== without.score) best.push(withItem.score > without.score ? withItem : without);
    else if (withItem.picks.length !== without.picks.length) best.push(withItem.picks.length > without.picks.length ? withItem : without);
    else best.push(before(withItem.picks, without.picks) ? withItem : without);
  });
  return ranked(best.at(-1)!.picks);
}
