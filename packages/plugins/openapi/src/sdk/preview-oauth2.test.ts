// ---------------------------------------------------------------------------
// Tests for OAuth2 flow extraction in previewSpec. Covers:
//   - authorizationCode flow extraction (URLs + scopes)
//   - clientCredentials flow extraction
//   - security schemes defined via $ref are no longer silently dropped
//   - bearerFormat / openIdConnectUrl are captured
//   - invalid flows (missing tokenUrl) are ignored
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { previewSpec as previewSpecRaw } from "./preview";

const previewSpec = (input: string) =>
  previewSpecRaw(input).pipe(Effect.provide(FetchHttpClient.layer));

const minimalSpec = (
  securitySchemes: Record<string, unknown>,
  components: Record<string, unknown> = {},
) => ({
  openapi: "3.0.0",
  info: { title: "Test API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/ping": {
      get: { responses: { "200": { description: "ok" } } },
    },
  },
  components: { ...components, securitySchemes },
});

describe("previewSpec OAuth2 extraction", () => {
  it.effect("extracts authorizationCode flow with URLs, scopes, refreshUrl", () =>
    Effect.gen(function* () {
      const spec = minimalSpec({
        oauth_app: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://example.com/oauth/authorize",
              tokenUrl: "https://example.com/oauth/token",
              refreshUrl: "https://example.com/oauth/refresh",
              scopes: {
                read: "Read access",
                write: "Write access",
              },
            },
          },
        },
      });
      const preview = yield* previewSpec(JSON.stringify(spec));

      expect(preview.securitySchemes).toHaveLength(1);
      const scheme = preview.securitySchemes[0]!;
      expect(scheme.name).toBe("oauth_app");
      expect(scheme.type).toBe("oauth2");
      expect(Option.isSome(scheme.flows)).toBe(true);
      const flows = Option.getOrThrow(scheme.flows);
      expect(Option.isSome(flows.authorizationCode)).toBe(true);
      const flow = Option.getOrThrow(flows.authorizationCode);
      expect(flow.authorizationUrl).toBe("https://example.com/oauth/authorize");
      expect(flow.tokenUrl).toBe("https://example.com/oauth/token");
      expect(Option.getOrElse(flow.refreshUrl, () => "")).toBe("https://example.com/oauth/refresh");
      expect(flow.scopes).toEqual({
        read: "Read access",
        write: "Write access",
      });

      // A preset should be generated for this flow.
      expect(preview.oauth2Presets).toHaveLength(1);
      expect(preview.headerPresets).toHaveLength(0);
      const preset = preview.oauth2Presets[0]!;
      expect(preset.flow).toBe("authorizationCode");
      expect(preset.securitySchemeName).toBe("oauth_app");
      expect(preset.tokenUrl).toBe("https://example.com/oauth/token");
      expect(preset.label).toContain("Authorization Code");
      expect(preset.label).toContain("oauth_app");
      expect(preset.scopes).toEqual({
        read: "Read access",
        write: "Write access",
      });
    }),
  );

  it.effect("extracts clientCredentials flow alongside authorizationCode", () =>
    Effect.gen(function* () {
      const spec = minimalSpec({
        oauth_app: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://example.com/auth",
              tokenUrl: "https://example.com/token",
              scopes: {},
            },
            clientCredentials: {
              tokenUrl: "https://example.com/token",
              scopes: { "admin:read": "Admin read" },
            },
          },
        },
      });
      const preview = yield* previewSpec(JSON.stringify(spec));

      expect(preview.oauth2Presets).toHaveLength(2);
      const flowKinds = preview.oauth2Presets.map((p) => p.flow).sort();
      expect(flowKinds).toEqual(["authorizationCode", "clientCredentials"]);

      const cc = preview.oauth2Presets.find((p) => p.flow === "clientCredentials")!;
      expect(Option.isNone(cc.authorizationUrl)).toBe(true);
      expect(cc.scopes).toEqual({ "admin:read": "Admin read" });
    }),
  );

  it.effect("skips authorizationCode flow missing tokenUrl or authorizationUrl", () =>
    Effect.gen(function* () {
      const spec = minimalSpec({
        broken: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://example.com/auth",
              // tokenUrl missing
              scopes: {},
            },
          },
        },
      });
      const preview = yield* previewSpec(JSON.stringify(spec));

      expect(preview.securitySchemes).toHaveLength(1);
      // Scheme is still captured but with no flows.
      expect(Option.isNone(preview.securitySchemes[0]!.flows)).toBe(true);
      expect(preview.oauth2Presets).toHaveLength(0);
    }),
  );

  it.effect("resolves security schemes defined via $ref", () =>
    Effect.gen(function* () {
      const spec = minimalSpec(
        {
          api_token: { $ref: "#/components/securitySchemes/_api_token_impl" },
        },
        {
          securitySchemes: {
            _api_token_impl: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
              description: "Internal token scheme",
            },
          },
        },
      );
      // Note: the outer securitySchemes at `components.securitySchemes` is
      // what previewSpec reads; the `_api_token_impl` shim inside
      // components.securitySchemes allows $ref resolution via the resolver.
      // The test spec above is slightly awkward because we have to nest both
      // under the same key — adjust by merging.
      spec.components = {
        securitySchemes: {
          api_token: { $ref: "#/components/securitySchemes/_api_token_impl" },
          _api_token_impl: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "Internal token scheme",
          },
        },
      };

      const preview = yield* previewSpec(JSON.stringify(spec));
      // Both keys are present, but the `api_token` entry should resolve to
      // the http bearer scheme (previously it was silently dropped).
      const apiToken = preview.securitySchemes.find((s) => s.name === "api_token");
      expect(apiToken).toBeDefined();
      expect(apiToken!.type).toBe("http");
      expect(Option.getOrElse(apiToken!.scheme, () => "")).toBe("bearer");
      expect(Option.getOrElse(apiToken!.bearerFormat, () => "")).toBe("JWT");
    }),
  );

  it.effect("captures openIdConnectUrl for openIdConnect schemes", () =>
    Effect.gen(function* () {
      const spec = minimalSpec({
        oidc: {
          type: "openIdConnect",
          openIdConnectUrl: "https://example.com/.well-known/openid-configuration",
        },
      });
      const preview = yield* previewSpec(JSON.stringify(spec));
      const scheme = preview.securitySchemes[0]!;
      expect(scheme.type).toBe("openIdConnect");
      expect(Option.getOrElse(scheme.openIdConnectUrl, () => "")).toBe(
        "https://example.com/.well-known/openid-configuration",
      );
    }),
  );
});
