import { describe, expect, it } from "@effect/vitest";
import {
  ConnectionAddress,
  ConnectionName,
  AuthTemplateSlug,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderKey,
  type Connection,
  type OAuthClientSummary,
  type Owner,
} from "@executor-js/sdk/shared";

import { buildUsageMap, connectionsUsingClient, groupClientsByOwner } from "./oauth-apps";

// Minimal app summary builder — only the fields the helpers read matter.
const app = (slug: string, opts?: { readonly owner?: Owner }): OAuthClientSummary => ({
  owner: opts?.owner ?? "org",
  slug: OAuthClientSlug.make(slug),
  grant: "authorization_code",
  authorizationUrl: "https://issuer.example.com/authorize",
  tokenUrl: "https://issuer.example.com/token",
  resource: null,
  clientId: "client-id",
  origin: { kind: "manual" },
});

// A connection optionally minted by an app (its `oauthClient` slug).
const connection = (
  integration: string,
  name: string,
  opts?: {
    readonly owner?: Owner;
    readonly oauthClient?: string | null;
    readonly oauthClientOwner?: Owner | null;
  },
): Connection => ({
  owner: opts?.owner ?? "user",
  name: ConnectionName.make(name),
  integration: IntegrationSlug.make(integration),
  template: AuthTemplateSlug.make("oauth"),
  provider: ProviderKey.make("default"),
  address: ConnectionAddress.make(`tools.${integration}.user.${name}`),
  identityLabel: null,
  expiresAt: null,
  oauthClient:
    opts?.oauthClient === undefined
      ? null
      : opts.oauthClient === null
        ? null
        : OAuthClientSlug.make(opts.oauthClient),
  oauthClientOwner: opts?.oauthClientOwner ?? null,
});

describe("groupClientsByOwner", () => {
  it("orders Workspace (org) before Personal (user) and drops empty groups", () => {
    const groups = groupClientsByOwner([
      app("personal-app", { owner: "user" }),
      app("workspace-app", { owner: "org" }),
    ]);
    expect(groups.map((g) => g.owner)).toEqual(["org", "user"]);
    expect(groups[0]!.clients.map((c: OAuthClientSummary) => String(c.slug))).toEqual([
      "workspace-app",
    ]);
    expect(groups[1]!.clients.map((c: OAuthClientSummary) => String(c.slug))).toEqual([
      "personal-app",
    ]);
  });

  it("omits an owner group entirely when it has no apps", () => {
    const groups = groupClientsByOwner([app("only-personal", { owner: "user" })]);
    expect(groups.map((g) => g.owner)).toEqual(["user"]);
  });

  it("returns no groups for an empty list", () => {
    expect(groupClientsByOwner([])).toEqual([]);
  });

  it("preserves original order within a group", () => {
    const groups = groupClientsByOwner([app("b", { owner: "org" }), app("a", { owner: "org" })]);
    expect(groups[0]!.clients.map((c: OAuthClientSummary) => String(c.slug))).toEqual(["b", "a"]);
  });
});

describe("buildUsageMap / connectionsUsingClient", () => {
  it("maps connections to the app slug that minted them", () => {
    const usage = buildUsageMap([
      connection("github", "personal", { oauthClient: "gh-app", oauthClientOwner: "org" }),
      connection("github", "bot", { oauthClient: "gh-app", oauthClientOwner: "org" }),
      connection("linear", "main", { oauthClient: "linear-app", oauthClientOwner: "org" }),
    ]);
    expect(
      connectionsUsingClient(usage, app("gh-app", { owner: "org" })).map((c: Connection) =>
        String(c.name),
      ),
    ).toEqual(["personal", "bot"]);
    expect(
      connectionsUsingClient(usage, app("linear-app", { owner: "org" })).map((c: Connection) =>
        String(c.name),
      ),
    ).toEqual(["main"]);
  });

  it("keys usage by app owner as well as slug", () => {
    const usage = buildUsageMap([
      connection("github", "workspace", { oauthClient: "github", oauthClientOwner: "org" }),
      connection("github", "personal", { oauthClient: "github", oauthClientOwner: "user" }),
    ]);
    expect(
      connectionsUsingClient(usage, app("github", { owner: "org" })).map((c: Connection) =>
        String(c.name),
      ),
    ).toEqual(["workspace"]);
    expect(
      connectionsUsingClient(usage, app("github", { owner: "user" })).map((c: Connection) =>
        String(c.name),
      ),
    ).toEqual(["personal"]);
  });

  it("skips static connections with a null oauthClient", () => {
    const usage = buildUsageMap([
      connection("vercel", "static", { oauthClient: null }),
      connection("github", "oauth", { oauthClient: "gh-app", oauthClientOwner: "org" }),
    ]);
    expect(usage.size).toBe(1);
    // Only the OAuth-minted connection is tracked; the static one is absent.
    expect(connectionsUsingClient(usage, app("gh-app", { owner: "org" }))).toHaveLength(1);
  });

  it("returns an empty array for an app that backs no connections", () => {
    const usage = buildUsageMap([
      connection("github", "oauth", { oauthClient: "gh-app", oauthClientOwner: "org" }),
    ]);
    expect(connectionsUsingClient(usage, app("unused-app", { owner: "org" }))).toEqual([]);
  });

  it("returns an empty map when there are no connections", () => {
    const usage = buildUsageMap([]);
    expect(usage.size).toBe(0);
    expect(connectionsUsingClient(usage, app("any", { owner: "org" }))).toEqual([]);
  });
});
