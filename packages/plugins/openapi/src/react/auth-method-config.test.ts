import { describe, expect, it } from "@effect/vitest";
import { AuthTemplateSlug } from "@executor-js/sdk/shared";

import {
  authMethodsFromConfig,
  authenticationFromEditorValue,
  editorValueFromAuthentication,
  templateFromPlacements,
} from "./auth-method-config";
import type { Authentication } from "../sdk/types";

describe("authMethodsFromConfig", () => {
  it("projects oauth templates with their stored endpoints + scopes", () => {
    const methods = authMethodsFromConfig([
      {
        slug: AuthTemplateSlug.make("oauth"),
        kind: "oauth2",
        authorizationUrl: "https://x.example/auth",
        tokenUrl: "https://x.example/token",
        resource: "https://api.example",
        scopes: ["read"],
        supportsClientIdMetadataDocument: true,
      },
    ]);
    expect(methods[0]).toMatchObject({
      id: "oauth",
      kind: "oauth",
      source: "spec",
      oauth: {
        authorizationUrl: "https://x.example/auth",
        tokenUrl: "https://x.example/token",
        resource: "https://api.example",
        scopes: ["read"],
        supportsClientIdMetadataDocument: true,
      },
    });
  });

  it("projects apikey methods, multi-placement and multi-variable intact", () => {
    const methods = authMethodsFromConfig([
      {
        slug: "custom_dd",
        kind: "apikey",
        placements: [
          { carrier: "header", name: "DD-API-KEY", variable: "dd_api_key" },
          { carrier: "query", name: "team_id", variable: "team_id" },
        ],
      },
    ]);
    expect(methods[0]).toMatchObject({ id: "custom_dd", kind: "apikey", source: "custom" });
    expect(methods[0]?.placements).toEqual([
      { carrier: "header", name: "DD-API-KEY", prefix: "", variable: "dd_api_key" },
      { carrier: "query", name: "team_id", prefix: "", variable: "team_id" },
    ]);
  });
});

describe("editor round-trip", () => {
  it("apikey stored → editor → stored preserves placements and shared token input", () => {
    const stored: Authentication = {
      slug: "bearer",
      kind: "apikey",
      placements: [
        { carrier: "header", name: "Authorization", prefix: "Bearer " },
        { carrier: "query", name: "token" },
      ],
    };
    const editor = editorValueFromAuthentication(stored);
    const back = authenticationFromEditorValue(editor, "bearer");
    expect(back).toEqual(stored);
  });

  it("oauth stored → editor carries endpoints + scopes", () => {
    expect(
      editorValueFromAuthentication({
        slug: AuthTemplateSlug.make("oauth"),
        kind: "oauth2",
        authorizationUrl: "https://x.example/auth",
        tokenUrl: "https://x.example/token",
        resource: "https://api.example",
        scopes: ["a", "b"],
        supportsClientIdMetadataDocument: true,
      }),
    ).toEqual({
      kind: "oauth",
      authorizationUrl: "https://x.example/auth",
      tokenUrl: "https://x.example/token",
      resource: "https://api.example",
      scopes: ["a", "b"],
      supportsClientIdMetadataDocument: true,
    });
  });

  it("none editor value yields no method", () => {
    expect(authenticationFromEditorValue({ kind: "none" })).toBeNull();
  });
});

describe("templateFromPlacements", () => {
  it("multi-placement custom methods assign distinct name-derived variables", () => {
    expect(
      templateFromPlacements(
        [
          { carrier: "header", name: "DD-API-KEY", prefix: "" },
          { carrier: "header", name: "DD-APPLICATION-KEY", prefix: "" },
        ],
        "custom_dd",
      ),
    ).toEqual({
      slug: "custom_dd",
      kind: "apikey",
      placements: [
        { carrier: "header", name: "DD-API-KEY", variable: "dd_api_key" },
        { carrier: "header", name: "DD-APPLICATION-KEY", variable: "dd_application_key" },
      ],
    });
  });

  it("a lone placement keeps the canonical token input (stored absent)", () => {
    expect(templateFromPlacements([{ carrier: "query", name: "api_key", prefix: "" }])).toEqual({
      slug: "",
      kind: "apikey",
      placements: [{ carrier: "query", name: "api_key" }],
    });
  });
});
