import { describe, expect, it } from "vitest";
import { choose, type Part } from "../src/agent/controller";
import { searchQuery } from "../src/agent/search";
import { onSite, siteIn, withoutSite } from "../src/agent/site";
import type { HistoryEntry, Page } from "../src/agent/types";

describe("sites named in a goal", () => {
  it("finds the domain and the words that attach it", () => {
    const site = siteIn("find me kitchenaid mixer on amazon.com")!;
    expect(site).toMatchObject({ host: "amazon.com", url: "https://amazon.com" });
    expect(withoutSite("find me kitchenaid mixer on amazon.com", site)).toBe("find me kitchenaid mixer");
    expect(siteIn("Search www.wikipedia.org for the Golden Gate Bridge")!.host).toBe("wikipedia.org");
    expect(siteIn("go to https://news.ycombinator.com/newest")!.url).toBe("https://news.ycombinator.com/newest");
  });

  it("does not guess a site from a bare name", () => {
    expect(siteIn("find me a mixer on amazon")).toBeNull();
    expect(siteIn("Find a one-way ticket from New York to San Francisco on October 9, 2026.")).toBeNull();
  });

  it("knows when the page is already there", () => {
    const site = siteIn("mixer on amazon.com")!;
    expect(onSite("https://www.amazon.com/s?k=mixer", site)).toBe(true);
    expect(onSite("https://smile.amazon.com/", site)).toBe(true);
    expect(onSite("https://www.google.com/search?q=amazon.com", site)).toBe(false);
  });
});

describe("search queries", () => {
  it.each([
    ["find me kitchenaid mixer on amazon.com", "kitchenaid mixer"],
    ["Find me a stand mixer", "stand mixer"],
    ["show me the weather in Seattle", "weather in Seattle"],
    ["Search Wikipedia for the Golden Gate Bridge.", "the Golden Gate Bridge"],
    ["weather seattle", "weather seattle"],
    ["find me cheapest kitchenaid mixer", "kitchenaid mixer"],
    ["the cheapest flights to Paris", "flights to Paris"],
    ["latest news on the election", "latest news on the election"],
  ])("%s → %s", (goal, query) => {
    expect(searchQuery(goal)).toBe(query);
  });
});

describe("autocomplete in a search box", () => {
  // A search page after typing: one suggestion unrelated to the query, one that contains it.
  const page = (labels: string[]): Page => ({
    url: "https://example.test/", title: "Search", text: "", marker: 0, page_key: [], guards: {},
    actions: [
      { id: "e1", kind: "fill", label: "Search", role: "combobox", node: 1, document_id: 1, value: "kitchenaid mixer" },
      ...labels.map((label, i) => ({ id: `s${i}`, kind: "click" as const, label, role: "option", node: 10 + i, document_id: 1, suggestion_for: 1, dialog: true })),
      { id: "k", kind: "key", label: "Press Enter to submit the focused field" },
    ],
  });
  const history: HistoryEntry[] = [{ action: "Search", node: 1, document_id: 1, kind: "fill", text: "kitchenaid mixer" }];
  const parts: Part[] = [{ text: "kitchenaid mixer", values: ["kitchenaid mixer"], date: null }];
  const model = {
    extractEntities: async () => ({}),
    // Scores the unrelated suggestion highest, like "crunchbase" in the real run.
    classify: async (_t: string, _n: string, labels: Record<string, unknown>) =>
      Object.fromEntries(Object.keys(labels).map((l) => [l, /crunchbase/.test(l) ? 0.39 : 0.01])),
  };

  it("does not take a suggestion that drops the query", async () => {
    const decision = await choose(model, page(["crunchbase"]), history, new Map(), new Set(), parts, new Set(parts.map((p) => p.text)));
    expect(decision.target).not.toBe("crunchbase");
  });

  it("takes one that contains it", async () => {
    const decision = await choose(model, page(["crunchbase", "kitchenaid mixer attachments"]), history, new Map(), new Set(), parts, new Set(parts.map((p) => p.text)));
    expect(decision.target).toBe("kitchenaid mixer attachments");
  });
});

describe("popups while typing", () => {
  it("does not 'confirm' an autocomplete popup's buttons", async () => {
    const page: Page = {
      url: "https://example.test/", title: "Search", text: "", marker: 0, page_key: [], guards: {},
      actions: [
        { id: "e1", kind: "fill", label: "Search Amazon", role: "searchbox", node: 1, document_id: 1, value: "kitchenaid mixer" },
        { id: "a", kind: "click", label: "Ask Alexa about this", role: "button", node: 5, document_id: 1, dialog: true },
        { id: "k", kind: "key", label: "Press Enter to submit the focused field" },
      ],
    };
    const history: HistoryEntry[] = [{ action: "Search Amazon", node: 1, document_id: 1, kind: "fill", text: "kitchenaid mixer" }];
    const parts: Part[] = [{ text: "kitchenaid mixer", values: ["kitchenaid mixer"], date: null }];
    const model = { extractEntities: async () => ({}), classify: async (_t: string, _n: string, labels: Record<string, unknown>) => Object.fromEntries(Object.keys(labels).map((l) => [l, 0.92])) };
    const decision = await choose(model, page, history, new Map(), new Set(), parts, new Set(["kitchenaid mixer"]));
    expect(decision.target).not.toBe("Ask Alexa about this");
  });
});
