import { describe, expect, it } from "@effect/vitest";
import { OAuthClientSlug, type OAuthClientSummary } from "@executor-js/sdk/shared";

import {
  ENTERPRISE_IDENTITY_PROVIDER_CLIENT_OWNER,
  ENTERPRISE_IDENTITY_PROVIDER_CLIENT_SLUG,
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
  const valid = { submitting: false, tokenUrl: "https://idp.example/token", clientId: "abc" };

  it("accepts a public client with no secret", () => {
    expect(canSubmitEnterpriseIdentityProvider(valid)).toBe(true);
  });

  it("requires the token endpoint the assertion exchange is POSTed to", () => {
    expect(canSubmitEnterpriseIdentityProvider({ ...valid, tokenUrl: "   " })).toBe(false);
  });

  it("requires the client id the exchange authenticates as", () => {
    expect(canSubmitEnterpriseIdentityProvider({ ...valid, clientId: "" })).toBe(false);
  });

  it("refuses a second submit while one is in flight", () => {
    expect(canSubmitEnterpriseIdentityProvider({ ...valid, submitting: true })).toBe(false);
  });
});

describe("enterpriseIdentityProviderPayload", () => {
  it("registers the workspace-owned app under the reserved slug", () => {
    const payload = enterpriseIdentityProviderPayload({
      tokenUrl: "  https://idp.example/token  ",
      clientId: " abc ",
      clientSecret: " shh ",
    });
    expect(payload.owner).toBe(ENTERPRISE_IDENTITY_PROVIDER_CLIENT_OWNER);
    expect(String(payload.slug)).toBe(String(ENTERPRISE_IDENTITY_PROVIDER_CLIENT_SLUG));
    expect(payload.tokenUrl).toBe("https://idp.example/token");
    expect(payload.clientId).toBe("abc");
    expect(payload.clientSecret).toBe("shh");
  });

  it("records no authorization URL, because this app never runs a redirect", () => {
    // The enterprise-managed chain exchanges an assertion the member already
    // holds at the token endpoint; there is no authorization endpoint to store,
    // and inventing one would claim a flow this registration does not run.
    expect(
      enterpriseIdentityProviderPayload({
        tokenUrl: "https://idp.example/token",
        clientId: "abc",
        clientSecret: "",
      }).authorizationUrl,
    ).toBe("");
  });

  it("stamps no originating integration — it backs every managed server", () => {
    expect(
      enterpriseIdentityProviderPayload({
        tokenUrl: "https://idp.example/token",
        clientId: "abc",
        clientSecret: "",
      }).originIntegration,
    ).toBeNull();
  });
});
