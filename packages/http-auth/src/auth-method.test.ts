import { describe, expect, it } from "@effect/vitest";

import {
  type ApiKeyAuthMethod,
  type AuthPlacement,
  apiKeyMethodLabel,
  describeApiKeyAuthMethod,
  describeNoneAuthMethod,
  normalizeAuthMethodSlugs,
  oauthBearerPlacement,
  renderAuthPlacements,
  requiredPlacementVariables,
} from "./auth-method";

describe("renderAuthPlacements", () => {
  it("renders a bearer header from the implicit token variable", () => {
    expect(
      renderAuthPlacements([{ carrier: "header", name: "Authorization", prefix: "Bearer " }], {
        token: "tok_1",
      }),
    ).toEqual({ headers: { Authorization: "Bearer tok_1" }, queryParams: {} });
  });

  it("renders a query param (the ui.sh '?token=' case)", () => {
    expect(renderAuthPlacements([{ carrier: "query", name: "token" }], { token: "tok_1" })).toEqual(
      { headers: {}, queryParams: { token: "tok_1" } },
    );
  });

  it("mixes header and query placements in one method", () => {
    expect(
      renderAuthPlacements(
        [
          { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "api_token" },
          { carrier: "query", name: "team_id", variable: "team_id" },
        ],
        { api_token: "tok_1", team_id: "team_9" },
      ),
    ).toEqual({
      headers: { Authorization: "Bearer tok_1" },
      queryParams: { team_id: "team_9" },
    });
  });

  it("renders distinct variables into their own placements (Datadog's two keys)", () => {
    expect(
      renderAuthPlacements(
        [
          { carrier: "header", name: "DD-API-KEY", variable: "dd_api_key" },
          { carrier: "header", name: "DD-APPLICATION-KEY", variable: "dd_application_key" },
        ],
        { dd_api_key: "a", dd_application_key: "b" },
      ),
    ).toEqual({
      headers: { "DD-API-KEY": "a", "DD-APPLICATION-KEY": "b" },
      queryParams: {},
    });
  });

  it("lets two placements share one variable (same value in two spots)", () => {
    expect(
      renderAuthPlacements(
        [
          { carrier: "header", name: "X-Token" },
          { carrier: "query", name: "token" },
        ],
        { token: "shared" },
      ),
    ).toEqual({ headers: { "X-Token": "shared" }, queryParams: { token: "shared" } });
  });

  it("renders literal placements verbatim, with no credential", () => {
    expect(
      renderAuthPlacements(
        [
          { carrier: "header", name: "X-Api-Version", literal: "2023-01-01" },
          { carrier: "header", name: "Authorization", prefix: "Bearer " },
        ],
        { token: "tok_1" },
      ),
    ).toEqual({
      headers: { "X-Api-Version": "2023-01-01", Authorization: "Bearer tok_1" },
      queryParams: {},
    });
  });

  it("skips a credential placement whose variable resolved to nothing", () => {
    expect(
      renderAuthPlacements(
        [
          { carrier: "header", name: "Authorization", prefix: "Bearer " },
          { carrier: "query", name: "team_id", variable: "team_id" },
        ],
        { token: "tok_1", team_id: null },
      ),
    ).toEqual({ headers: { Authorization: "Bearer tok_1" }, queryParams: {} });
  });

  it("renders nothing for an empty values map", () => {
    expect(
      renderAuthPlacements([{ carrier: "header", name: "Authorization", prefix: "Bearer " }], {}),
    ).toEqual({ headers: {}, queryParams: {} });
  });
});

describe("requiredPlacementVariables", () => {
  it("dedupes shared variables and defaults absent ones to token", () => {
    const placements: readonly AuthPlacement[] = [
      { carrier: "header", name: "X-Token" },
      { carrier: "query", name: "token" },
      { carrier: "query", name: "team_id", variable: "team_id" },
    ];
    expect(requiredPlacementVariables(placements)).toEqual(["token", "team_id"]);
  });

  it("excludes literal placements (they reference no credential)", () => {
    expect(
      requiredPlacementVariables([
        { carrier: "header", name: "X-Api-Version", literal: "2023-01-01" },
      ]),
    ).toEqual([]);
  });
});

describe("oauthBearerPlacement", () => {
  it("defaults to the conventional Authorization: Bearer header", () => {
    expect(renderAuthPlacements([oauthBearerPlacement()], { token: "at_1" })).toEqual({
      headers: { Authorization: "Bearer at_1" },
      queryParams: {},
    });
  });

  it("honors a custom header and prefix (graphql oauth override)", () => {
    expect(
      renderAuthPlacements([oauthBearerPlacement("X-Access-Token", "")], { token: "at_1" }),
    ).toEqual({ headers: { "X-Access-Token": "at_1" }, queryParams: {} });
  });
});

describe("normalizeAuthMethodSlugs", () => {
  type Input = { readonly slug?: string | undefined; readonly kind: string };
  const byKind = (method: Input) => method.kind;

  it("keeps caller-provided slugs and defaults the rest", () => {
    expect(
      normalizeAuthMethodSlugs(
        [{ slug: "custom_abc", kind: "apikey" }, { kind: "none" }],
        byKind,
      ).map((m) => m.slug),
    ).toEqual(["custom_abc", "none"]);
  });

  it("suffixes collisions deterministically", () => {
    expect(
      normalizeAuthMethodSlugs(
        [{ kind: "apikey" }, { kind: "apikey" }, { slug: "apikey", kind: "apikey" }],
        byKind,
      ).map((m) => m.slug),
    ).toEqual(["apikey", "apikey_2", "apikey_3"]);
  });

  it("treats a blank slug as absent", () => {
    expect(normalizeAuthMethodSlugs([{ slug: "  ", kind: "oauth2" }], byKind)[0]?.slug).toBe(
      "oauth2",
    );
  });
});

describe("catalog projection", () => {
  it("projects an apikey method with placements, deriving the label", () => {
    const method: ApiKeyAuthMethod = {
      slug: "header",
      kind: "apikey",
      placements: [{ carrier: "header", name: "X-Api-Key", prefix: "Bearer " }],
    };
    expect(describeApiKeyAuthMethod(method)).toEqual({
      id: "header",
      label: "API key (X-Api-Key)",
      kind: "apikey",
      template: "header",
      placements: [{ carrier: "header", name: "X-Api-Key", prefix: "Bearer " }],
    });
  });

  it("carries explicit variables and literals through to the descriptor", () => {
    const method: ApiKeyAuthMethod = {
      slug: "custom_x",
      kind: "apikey",
      label: "Token + team",
      placements: [
        { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "api_token" },
        { carrier: "query", name: "team_id", variable: "team_id" },
        { carrier: "header", name: "X-Api-Version", literal: "2023-01-01" },
      ],
    };
    expect(describeApiKeyAuthMethod(method)).toEqual({
      id: "custom_x",
      label: "Token + team",
      kind: "apikey",
      template: "custom_x",
      placements: [
        { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "api_token" },
        { carrier: "query", name: "team_id", prefix: "", variable: "team_id" },
        { carrier: "header", name: "X-Api-Version", prefix: "", literal: "2023-01-01" },
      ],
    });
  });

  it("falls back to the slug when no placement is named", () => {
    expect(apiKeyMethodLabel({ slug: "custom_y", kind: "apikey", placements: [] })).toBe(
      "API key (custom_y)",
    );
  });

  it("projects a none method", () => {
    expect(describeNoneAuthMethod("none")).toEqual({
      id: "none",
      label: "No authentication",
      kind: "none",
      template: "none",
    });
  });
});
