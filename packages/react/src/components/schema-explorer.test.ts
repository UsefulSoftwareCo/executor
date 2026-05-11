import { describe, expect, it } from "@effect/vitest";

import { safeSchemaValueLabel } from "./schema-explorer";

describe("safeSchemaValueLabel", () => {
  it("formats values that JSON.stringify cannot serialize", () => {
    expect(safeSchemaValueLabel(10n)).toBe("10n");
  });

  it("uses neutral text for circular values", () => {
    const value: { self?: unknown } = {};
    value.self = value;

    expect(safeSchemaValueLabel(value)).toBe("[unavailable]");
  });
});
