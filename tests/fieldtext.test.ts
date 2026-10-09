import { describe, expect, it } from "vitest";
import { isSearchField, parseValue, searchQuery, SpanWriter } from "../src/agent/fieldtext";

describe("searchQuery", () => {
  it("keeps a plain query and drops search verbs and the final period", () => {
    expect(searchQuery("Weather in Seattle")).toBe("Weather in Seattle");
    expect(searchQuery("Search Wikipedia for the Golden Gate Bridge.")).toBe("the Golden Gate Bridge");
    expect(searchQuery("search for noise cancelling headphones")).toBe("noise cancelling headphones");
    expect(searchQuery("Look up the Ada Lovelace biography.")).toBe("the Ada Lovelace biography");
  });
});

describe("isSearchField", () => {
  it("recognises search boxes by role or label", () => {
    expect(isSearchField({ label: "Search", role: "combobox" })).toBe(true);
    expect(isSearchField({ label: "Anything", role: "searchbox" })).toBe(true);
    expect(isSearchField({ label: "Where from?", role: "combobox" })).toBe(false);
  });
});

describe("SpanWriter", () => {
  const found = new Map([["seattle", "Seattle"], ["new york", "New York"], ["2026-10-09", "2026-10-09"]]);
  const base = { page: { title: "", text: "" }, recent_actions: [], date: null, candidates: [], textFields: 3 };

  it("types the object an ask says to search for", async () => {
    const parts = [{ text: "Use the site search to find Form RV-7 mailing address", values: [], date: null }];
    const writer = new SpanWriter(parts, found);
    const goal = "Use the site search to find Form RV-7 mailing address, then open it.";
    expect(await writer.write({ ...base, goal, requirement: parts[0]!.text, field: { label: "Search", role: "combobox" } })).toBe("Form RV-7 mailing address");
  });

  it("does not type the whole goal into a search box the ask never mentions", async () => {
    const parts = [
      { text: "cheapest one-way ticket", values: [], date: null },
      { text: "from New York", values: ["new york"], date: null },
      { text: "to San Francisco", values: ["san francisco"], date: null },
    ];
    const writer = new SpanWriter(parts, found);
    const goal = "cheapest one-way ticket from New York to San Francisco.";
    // The part's own value, never the whole goal as a query.
    expect(await writer.write({ ...base, textFields: 1, goal, requirement: "from New York", field: { label: "Search", role: "combobox" } })).toBe("New York");
  });

  it("types the requirement's own value for multi-part goals", async () => {
    const parts = [
      { text: "Find a one-way ticket", values: [], date: null },
      { text: "from New York", values: ["new york"], date: null },
      { text: "to San Francisco", values: ["san francisco"], date: null },
    ];
    const writer = new SpanWriter(parts, found);
    expect(await writer.write({ ...base, goal: "…", requirement: "from New York", field: { label: "Where from?", role: "combobox" } })).toBe("New York");
  });

  it("refuses a field no requirement names a value for", async () => {
    const writer = new SpanWriter([{ text: "Open the menu", values: [], date: null }, { text: "a", values: [], date: null }, { text: "b", values: [], date: null }], found);
    await expect(writer.write({ ...base, goal: "Open the menu", requirement: "Open the menu", field: { label: "Name" } })).rejects.toThrow();
  });
});

describe("parseValue", () => {
  it("reads the text, a null, or rejects malformed replies", () => {
    expect(parseValue('{"text": "New York"}')).toBe("New York");
    expect(parseValue('Sure! {"text": null}')).toBeNull();
    expect(parseValue('{"value": "x"}')).toBeUndefined();
    expect(parseValue("no json")).toBeUndefined();
  });
});
