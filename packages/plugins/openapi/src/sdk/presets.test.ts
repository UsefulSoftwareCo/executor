import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { extract } from "./extract";
import { parse } from "./parse";
import { openApiPlugin } from "./plugin";
import {
  FIGMA_SPEC_OVERRIDES,
  FIGMA_SUPPORTED_OAUTH_SCOPES,
  VERCEL_SPEC_OVERRIDES,
  openApiPresets,
} from "./presets";
import { applySpecOverrides } from "./spec-overrides";

const unsupportedFigmaOAuthScopes = [
  "file_variables:read",
  "file_variables:write",
  "files:read",
  "library_analytics:read",
] as const;

const decodeJsonText = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const encodeJsonText = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const vercelSpec = decodeJsonText(
  readFileSync(resolve(__dirname, "../../fixtures/vercel.json"), "utf-8"),
);

describe("OpenAPI presets", () => {
  it("narrows Figma OAuth to the supported scope set", () => {
    expect(FIGMA_SUPPORTED_OAUTH_SCOPES).toHaveLength(15);
    for (const scope of unsupportedFigmaOAuthScopes) {
      expect(FIGMA_SUPPORTED_OAUTH_SCOPES).not.toContain(scope);
    }

    const operation = FIGMA_SPEC_OVERRIDES[0];
    expect(operation).toMatchObject({
      op: "replace",
      path: "/components/securitySchemes/OAuth2/flows/authorizationCode/scopes",
      value: Object.fromEntries(FIGMA_SUPPORTED_OAUTH_SCOPES.map((scope) => [scope, ""])),
    });
  });

  it("projects Figma spec overrides through the plugin catalog", () => {
    const sdkPreset = openApiPresets.find((preset) => preset.id === "figma");
    const catalogPreset = openApiPlugin().integrationPresets?.find(
      (preset) => preset.id === "figma",
    );

    expect(sdkPreset?.specOverrides).toEqual(FIGMA_SPEC_OVERRIDES);
    expect(catalogPreset?.specOverrides).toEqual(FIGMA_SPEC_OVERRIDES);
  });

  it("projects Vercel spec overrides through the plugin catalog", () => {
    const catalogPreset = openApiPlugin().integrationPresets?.find(
      (preset) => preset.id === "vercel",
    );

    expect(catalogPreset?.specOverrides).toEqual(VERCEL_SPEC_OVERRIDES);
  });

  it.effect("adds the Vercel Observability events operation to the published spec", () =>
    Effect.gen(function* () {
      const patched = yield* applySpecOverrides(vercelSpec, VERCEL_SPEC_OVERRIDES);
      const result = yield* extract(yield* parse(encodeJsonText(patched)));
      const operation = result.operations.find(
        (candidate) => candidate.operationId === "queryObservabilityEvents",
      );

      expect(operation?.method).toBe("post");
      expect(operation?.pathTemplate).toBe("/v1/observability/events");
      expect(
        operation?.parameters.map((parameter) => [parameter.name, parameter.location]),
      ).toEqual([
        ["teamId", "query"],
        ["x-vercel-observability-query-reason", "header"],
      ]);
      expect(operation && Option.isSome(operation.requestBody)).toBe(true);
      expect(operation && Option.isSome(operation.outputSchema)).toBe(true);
      expect(
        result.operations.some((candidate) => candidate.operationId === "getRuntimeLogs"),
      ).toBe(true);
    }),
  );
});
