import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import { ApiKeyAuthTemplate, apiKeyMethodFromAuthTemplate, variable } from "./authoring";
import { renderAuthPlacements } from "./auth-method";

const decode = Schema.decodeUnknownOption(ApiKeyAuthTemplate);

describe("request-shaped authoring", () => {
  it("a bearer header template expands to the canonical placement", () => {
    expect(
      apiKeyMethodFromAuthTemplate({
        slug: "bearer",
        type: "apiKey",
        headers: { Authorization: ["Bearer ", variable("token")] },
      }),
    ).toEqual({
      slug: "bearer",
      kind: "apikey",
      placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
    });
  });

  it("headers and query params mix, each input keeping its variable", () => {
    const method = apiKeyMethodFromAuthTemplate({
      type: "apiKey",
      headers: { Authorization: ["Bearer ", variable("api_token")] },
      queryParams: { team_id: [variable("team_id")] },
    });
    expect(method.placements).toEqual([
      { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "api_token" },
      { carrier: "query", name: "team_id", variable: "team_id" },
    ]);
    // …and the expansion renders exactly like the template reads.
    expect(renderAuthPlacements(method.placements, { api_token: "tok", team_id: "t42" })).toEqual({
      headers: { Authorization: "Bearer tok" },
      queryParams: { team_id: "t42" },
    });
  });

  it("a plain-string value is a static literal (no credential input)", () => {
    expect(
      apiKeyMethodFromAuthTemplate({
        type: "apiKey",
        headers: { "X-Api-Version": "2023-01-01", "X-Api-Key": [variable("token")] },
      }).placements,
    ).toEqual([
      { carrier: "header", name: "X-Api-Version", literal: "2023-01-01" },
      { carrier: "header", name: "X-Api-Key" },
    ]);
  });

  it("slug and label are optional and carried through", () => {
    const method = apiKeyMethodFromAuthTemplate({
      type: "apiKey",
      label: "Team key",
      queryParams: { token: [variable("token")] },
    });
    expect(method.slug).toBeUndefined();
    expect(method.label).toBe("Team key");
  });

  it("rejects a variable that is not the final part (authoring is strict)", () => {
    expect(
      Option.isNone(
        decode({
          type: "apiKey",
          headers: { Authorization: [variable("token"), "-suffix"] },
        }),
      ),
    ).toBe(true);
  });

  it("rejects two variables in one value", () => {
    expect(
      Option.isNone(
        decode({
          type: "apiKey",
          headers: { Authorization: [variable("a"), ":", variable("b")] },
        }),
      ),
    ).toBe(true);
  });

  it("accepts the strict shapes it should", () => {
    expect(
      Option.isSome(
        decode({
          slug: "ok",
          type: "apiKey",
          headers: { A: ["Bearer ", variable("token")], B: "literal" },
          queryParams: { q: [variable("q")] },
        }),
      ),
    ).toBe(true);
  });
});
