import { describe, expect, it } from "vitest";
import { isDateField } from "../src/agent/controller";

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
