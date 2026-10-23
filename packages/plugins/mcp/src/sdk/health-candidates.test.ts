import { describe, expect, it } from "@effect/vitest";

import { compatibleHealthCandidates } from "./health-candidates";
import type { McpToolManifestEntry } from "./manifest";

const operation = (
  name: string,
  inputSchema: unknown = { type: "object", properties: {} },
): McpToolManifestEntry => ({
  toolId: name,
  toolName: name,
  description: null,
  inputSchema,
  annotations: { readOnlyHint: true },
});

const names = (catalogs: readonly (readonly McpToolManifestEntry[])[]) =>
  compatibleHealthCandidates(catalogs).map((candidate) => candidate.operation);

describe("integration-wide MCP health candidates", () => {
  it("offers only tools that every connection lists read-only with identical schemas", () => {
    const common = operation("health");
    expect(
      names([
        [common, operation("only_a")],
        [common, operation("only_b")],
      ]),
    ).toEqual(["health"]);
    for (const peer of [
      { ...common, annotations: { readOnlyHint: false } },
      { ...common, inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
      { ...common, outputSchema: { type: "string" } },
    ]) {
      expect(names([[common], [peer]])).toEqual([]);
    }
  });

  it("offers nothing when any catalog is empty, unreadable, or ambiguous", () => {
    const common = operation("health");
    expect(names([[common], []])).toEqual([]);
    expect(names([])).toEqual([]);
    expect(names([[common], [common, common]])).toEqual([]);
    expect(names([[common, common]])).toEqual([]);
  });

  it("treats only read-only, non-destructive annotations as probe-safe", () => {
    const tool = operation("health");
    for (const annotations of [
      { readOnlyHint: true, destructiveHint: true },
      { destructiveHint: false },
      undefined,
    ]) {
      expect(names([[{ ...tool, annotations }]])).toEqual([]);
    }
  });

  it("refuses a schema that requires an undeclared or malformed argument list", () => {
    expect(names([[operation("health", { type: "object", required: ["missing"] })]])).toEqual([]);
    expect(names([[operation("health", { type: "object", required: "limit" })]])).toEqual([]);
  });

  it("ignores key order and offers JSON-object arguments that must be picked explicitly", () => {
    const first = operation("health", {
      type: "object",
      properties: {
        limit: { type: "number", description: "Page size" },
        body: { type: "string" },
        options: { type: "object" },
      },
      required: ["limit", "body"],
    });
    const peer = {
      ...first,
      inputSchema: {
        required: ["limit", "body"],
        properties: {
          options: { type: "object" },
          body: { type: "string" },
          limit: { description: "Page size", type: "number" },
        },
        type: "object",
      },
    };
    const [candidate, ...rest] = compatibleHealthCandidates([[first], [peer]]);
    expect(rest).toEqual([]);
    expect(candidate).toMatchObject({
      operation: "health",
      method: "mcp",
      destructive: false,
      explicitSelectionOnly: true,
      jsonArguments: true,
      requiredArgCount: 2,
    });
    expect(candidate?.parameters).toEqual([
      { name: "limit", location: "argument", required: true },
      { name: "body", location: "argument", required: true },
      { name: "options", location: "argument", required: false },
    ]);
  });

  it("projects identity fields from the output schema, following its $defs", () => {
    const outputSchema = {
      type: "object",
      properties: { user: { $ref: "#/$defs/User" } },
      $defs: { User: { type: "object", properties: { email: { type: "string" } } } },
    };
    const [candidate] = compatibleHealthCandidates([[{ ...operation("whoami"), outputSchema }]]);
    expect(candidate?.responseFields).toEqual([{ path: "user.email", type: "string" }]);
  });
});
