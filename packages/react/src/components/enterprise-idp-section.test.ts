import { describe, expect, it } from "@effect/vitest";
import { OAuthClientSlug, type OAuthClientSummary } from "@executor-js/sdk/shared";

import {
  ENTERPRISE_IDENTITY_PROVIDER_CLIENT_OWNER,
  ENTERPRISE_IDENTITY_PROVIDER_CLIENT_SLUG,
  ENTERPRISE_IDENTITY_PROVIDER_DESCRIPTOR,
  canSubmitEnterpriseIdentityProvider,
  enterpriseIdentityProviderPayload,
  findEnterpriseIdentityProvider,
} from "./enterprise-idp-section";

const client = (overrides: Partial<OAuthClientSummary>): OAuthClientSummary => ({
  owner: "org",
  slug: OAuthClientSlug.make("some-app"),
  grant: "authorization_code",
  authorizationUrl: "https://example.com/authorize",
  tokenUrl: "https://example.com/token",
  clientId: "client-id",
  origin: { kind: "manual" },
  ...overrides,
});

describe("findEnterpriseIdentityProvider", () => {
  it("finds the workspace registration under the reserved slug", () => {
    const provider = client({ slug: ENTERPRISE_IDENTITY_PROVIDER_CLIENT_SLUG });
    expect(findEnterpriseIdentityProvider([client({}), provider])).toBe(provider);
  });

  it("returns null when the organization has registered none", () => {
    expect(findEnterpriseIdentityProvider([client({})])).toBeNull();
  });

  it("ignores a personal app that happens to carry the reserved slug", () => {
    // The provider is an ORGANIZATION control; a user-owned app under the same
    // slug is a different app and must never stand in for it.
    expect(
      findEnterpriseIdentityProvider([
        client({ owner: "user", slug: ENTERPRISE_IDENTITY_PROVIDER_CLIENT_SLUG }),
      ]),
    ).toBeNull();
  });
});

describe("canSubmitEnterpriseIdentityProvider", () => {
  const valid = {
    submitting: false,
    issuerUrl: "https://idp.example/oauth2/default",
    clientId: "abc",
  };

  it("accepts a public client with no secret", () => {
    expect(canSubmitEnterpriseIdentityProvider(valid)).toBe(true);
  });

  it("requires the issuer the endpoints are discovered from", () => {
    // Endpoints are never typed: they are probed off the issuer, so the issuer
    // is the field the registration cannot proceed without.
    expect(canSubmitEnterpriseIdentityProvider({ ...valid, issuerUrl: "   " })).toBe(false);
  });

  it("requires the client id the exchange authenticates as", () => {
    expect(canSubmitEnterpriseIdentityProvider({ ...valid, clientId: "" })).toBe(false);
  });

  it("refuses a second submit while one is in flight", () => {
    expect(canSubmitEnterpriseIdentityProvider({ ...valid, submitting: true })).toBe(false);
  });
});

describe("enterpriseIdentityProviderPayload", () => {
  const discovered = {
    authorizationUrl: "  https://idp.example/authorize  ",
    tokenUrl: "  https://idp.example/token  ",
  };

  it("registers the workspace-owned app under the reserved slug", () => {
    const payload = enterpriseIdentityProviderPayload({
      ...discovered,
      clientId: " abc ",
      clientSecret: " shh ",
    });
    expect(payload.owner).toBe(ENTERPRISE_IDENTITY_PROVIDER_CLIENT_OWNER);
    expect(String(payload.slug)).toBe(String(ENTERPRISE_IDENTITY_PROVIDER_CLIENT_SLUG));
    expect(payload.tokenUrl).toBe("https://idp.example/token");
    expect(payload.clientId).toBe("abc");
    expect(payload.clientSecret).toBe("shh");
  });

  it("records the authorization endpoint the work-identity link needs", () => {
    // The ID-JAG exchange itself only touches the token endpoint. The
    // authorization endpoint is here for the hop that produces the subject
    // token in the first place: an assertion issued BY this provider and
    // audienced to THIS client, which a brokered login does not yield.
    expect(
      enterpriseIdentityProviderPayload({ ...discovered, clientId: "abc", clientSecret: "" })
        .authorizationUrl,
    ).toBe("https://idp.example/authorize");
  });

  it("registers the authorization-code grant, not the enterprise grant", () => {
    // `id_jag` names the registration at an MCP server's authorization server.
    // THIS app is the registration at the identity provider — it authenticates
    // the exchange and runs the work-identity hop, both authorization-code
    // shaped.
    expect(
      enterpriseIdentityProviderPayload({ ...discovered, clientId: "abc", clientSecret: "" }).grant,
    ).toBe("authorization_code");
  });

  it("stamps no originating integration — it backs every managed server", () => {
    expect(
      enterpriseIdentityProviderPayload({ ...discovered, clientId: "abc", clientSecret: "" })
        .originIntegration,
    ).toBeNull();
  });
});

describe("ENTERPRISE_IDENTITY_PROVIDER_DESCRIPTOR", () => {
  it("names the same registration the section writes", () => {
    // A server declaration and a connect request both point at the provider by
    // (owner, slug). If this descriptor and the payload ever disagreed, every
    // managed server would name a registration that does not exist.
    expect(String(ENTERPRISE_IDENTITY_PROVIDER_DESCRIPTOR.client)).toBe(
      String(ENTERPRISE_IDENTITY_PROVIDER_CLIENT_SLUG),
    );
    expect(ENTERPRISE_IDENTITY_PROVIDER_DESCRIPTOR.clientOwner).toBe(
      ENTERPRISE_IDENTITY_PROVIDER_CLIENT_OWNER,
    );
  });
});
