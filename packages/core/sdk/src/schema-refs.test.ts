import { describe, expect, it } from "@effect/vitest";

import { collectReferencedDefinitions } from "./schema-refs";

describe("schema-refs", () => {
  it("collects only transitive definitions reachable from schema roots", () => {
    const defs = new Map<string, unknown>([
      [
        "Pet",
        {
          anyOf: [{ $ref: "#/$defs/Dog" }, { $ref: "#/$defs/Cat" }],
        },
      ],
      [
        "Dog",
        {
          type: "object",
          properties: {
            collar: { $ref: "#/$defs/Collar" },
          },
        },
      ],
      [
        "Cat",
        {
          type: "object",
          properties: {
            lives: { type: "number" },
          },
        },
      ],
      [
        "Collar",
        {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
      ],
      [
        "Unused",
        {
          type: "object",
          properties: {
            value: { type: "string" },
          },
        },
      ],
    ]);

    expect(collectReferencedDefinitions([{ $ref: "#/$defs/Pet" }], defs)).toEqual({
      Cat: defs.get("Cat"),
      Collar: defs.get("Collar"),
      Dog: defs.get("Dog"),
      Pet: defs.get("Pet"),
    });
  });
});
