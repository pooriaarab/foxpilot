import { describe, expect, it } from "vitest";
import { normalise, relativeDate, resolveDate } from "../src/agent/dates";
import { qualifiers } from "../src/agent/pick";

// Friday, September 25, 2026 (local time, as the extension sees it).
const TODAY = new Date(2026, 8, 25);

describe("relative dates", () => {
  it.each([
    ["on the 1st Friday of next month", "2026-10-02"],
    ["the first friday of next month", "2026-10-02"],
    ["on the 2nd Tuesday of next month", "2026-10-13"],
    ["the last Monday of October", "2026-10-26"],
    ["the third Sunday of this month", "2026-09-20"],
    ["the first Monday of January", "2027-01-04"],
    ["the first Monday of January 2026", "2026-01-05"],
    ["tomorrow", "2026-09-26"],
    ["the day after tomorrow", "2026-09-27"],
    ["today", "2026-09-25"],
    ["next Friday", "2026-10-02"],
    ["this Friday", "2026-09-25"],
    ["on Monday", "2026-09-28"],
    ["in 2 weeks", "2026-10-09"],
    ["in three days", "2026-09-28"],
  ])("%s → %s", (text, iso) => {
    expect(relativeDate(text, TODAY)).toBe(iso);
  });

  it("has no date for words that only look like one", () => {
    expect(relativeDate("next month", TODAY)).toBeNull();
    expect(relativeDate("the fifth Friday of next month", TODAY)).toBe("2026-10-30");
    expect(relativeDate("the fifth Monday of next month", TODAY)).toBeNull();
    expect(relativeDate("Find a one-way ticket", TODAY)).toBeNull();
    expect(relativeDate("fly to Sun Valley", TODAY)).toBeNull();
  });

  it("prefers a calendar date when there is one", () => {
    expect(resolveDate("on October 9, 2026", TODAY)).toBe("2026-10-09");
  });

  it("does not read 'last Friday of the month' as 'latest'", () => {
    expect(qualifiers("a flight on the last Friday of next month")).toBeNull();
    expect(qualifiers("the last flight of the day")?.order).toBe("depart-desc");
  });

  it("types the date when a writer echoes the goal's words", () => {
    const wanted = relativeDate("1st Friday of next month")!;
    expect(normalise("1st Friday of next month", wanted)).toBe(wanted);
    expect(normalise("Seattle", wanted)).toBe("Seattle");
  });
});
