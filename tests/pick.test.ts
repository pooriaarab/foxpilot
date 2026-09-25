import { describe, expect, it } from "vitest";
import { choose, describe as label, parseClock, parseDuration, parseMoney, qualifiers, type Row } from "../src/agent/pick";

describe("qualifiers", () => {
  it("reads order, time window and nonstop from the goal", () => {
    expect(qualifiers("cheapest one-way ticket from New York to San Francisco on October 9, 2026 morning"))
      .toEqual({ order: "price-asc", window: [300, 720], windowName: "morning" });
    expect(qualifiers("fastest nonstop flight to Denver")).toEqual({ order: "duration-asc", nonstop: true });
    expect(qualifiers("Get directions from Berlin Hauptbahnhof to Brandenburg Gate.")).toBeNull();
  });
});

describe("parsers", () => {
  it("reads prices, clock times and durations", () => {
    expect(parseMoney("$1,388")).toBe(1388);
    expect(parseClock("6:00 AM")).toBe(360);
    expect(parseClock("12:44 AM+1")).toBe(44);
    expect(parseClock("6:15 PM – 11:58 PM")).toBe(18 * 60 + 15);
    expect(parseDuration("6 hr 14 min")).toBe(374);
    expect(parseDuration("45 min")).toBe(45);
  });
});

describe("choose", () => {
  const rows: Row[] = [
    { i: 0, text: "6:15 PM Delta $254", price: 254, depart: 1095, duration: 523, nonstop: false },
    { i: 1, text: "6:00 AM United $388", price: 388, depart: 360, duration: 374, nonstop: true },
    { i: 2, text: "6:59 AM American $400", price: 400, depart: 419, duration: 393, nonstop: true },
    { i: 3, text: "9:25 PM American $309", price: 309, depart: 1285, duration: 402, nonstop: true },
  ];
  it("filters by the time window before ranking", () => {
    expect(choose(rows, { order: "price-asc", window: [300, 720], windowName: "morning" })?.i).toBe(1);
    expect(choose(rows, { order: "price-asc" })?.i).toBe(0);
    expect(choose(rows, { order: "price-asc", window: [1260, 300], windowName: "night" })?.i).toBe(3);
  });
  it("describes the pick", () => {
    expect(label({ order: "price-asc", windowName: "morning", window: [300, 720] }, rows[1]!)).toBe("Cheapest morning option · $388");
  });
});
