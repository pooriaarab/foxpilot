export type Labels = Record<string, string | undefined>;

/** What the controller needs from GLiNER2. */
export interface Scorer {
  extractEntities(text: string, types: Labels, threshold?: number): Promise<Record<string, { text: string; start?: number }[]>>;
  classify(text: string, name: string, labels: Labels): Promise<Record<string, number>>;
  /** classify() for each text against the same prompt and labels, in one model call. */
  classifyMany(texts: string[], name: string, labels: Labels): Promise<Record<string, number>[]>;
}
