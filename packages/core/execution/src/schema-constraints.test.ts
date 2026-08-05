import { describe, expect, it } from "@effect/vitest";

import { summarizeInputConstraints } from "./schema-constraints";

describe("summarizeInputConstraints", () => {
  it("surfaces numeric, collection, and per-item string limits", () => {
    expect(
      summarizeInputConstraints({
        type: "object",
        properties: {
          max_events: { type: "integer", minimum: 1, maximum: 100 },
          events: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 4000 },
          },
        },
      }),
    ).toEqual([
      { path: "max_events", rules: ["value >= 1", "value <= 100"] },
      { path: "events", rules: ["items >= 1", "items <= 100", "items unique"] },
      { path: "events[]", rules: ["length >= 1", "length <= 4000"] },
    ]);
  });

  it("follows local and separately stored definitions without recursing forever", () => {
    expect(
      summarizeInputConstraints(
        {
          type: "object",
          properties: {
            local: { $ref: "#/$defs/Local" },
            shared: { $ref: "#/$defs/Shared" },
          },
          $defs: {
            Local: { type: "string", pattern: "^[a-z]+$" },
          },
        },
        {
          Shared: {
            type: "object",
            maxProperties: 3,
            properties: { child: { $ref: "#/$defs/Shared" } },
          },
        },
      ),
    ).toEqual([
      { path: "local", rules: ['matches "^[a-z]+$"'] },
      { path: "shared", rules: ["properties <= 3"] },
      { path: "shared.child", rules: ["properties <= 3"] },
    ]);
  });

  it("handles numeric and OpenAPI 3 boolean exclusive bounds", () => {
    expect(
      summarizeInputConstraints({
        type: "object",
        properties: {
          openapi3: { type: "number", minimum: 0, exclusiveMinimum: true },
          jsonSchema: { type: "number", exclusiveMaximum: 10 },
          ordinary: { type: "number", minimum: 0, maximum: 10 },
        },
      }),
    ).toEqual([
      { path: "openapi3", rules: ["value > 0"] },
      { path: "jsonSchema", rules: ["value < 10"] },
      { path: "ordinary", rules: ["value >= 0", "value <= 10"] },
    ]);
  });

  it("collects allOf rules but does not conjoin anyOf or oneOf branches", () => {
    expect(
      summarizeInputConstraints({
        type: "object",
        properties: {
          conjunctive: { allOf: [{ minimum: 1 }, { maximum: 10 }] },
          alternative: {
            oneOf: [
              { minimum: 1, maximum: 10 },
              { minimum: 100, maximum: 200 },
            ],
          },
          nullable: { anyOf: [{ type: "string", maxLength: 50 }, { type: "null" }] },
        },
      }),
    ).toEqual([{ path: "conjunctive", rules: ["value >= 1", "value <= 10"] }]);
  });

  it("supports modern and draft-4 tuple item schemas", () => {
    expect(
      summarizeInputConstraints({
        type: "object",
        properties: {
          modern: { type: "array", prefixItems: [{ maxLength: 10 }, { maximum: 5 }] },
          legacy: { type: "array", items: [{ minLength: 2 }, { minimum: 1 }] },
        },
      }),
    ).toEqual([
      { path: "modern[0]", rules: ["length <= 10"] },
      { path: "modern[1]", rules: ["value <= 5"] },
      { path: "legacy[0]", rules: ["length >= 2"] },
      { path: "legacy[1]", rules: ["value >= 1"] },
    ]);
  });

  it("labels root constraints and avoids no-op minimums", () => {
    expect(
      summarizeInputConstraints({
        type: "array",
        minItems: 0,
        maxItems: 20,
        items: { type: "string", minLength: 0, format: "email" },
      }),
    ).toEqual([
      { path: "(root)", rules: ["items <= 20"] },
      { path: "(root)[]", rules: ["format email"] },
    ]);
  });

  it("does not guess a flat definition for a deeper unresolved pointer", () => {
    expect(
      summarizeInputConstraints(
        {
          type: "object",
          properties: { name: { $ref: "#/$defs/Pet/properties/name" } },
        },
        { name: { type: "string", maxLength: 10 } },
      ),
    ).toEqual([]);
  });
});
