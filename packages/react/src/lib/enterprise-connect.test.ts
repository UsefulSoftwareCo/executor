import { describe, expect, it } from "@effect/vitest";
import {
  AuthTemplateSlug,
  IntegrationSlug,
  OAuthClientSlug,
  type OAuthClientSummary,
} from "@executor-js/sdk/shared";

import { enterpriseConnectPlan, selectEnterpriseClient } from "./enterprise-connect";
import type { AuthMethod } from "./auth-placements";

const INTEGRATION = IntegrationSlug.make("acme_mcp");
const ENDPOINT = "https://mcp.acme.test/mcp";
const IDP = {
  client: OAuthClientSlug.make("enterprise-identity-provider"),
  clientOwner: "org",
} as const;

const client = (overrides: Partial<OAuthClientSummary> = {}): OAuthClientSummary => ({
  owner: "org",
  slug: OAuthClientSlug.make("acme-enterprise"),
  grant: "id_jag",
  authorizationUrl: "https://mcp.acme.test/authorize",
  tokenUrl: "https://mcp.acme.test/token",
  resource: ENDPOINT,
  clientId: "client-id",
  origin: { kind: "manual" },
  ...overrides,
});

const oauthMethod = (oauth: AuthMethod["oauth"]): AuthMethod => ({
  id: "oauth2",
  label: "OAuth",
  kind: "oauth",
  source: "spec",
  template: AuthTemplateSlug.make("oauth2"),
  placements: [],
  oauth,
});

const managedMethod = oauthMethod({
  discoveryUrl: ENDPOINT,
  supportsDynamicRegistration: true,
  enterpriseIdentityProvider: IDP,
});

describe("selectEnterpriseClient", () => {
  it("matches the app registered against this server's resource", () => {
    expect(
      selectEnterpriseClient([client()], {
        integration: INTEGRATION,
        resource: ENDPOINT,
      })?.slug,
    ).toBe(client().slug);
  });

  it("matches an app registered from this integration's own dialog", () => {
    // Recorded intent outranks everything: the administrator built it here.
    const intent = client({
      slug: OAuthClientSlug.make("by-intent"),
      resource: null,
      authorizationUrl: "https://elsewhere.test/authorize",
      tokenUrl: "https://elsewhere.test/token",
      origin: { kind: "manual", integration: INTEGRATION },
    });
    expect(
      selectEnterpriseClient([client(), intent], {
        integration: INTEGRATION,
        resource: ENDPOINT,
      })?.slug,
    ).toBe(intent.slug);
  });

  it("ignores every grant but id_jag", () => {
    // An ordinary interactive app on the same server is not an enterprise
    // registration, and presenting an assertion through it would fail.
    expect(
      selectEnterpriseClient([client({ grant: "authorization_code" })], {
        integration: INTEGRATION,
        resource: ENDPOINT,
      }),
    ).toBeNull();
  });

  it("refuses an id_jag app registered for a DIFFERENT server", () => {
    // Not a degraded match: an ID-JAG is audienced to one resource authorization
    // server, so the wrong app is the wrong server.
    expect(
      selectEnterpriseClient(
        [
          client({
            resource: "https://other.test/mcp",
            authorizationUrl: "https://other.test/authorize",
            tokenUrl: "https://other.test/token",
          }),
        ],
        { integration: INTEGRATION, resource: ENDPOINT },
      ),
    ).toBeNull();
  });

  it("prefers the organization's app when two match equally", () => {
    const personal = client({
      owner: "user",
      slug: OAuthClientSlug.make("aaa-personal"),
    });
    expect(
      selectEnterpriseClient([personal, client()], {
        integration: INTEGRATION,
        resource: ENDPOINT,
      })?.owner,
    ).toBe("org");
  });
});

describe("enterpriseConnectPlan", () => {
  it("leaves an undeclared server on today's routes", () => {
    expect(
      enterpriseConnectPlan({
        method: oauthMethod({
          discoveryUrl: ENDPOINT,
          supportsDynamicRegistration: true,
        }),
        integration: INTEGRATION,
        clients: [client()],
      }),
    ).toEqual({ kind: "unmanaged" });
  });

  it("takes the enterprise route when declared AND registered", () => {
    const plan = enterpriseConnectPlan({
      method: managedMethod,
      integration: INTEGRATION,
      clients: [client()],
    });
    expect(plan.kind).toBe("enterprise");
    // The pointer travels verbatim: `oauth.start` has to name THIS registration.
    expect(plan.kind === "enterprise" ? plan.identityProvider : null).toEqual(IDP);
  });

  it("reports the gap rather than silently taking DCR when no id_jag app exists", () => {
    // The bug this module exists to prevent: a declared-managed server whose
    // enterprise app was never registered used to register a fresh
    // authorization_code client and ask the member for per-server consent, with
    // nothing on screen saying the declaration had been bypassed.
    expect(
      enterpriseConnectPlan({
        method: managedMethod,
        integration: INTEGRATION,
        clients: [],
      }),
    ).toEqual({ kind: "unregistered", identityProvider: IDP });
  });

  it("does not treat a registered id_jag app as a declaration on its own", () => {
    // Registering the app is an administrator preparing the server; declaring it
    // managed is the decision that members stop consenting. Only the second one
    // may change what a member is offered.
    expect(
      enterpriseConnectPlan({
        method: oauthMethod({ discoveryUrl: ENDPOINT }),
        integration: INTEGRATION,
        clients: [client()],
      }).kind,
    ).toBe("unmanaged");
  });

  it("leaves a credential method alone", () => {
    expect(
      enterpriseConnectPlan({
        method: {
          id: "apikey",
          label: "API key",
          kind: "apikey",
          source: "spec",
          template: AuthTemplateSlug.make("apikey"),
          placements: [],
        },
        integration: INTEGRATION,
        clients: [client()],
      }).kind,
    ).toBe("unmanaged");
  });
});
