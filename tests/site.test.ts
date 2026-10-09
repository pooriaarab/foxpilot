import { describe, expect, it } from "vitest";
import { choose, nearlyNames, type Part } from "../src/agent/controller";
import { searchQuery } from "../src/agent/search";
import { onSite, siteIn, withoutSite } from "@foxpilot/core/page/site";
import type { HistoryEntry, Page } from "@foxpilot/core/page/types";

/** A test scorer's batched call: the same answers as one call per text. */
const batched = <T extends { classify: (t: string, n: string, l: Record<string, unknown>) => Promise<Record<string, number>> }>(m: T) =>
  ({ ...m, classifyMany: (texts: string[], n: string, labels: Record<string, unknown>) => Promise.all(texts.map((t) => m.classify(t, n, labels))) });


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
  const model = batched({
    extractEntities: async () => ({}),
    // Scores the unrelated suggestion highest, like "crunchbase" in the real run.
    classify: async (_t: string, _n: string, labels: Record<string, unknown>) =>
      Object.fromEntries(Object.keys(labels).map((l) => [l, /crunchbase/.test(l) ? 0.39 : 0.01])),
  });

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
    const model = batched({ extractEntities: async () => ({}), classify: async (_t: string, _n: string, labels: Record<string, unknown>) => Object.fromEntries(Object.keys(labels).map((l) => [l, 0.92])) });
    const decision = await choose(model, page, history, new Map(), new Set(), parts, new Set(["kitchenaid mixer"]));
    expect(decision.target).not.toBe("Ask Alexa about this");
  });
});

describe("dropdowns", () => {
  it("do not take a value their option does not name", async () => {
    const page: Page = {
      url: "https://example.test/s?k=mixer", title: "Results", text: "", marker: 0, page_key: [], guards: {},
      actions: [
        { id: "q", kind: "fill", label: "Search Amazon", role: "searchbox", node: 1, document_id: 1, value: "kitchenaid artisan mixer" },
        { id: "o1", kind: "select", label: "Sort by: → Price: High to Low", role: "combobox", node: 2, document_id: 1, value: "price-desc-rank" },
        { id: "o2", kind: "select", label: "Sort by: → Price: Low to High", role: "combobox", node: 2, document_id: 1, value: "price-asc-rank" },
      ],
    };
    const parts: Part[] = [{ text: "kitchenaid hand mixer", values: ["kitchenaid hand mixer"], date: null }];
    const scores: Record<string, number> = { "Sort by: → Price: High to Low": 0.29, "Sort by: → Price: Low to High": 0.27, "Search Amazon": 0.1 };
    const model = batched({ extractEntities: async () => ({}), classify: async (_t: string, _n: string, labels: Record<string, unknown>) => Object.fromEntries(Object.keys(labels).map((l) => [l, scores[l] ?? 0.01])) });
    const decision = await choose(model, page, [], new Map(), new Set(), parts, new Set());
    expect(decision.target).toBe("Search Amazon");
  });
});

describe("typos in the goal", () => {
  it("matches names one or two letters off", () => {
    expect(nearlyNames("Marymoor Park    West Lake Sammamish Pkwy NE, Redmond, WA", "marmoor park")).toBe(true);
    expect(nearlyNames("Blazing Bagels Redmond", "blazing bagles redmond")).toBe(true);
    expect(nearlyNames("Marymoor Park Playground", "marmoor park")).toBe(true);
    expect(nearlyNames("Seattle", "marmoor park")).toBe(false);
    expect(nearlyNames("Route 520", "route 250")).toBe(false);
    expect(nearlyNames("Bay", "bat")).toBe(false);
    expect(nearlyNames("Destination Blazing Bagels, 6975 176th Ave NE #365, Redmond, WA 98052", "blazing bagels redmond")).toBe(true);
    expect(nearlyNames("Blazing Bagels 21 min", "blazing bagels redmond")).toBe(false);
    expect(nearlyNames("Blazing Hot Wings and Grill, open late, 12 locations across the Seattle metro area near Redmond", "blazing redmond")).toBe(false);
  });

  it("takes the suggestion whose name is closest to what was typed", async () => {
    const page: Page = {
      url: "https://maps.example.test/", title: "Maps", text: "", marker: 0, page_key: [], guards: {},
      actions: [
        { id: "f", kind: "fill", label: "Starting point", role: "combobox", node: 1, document_id: 1, value: "Marmoor Park" },
        { id: "a", kind: "click", label: "Marymoor Park Playground    Northeast Marymoor Way, Redmond, WA", role: "option", node: 2, document_id: 1, suggestion_for: 1, dialog: true },
        { id: "b", kind: "click", label: "Marymoor Park    West Lake Sammamish Pkwy NE, Redmond, WA", role: "option", node: 3, document_id: 1, suggestion_for: 1, dialog: true },
      ],
    };
    const history: HistoryEntry[] = [{ action: "Starting point", node: 1, document_id: 1, kind: "fill", text: "Marmoor Park", requirement: "from Marmoor Park" }];
    const parts: Part[] = [
      { text: "from Marmoor Park", values: ["marmoor park"], date: null },
      { text: "to Blazing Bagles Redmond", values: ["blazing bagles redmond"], date: null },
    ];
    // The model prefers the playground, as in the real run (0.47).
    const model = batched({ extractEntities: async () => ({}), classify: async (_t: string, _n: string, labels: Record<string, unknown>) =>
      Object.fromEntries(Object.keys(labels).map((l) => [l, /Playground/.test(l) ? 0.47 : 0.3])) });
    const decision = await choose(model, page, history, new Map(), new Set(), parts, new Set());
    expect(decision.target).toMatch(/^Marymoor Park {4}West Lake/);
    expect(decision.covered).toEqual(["from Marmoor Park"]);
  });
});

describe("a field renamed by typing into it", () => {
  it("is still sent (Google Maps' destination box)", async () => {
    const page: Page = {
      url: "https://maps.example.test/dir", title: "Maps", text: "", marker: 0, page_key: [], guards: {},
      actions: [
        { id: "a", kind: "fill", label: "Starting point Marymoor Park, 6046 West Lake Sammamish Pkwy NE", role: "combobox", node: 4, document_id: 1, value: "Marymoor Park, 6046 West Lake Sammamish Pkwy NE" },
        { id: "b", kind: "fill", label: "Destination Blazing Bagels Redmond", role: "combobox", node: 5, document_id: 1, value: "Blazing Bagels Redmond" },
        { id: "press_enter", kind: "key", label: "Press Enter to submit the focused field" },
        { id: "wait", kind: "wait", label: "Wait for the page to update" },
      ],
    };
    const history: HistoryEntry[] = [
      { action: "Choose starting point, or click on the map...", node: 4, document_id: 1, kind: "fill", text: "Marymoor Park", requirement: "from Marymoor Park" },
      { action: "Marymoor Park    West Lake Sammamish Pkwy NE, Redmond, WA", node: 9, document_id: 1, kind: "click", committed_field: "Choose starting point, or click on the map..." },
      { action: "Choose destination, or click on the map...", node: 5, document_id: 1, kind: "fill", text: "Blazing Bagels Redmond", requirement: "to Blazing Bagels Redmond" },
    ];
    const parts: Part[] = [{ text: "to Blazing Bagels Redmond", values: ["blazing bagels redmond"], date: null }];
    const model = batched({ extractEntities: async () => ({}), classify: async (_t: string, _n: string, labels: Record<string, unknown>) => Object.fromEntries(Object.keys(labels).map((l) => [l, 0.01])) });
    const decision = await choose(model, page, history, new Map(), new Set(), parts, new Set(parts.map((p) => p.text)));
    expect(decision.operation).toBe("PRESS_ENTER");
  });
});
