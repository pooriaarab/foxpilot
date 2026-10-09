import { describe, expect, it } from "vitest";
import { isDateField, isUnsafe } from "@foxpilot/agent/controller";

const field = (label: string) => ({ id: "e1", kind: "fill" as const, label });

describe("isDateField", () => {
  it("recognises date fields by label", () => {
    for (const label of ["Departure", "Return", "Check-in", "Check out", "Departure date", "When?", "Date (MM/DD)"]) {
      expect(isDateField(field(label)), label).toBe(true);
    }
  });
  it("leaves place and text fields alone", () => {
    for (const label of ["Where from?", "Where to? ", "Search", "Choose destination", "Name"]) {
      expect(isDateField(field(label)), label).toBe(false);
    }
  });
});

describe("isUnsafe", () => {
  it("never offers account-changing or spending controls", () => {
    for (const label of ["Track prices from New York to Denver departing 2026-10-09", "Sign in", "Log out", "Subscribe", "Buy now", "Delete trip", "Proceed to checkout", "Book with Delta", "Book now"]) {
      expect(isUnsafe(field(label)), label).toBe(true);
    }
  });
  it("keeps ordinary controls", () => {
    for (const label of ["Search", "One way", "Done. Search for one-way flights", "Where from?", "Book a table"]) {
      expect(isUnsafe(field(label)), label).toBe(false);
    }
  });
});
