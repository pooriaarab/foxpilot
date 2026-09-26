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
    // "find me a kitchenaid mixer" is a request, not the query.
    .replace(/^(?:please\s+)?(?:find|get|show|buy)\s+me\s+(?:(?:a|an|the|some)\s+)?/i, "")
    // "… on amazon.com": the site is where to search, not what to search for.
    .replace(/\s+(?:on|at|from|in|via)\s+(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}\b\S*$/i, "")
    .replace(/[.!]+$/, "")
    .trim();
}
