// Search boxes: which fields are one, and what query a goal becomes.

export function isSearchField(field: { label: string; role?: string }): boolean {
  return field.role === "searchbox" || /\bsearch\b/i.test(field.label);
}

/** The goal as a search query: without a leading "search (site) for" and the final period. */
export function searchQuery(goal: string): string {
  return goal
    .trim()
    .replace(/^(?:please\s+)?(?:search|look\s+up|google|find)(?:\s+\w+)?\s+for\s+/i, "")
    .replace(/^(?:please\s+)?(?:search|look\s+up|google)\s+/i, "")
    .replace(/[.!]+$/, "")
    .trim();
}
