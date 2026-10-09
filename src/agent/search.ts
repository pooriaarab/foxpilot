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
    // Price preferences pick among the results; typed into the box they only
    // add noise ("cheapest kitchenaid mixer"). Other words like "latest" stay.
    .replace(/\b(?:the\s+)?(?:cheapest|cheaper|cheap|budget|inexpensive|affordable|lowest[- ]priced?|least expensive|most expensive|priciest)\b\s*/gi, "")
    .replace(/[.!]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const SEARCH_ASK =
  /\b(?:use\s+(?:the\s+)?(?:[\w'-]+\s+){0,2}?search(?:\s+(?:box|bar|field|form))?\s+(?:to\s+(?:find|look\s+up|locate)\s+|for\s+)|search\s+(?:(?:the|this)\s+(?:site|website|page)\s+)?for\s+|look\s+up\s+|google\s+)/i;

/**
 * The query the ask itself names, or null when the ask never says to search.
 * "Use the site search to find Form RV-7 mailing address, then open it" gives
 * "Form RV-7 mailing address". A quoted phrase wins over the words around it.
 */
export function searchAsk(goal: string): string | null {
  const found = SEARCH_ASK.exec(goal);
  if (!found) return null;
  const rest = goal.slice(found.index + found[0].length);
  const quoted = /["“]([^"”]{2,})["”]/.exec(rest);
  const object = quoted ? quoted[1]! : rest.split(/[.;!?](?:\s|$)|,\s*(?:and\s+)?then\b|\s+and\s+then\b|\s+then\s/i)[0]!;
  return searchQuery(object) || null;
}

const DESTINATION =
  /\b(?:navigate|go\s+to|head\s+to|browse\s+to|visit|descend|walk)\b|\bopen\b(?!\s+(?:this|the)\s+page\b)|\bper\s+(?:section|article|chapter|part|clause)\s+\w+|\b(?:find|reach|locate)\b.*\bpage\b/i;

/**
 * The part of the ask that names a page to reach ("Navigate to the Surface
 * Permits desk's own page", "Per section 22, what is ..."), or null when the
 * ask names none. "Open this page" is where the run starts, and "report ..."
 * says what to read there; neither is a place to go.
 */
export function destinationAsk(goal: string): string | null {
  const sentences = goal.split(/(?<=[.?!;])\s+|\s+[\u2014\u2013]\s+/)
    .map((s) => s.replace(/(?:,\s*)?\b(?:and\s+)?report\b.*$/i, "").replace(/[.?!;\s]+$/, "").trim())
    .filter((s) => s && !/^open\s+(?:this|the)\s+page$/i.test(s) && !/^report\b/i.test(s));
  // A sentence that points back ("that desk's own page") needs the one before it.
  const named = sentences.flatMap((s, i) =>
    DESTINATION.test(s) ? [...(/\b(?:that|its|it|same|there)\b/i.test(s) && i > 0 ? [sentences[i - 1]!] : []), s] : []);
  return named.length ? [...new Set(named)].join(". ") : null;
}
