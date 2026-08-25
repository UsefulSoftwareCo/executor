// oxlint-disable executor/no-unknown-error-message -- boundary: every `.message`
// read below is on a TYPED error under test (EMA / OAuth2Error), where the
// rendered message is the assertion target.
// ---------------------------------------------------------------------------
// Protocol conformance for MCP Enterprise-Managed Authorization
// (draft-ietf-oauth-identity-assertion-authz-grant-04).
//
// The fixtures are generic protocol servers, not fakes of a named product: one
// plays the enterprise IdP Authorization Server, one plays the MCP server's
// Resource Authorization Server, and they are wired to each other exactly as
// the draft describes (RFC 8414 metadata → `jwks_uri` → RS256 verification).
// They are STRICTER than deployed servers on purpose — a lenient fixture would
// let a client bug pass here and fail in production.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Ref, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import { supportsIdJagGrantProfile } from "./oauth-discovery";
import {
  EmaGrantProfileUnsupported,
  mintEnterpriseManagedAccessToken,
  runEnterpriseManagedAuthorization,
  type EnterpriseManagedAuthorizationError,
} from "./oauth-ema";
import { exchangeSubjectTokenForIdJag, redeemIdJagAssertion } from "./oauth-helpers";
import { serveOAuthTestServer, serveTestHttpApp, type OAuthTestServerShape } from "./testing";

const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token" as const;
const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";

const CLIENT_AT_IDP = "mcp-client-at-idp";
const CLIENT_AT_RESOURCE = "mcp-client-at-resource";

interface EnterpriseFixture {
  readonly idp: OAuthTestServerShape;
  readonly resource: OAuthTestServerShape;
  readonly subjectToken: string;
}

/** Stand up the two authorization servers of the profile plus a signed-in user
 *  at the IdP, and return the identity assertion that single sign-on produced.
 *  The IdP maps the client's IdP-side id to its DIFFERENT resource-side id
 *  (draft §5), so every test here exercises the cross-domain client_id handling
 *  rather than the degenerate same-id case. */
const enterpriseFixture = (
  overrides: {
    readonly idp?: Parameters<typeof serveOAuthTestServer>[0];
    readonly resourceAdvertisesProfile?: boolean;
    readonly resourceGrantableScopes?: readonly string[];
  } = {},
) =>
  Effect.gen(function* () {
    const idp = yield* serveOAuthTestServer({
      clients: { [CLIENT_AT_IDP]: null },
      scopes: ["mcp.read", "mcp.write"],
      ...overrides.idp,
      enterpriseIdp: {
        resourceClientIds: { [CLIENT_AT_IDP]: CLIENT_AT_RESOURCE },
        ...overrides.idp?.enterpriseIdp,
      },
    });
    const resource = yield* serveOAuthTestServer({
      clients: { [CLIENT_AT_RESOURCE]: null },
      scopes: ["mcp.read", "mcp.write"],
      ...(overrides.resourceAdvertisesProfile === false
        ? {}
        : {
            enterpriseResourceServer: {
              trustedIdpIssuer: idp.issuerUrl,
              ...(overrides.resourceGrantableScopes === undefined
                ? {}
                : { grantableScopes: overrides.resourceGrantableScopes }),
            },
          }),
    });
    const session = yield* idp.completeAuthorizationCodeTokenFlow({
      clientId: CLIENT_AT_IDP,
      clientSecret: "",
      scopes: ["mcp.read", "mcp.write"],
    });
    return { idp, resource, subjectToken: session.accessToken } satisfies EnterpriseFixture;
  });

const chainInput = (fixture: EnterpriseFixture, scopes: readonly string[]) => ({
  idp: { tokenUrl: fixture.idp.tokenEndpoint, clientId: CLIENT_AT_IDP },
  resourceAuthorizationServer: {
    tokenUrl: fixture.resource.tokenEndpoint,
    issuer: fixture.resource.issuerUrl,
    clientId: CLIENT_AT_RESOURCE,
  },
  subjectToken: fixture.subjectToken,
  subjectTokenType: ACCESS_TOKEN_TYPE,
  scopes,
});

/** Fetch the resource server's RFC 8414 metadata the way the connect path does,
 *  so the profile-detection assertions run against a real document. */
const resourceMetadata = (fixture: EnterpriseFixture) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      // oxlint-disable-next-line executor/no-raw-fetch -- test boundary: reads the fixture's metadata document exactly as the connect path's discovery does
      globalThis.fetch(`${fixture.resource.issuerUrl}/.well-known/oauth-authorization-server`),
    );
    return yield* Effect.promise(() => response.json() as Promise<never>);
  });

const AuthorizationServerMetadata = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  grant_types_supported: Schema.optional(Schema.Array(Schema.String)),
  authorization_grant_profiles_supported: Schema.optional(Schema.Array(Schema.String)),
});
const decodeMetadata = Schema.decodeUnknownSync(AuthorizationServerMetadata);

describe("enterprise-managed authorization: the ID-JAG chain", () => {
  it.effect("mints an MCP access token from an enterprise identity assertion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* enterpriseFixture();
        const metadata = decodeMetadata(yield* resourceMetadata(fixture));

        expect(
          supportsIdJagGrantProfile(metadata),
          "the resource authorization server advertises the id-jag grant profile",
        ).toBe(true);
        expect(
          metadata.grant_types_supported,
          "draft §7.2: advertising the profile requires advertising jwt-bearer too",
        ).toContain("urn:ietf:params:oauth:grant-type:jwt-bearer");

        const grant = yield* runEnterpriseManagedAuthorization({
          ...chainInput(fixture, ["mcp.read", "mcp.write"]),
          authorizationServerMetadata: metadata,
          resourceAuthorizationServer: { clientId: CLIENT_AT_RESOURCE },
        });

        expect(grant.scope, "the granted scope survives the whole chain").toBe(
          "mcp.read mcp.write",
        );
        expect(
          yield* fixture.resource.acceptsAccessToken(grant.token.access_token),
          "the MCP server's authorization server issued the access token",
        ).toBe(true);
        expect(
          grant.token.refresh_token,
          "draft §4.4.3: redeeming an ID-JAG issues no refresh token",
        ).toBeUndefined();
        expect(
          grant.token.token_type,
          "the redemption yields an ordinary bearer access token (case-normalised by the OAuth library)",
        ).toBe("bearer");
      }),
    ),
  );

  it.effect("re-runs the exchange on every mint rather than reusing an assertion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* enterpriseFixture();
        const first = yield* mintEnterpriseManagedAccessToken(chainInput(fixture, ["mcp.read"]));
        const second = yield* mintEnterpriseManagedAccessToken(chainInput(fixture, ["mcp.read"]));

        expect(
          second.token.access_token,
          "an expired access token is replaced, never re-issued",
        ).not.toBe(first.token.access_token);
        const exchanges = (yield* fixture.idp.requests).filter(
          (entry) => entry.path === "/token" && entry.body.includes("token-exchange"),
        );
        expect(
          exchanges.length,
          "each renewal goes back to the IdP so its policy is re-evaluated",
        ).toBe(2);
      }),
    ),
  );

  it.effect("narrows the access token to the scopes the resource server grants", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* enterpriseFixture({ resourceGrantableScopes: ["mcp.read"] });
        const grant = yield* mintEnterpriseManagedAccessToken(
          chainInput(fixture, ["mcp.read", "mcp.write"]),
        );
        expect(
          grant.scope,
          "the resource authorization server may grant a subset of the assertion's scope",
        ).toBe("mcp.read");
      }),
    ),
  );

  it.effect("carries the IdP's narrowed scope forward instead of re-requesting more", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* enterpriseFixture({
          idp: { enterpriseIdp: { grantScope: () => "mcp.read" } },
        });
        const grant = yield* mintEnterpriseManagedAccessToken(
          chainInput(fixture, ["mcp.read", "mcp.write"]),
        );
        expect(grant.scope, "enterprise policy narrowed the grant at the IdP").toBe("mcp.read");
        const redemptions = (yield* fixture.resource.requests).filter(
          (entry) => entry.path === "/token",
        );
        expect(
          redemptions.at(-1)?.body,
          "the redemption must not ask for more than the IdP granted",
        ).toContain("scope=mcp.read");
        expect(redemptions.at(-1)?.body).not.toContain("mcp.write");
      }),
    ),
  );
});

describe("enterprise-managed authorization: failure taxonomy", () => {
  it.effect("reports an unadvertised grant profile as the one fallback-safe failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* enterpriseFixture({ resourceAdvertisesProfile: false });
        const metadata = decodeMetadata(yield* resourceMetadata(fixture));
        expect(supportsIdJagGrantProfile(metadata)).toBe(false);

        const error = yield* runEnterpriseManagedAuthorization({
          ...chainInput(fixture, ["mcp.read"]),
          authorizationServerMetadata: metadata,
          resourceAuthorizationServer: { clientId: CLIENT_AT_RESOURCE },
        }).pipe(Effect.flip);

        expect(
          Predicate.isTagged(error, "EmaGrantProfileUnsupported"),
          "the one tag the connect path catches: a server that does not implement the profile gets the ordinary OAuth flow",
        ).toBe(true);
        expect(
          (yield* fixture.idp.requests).some((entry) => entry.body.includes("token-exchange")),
          "detection happens before any token is exchanged",
        ).toBe(false);
      }),
    ),
  );

  it.effect("reports an IdP policy refusal as blocked-by-admin, never as a fallback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* enterpriseFixture({
          idp: {
            enterpriseIdp: {
              denyExchangeWith: {
                error: "unauthorized_client",
                errorDescription: "Policy does not permit this client to access the target server.",
              },
            },
          },
        });
        const metadata = decodeMetadata(yield* resourceMetadata(fixture));
        const error: EnterpriseManagedAuthorizationError = yield* runEnterpriseManagedAuthorization(
          {
            ...chainInput(fixture, ["mcp.read"]),
            authorizationServerMetadata: metadata,
            resourceAuthorizationServer: { clientId: CLIENT_AT_RESOURCE },
          },
        ).pipe(Effect.flip);

        expect(
          Predicate.isTagged(error, "EmaPolicyDenied"),
          "offering interactive OAuth here would route the user around enterprise policy, so this tag is NOT the one the connect path catches",
        ).toBe(true);
        if (!Predicate.isTagged(error, "EmaPolicyDenied")) return;
        expect(error.error).toBe("unauthorized_client");
        expect(
          (yield* fixture.resource.requests).some((entry) => entry.path === "/token"),
          "a denied exchange never reaches the resource authorization server",
        ).toBe(false);
      }),
    ),
  );

  it.effect("reports a dead identity assertion as needing single sign-on again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* enterpriseFixture();
        yield* fixture.idp.revokeAccessToken(fixture.subjectToken);

        const error = yield* mintEnterpriseManagedAccessToken(
          chainInput(fixture, ["mcp.read"]),
        ).pipe(Effect.flip);

        expect(
          Predicate.isTagged(error, "EmaSubjectTokenRejected"),
          "a dead assertion needs a fresh single sign-on, not the interactive per-server flow",
        ).toBe(true);
      }),
    ),
  );

  it.effect("rejects an ID-JAG minted for a different authorization server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* enterpriseFixture();
        const otherResource = yield* serveOAuthTestServer({
          clients: { [CLIENT_AT_RESOURCE]: null },
          enterpriseResourceServer: { trustedIdpIssuer: fixture.idp.issuerUrl },
        });

        // Ask the IdP for an assertion whose `aud` names the OTHER server, then
        // present it here. The signature is genuine and the client is the right
        // one; only the audience is wrong, which is the whole confused-deputy
        // attack the `aud` check exists to stop.
        const misdirected = yield* exchangeSubjectTokenForIdJag({
          tokenUrl: fixture.idp.tokenEndpoint,
          clientId: CLIENT_AT_IDP,
          subjectToken: fixture.subjectToken,
          subjectTokenType: ACCESS_TOKEN_TYPE,
          audience: otherResource.issuerUrl,
        });

        const error = yield* redeemIdJagAssertion({
          tokenUrl: fixture.resource.tokenEndpoint,
          clientId: CLIENT_AT_RESOURCE,
          assertion: misdirected.assertion,
        }).pipe(Effect.flip);

        expect(error.error).toBe("invalid_grant");
        expect(error.message).toContain("does not name this authorization server");
      }),
    ),
  );

  it.effect("rejects an assertion whose header typ is not oauth-id-jag+jwt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* enterpriseFixture({
          idp: { enterpriseIdp: { assertionTyp: "JWT" } },
        });
        const error = yield* mintEnterpriseManagedAccessToken(
          chainInput(fixture, ["mcp.read"]),
        ).pipe(Effect.flip);

        expect(Predicate.isTagged(error, "EmaRedemptionRejected")).toBe(true);
        expect(error.message).toContain("typ must be oauth-id-jag+jwt");
      }),
    ),
  );

  it.effect("rejects an expired ID-JAG", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* enterpriseFixture({
          idp: { enterpriseIdp: { idJagExpiresInSeconds: -1 } },
        });
        const error = yield* mintEnterpriseManagedAccessToken(
          chainInput(fixture, ["mcp.read"]),
        ).pipe(Effect.flip);

        expect(Predicate.isTagged(error, "EmaRedemptionRejected")).toBe(true);
        expect(error.message).toContain("has expired");
      }),
    ),
  );

  it.effect("rejects an ID-JAG whose client_id claim names a different client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The IdP maps this client to a resource-side id nobody registered, so the
        // assertion's `client_id` cannot match whoever authenticates the
        // redemption. draft §4.4.1 requires the server to refuse.
        const fixture = yield* enterpriseFixture({
          idp: { enterpriseIdp: { resourceClientIds: { [CLIENT_AT_IDP]: "some-other-client" } } },
        });
        const error = yield* mintEnterpriseManagedAccessToken(
          chainInput(fixture, ["mcp.read"]),
        ).pipe(Effect.flip);

        expect(Predicate.isTagged(error, "EmaRedemptionRejected")).toBe(true);
        expect(error.message).toContain("does not match the authenticated client");
      }),
    ),
  );

  it.effect("refuses to treat an ID-JAG as a bearer token for the MCP endpoint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* enterpriseFixture();
        const grant = yield* exchangeSubjectTokenForIdJag({
          tokenUrl: fixture.idp.tokenEndpoint,
          clientId: CLIENT_AT_IDP,
          subjectToken: fixture.subjectToken,
          subjectTokenType: ACCESS_TOKEN_TYPE,
          audience: fixture.resource.issuerUrl,
        });

        const response = yield* Effect.promise(() =>
          // oxlint-disable-next-line executor/no-raw-fetch -- test boundary: presents the assertion as a raw bearer token, which no product code path would do
          globalThis.fetch(fixture.resource.mcpResourceUrl, {
            method: "POST",
            headers: { authorization: `Bearer ${grant.assertion}` },
          }),
        );
        expect(
          response.status,
          "an authorization grant is not an access token and the resource must say so",
        ).toBe(401);
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Token-exchange response contract (draft §4.3.4). These need a server that
// answers WRONGLY, which the conformant fixture above will never do.
// ---------------------------------------------------------------------------

const serveTokenEndpoint = (body: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<readonly string[]>([]);
    const server = yield* serveTestHttpApp((request) =>
      Effect.gen(function* () {
        const text = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));
        yield* Ref.update(requests, (all) => [...all, text]);
        return HttpServerResponse.jsonUnsafe(body, { status: 200 });
      }),
    );
    return { tokenUrl: `${server.baseUrl}/token`, requests: Ref.get(requests) };
  });

describe("enterprise-managed authorization: token exchange response contract", () => {
  it.effect("rejects a response whose issued_token_type is not an ID-JAG", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveTokenEndpoint({
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          access_token: "not-an-assertion",
          token_type: "N_A",
        });
        const error = yield* exchangeSubjectTokenForIdJag({
          tokenUrl: server.tokenUrl,
          clientId: CLIENT_AT_IDP,
          subjectToken: "assertion",
          subjectTokenType: ACCESS_TOKEN_TYPE,
          audience: "https://resource.example",
        }).pipe(Effect.flip);
        expect(error.message).toContain("issued_token_type");
      }),
    ),
  );

  it.effect("rejects a response whose token_type is not the N_A sentinel", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveTokenEndpoint({
          issued_token_type: ID_JAG_TOKEN_TYPE,
          access_token: "assertion",
          token_type: "Bearer",
        });
        const error = yield* exchangeSubjectTokenForIdJag({
          tokenUrl: server.tokenUrl,
          clientId: CLIENT_AT_IDP,
          subjectToken: "assertion",
          subjectTokenType: ACCESS_TOKEN_TYPE,
          audience: "https://resource.example",
        }).pipe(Effect.flip);
        expect(
          error.message,
          "a Bearer token here would be a live credential the client would treat as a grant",
        ).toContain("token_type");
      }),
    ),
  );

  it.effect("sends the draft §4.3 parameters verbatim", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveTokenEndpoint({
          issued_token_type: ID_JAG_TOKEN_TYPE,
          access_token: "assertion",
          token_type: "N_A",
        });
        yield* exchangeSubjectTokenForIdJag({
          tokenUrl: server.tokenUrl,
          clientId: CLIENT_AT_IDP,
          subjectToken: "the-assertion",
          subjectTokenType: ACCESS_TOKEN_TYPE,
          audience: "https://auth.example/",
          resource: "https://mcp.example/mcp",
          scopes: ["mcp.read"],
        });
        const sent = new URLSearchParams((yield* server.requests)[0] ?? "");
        expect(sent.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
        expect(sent.get("requested_token_type")).toBe(ID_JAG_TOKEN_TYPE);
        expect(sent.get("audience"), "EMA §4: the audience is the resource AS issuer").toBe(
          "https://auth.example/",
        );
        expect(sent.get("resource"), "EMA §4: the resource is the MCP server's identifier").toBe(
          "https://mcp.example/mcp",
        );
        expect(sent.get("subject_token")).toBe("the-assertion");
        expect(sent.get("subject_token_type")).toBe(ACCESS_TOKEN_TYPE);
        expect(sent.get("scope")).toBe("mcp.read");
      }),
    ),
  );
});

describe("EmaGrantProfileUnsupported", () => {
  it("names the profile the server failed to advertise", () => {
    const error = new EmaGrantProfileUnsupported({
      issuer: "https://auth.example",
      advertised: ["urn:example:other"],
    });
    expect(error.message).toContain("urn:ietf:params:oauth:grant-profile:id-jag");
    expect(error.message).toContain("urn:example:other");
  });
});
