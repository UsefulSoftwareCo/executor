import { describe, expect, it } from "@effect/vitest";

import {
  firstPartyOAuthClientsFor,
  type FirstPartyOAuthClientEnv,
} from "./first-party-oauth-clients";

const completeEnv: FirstPartyOAuthClientEnv = {
  FIRST_PARTY_AIRTABLE_CLIENT_ID: "airtable-id",
  FIRST_PARTY_AIRTABLE_CLIENT_SECRET: "airtable-secret",
  FIRST_PARTY_ATLASSIAN_CLIENT_ID: "atlassian-id",
  FIRST_PARTY_ATLASSIAN_CLIENT_SECRET: "atlassian-secret",
  FIRST_PARTY_BOX_CLIENT_ID: "box-id",
  FIRST_PARTY_BOX_CLIENT_SECRET: "box-secret",
  FIRST_PARTY_CLICKUP_CLIENT_ID: "clickup-id",
  FIRST_PARTY_CLICKUP_CLIENT_SECRET: "clickup-secret",
  FIRST_PARTY_FIGMA_CLIENT_ID: "figma-id",
  FIRST_PARTY_FIGMA_CLIENT_SECRET: "figma-secret",
  FIRST_PARTY_GITHUB_CLIENT_ID: "github-id",
  FIRST_PARTY_GITHUB_CLIENT_SECRET: "github-secret",
  FIRST_PARTY_GITLAB_CLIENT_ID: "gitlab-id",
  FIRST_PARTY_GITLAB_CLIENT_SECRET: "gitlab-secret",
  FIRST_PARTY_GOOGLE_CLIENT_ID: "google-id",
  FIRST_PARTY_GOOGLE_CLIENT_SECRET: "google-secret",
  FIRST_PARTY_HUBSPOT_CLIENT_ID: "hubspot-id",
  FIRST_PARTY_HUBSPOT_CLIENT_SECRET: "hubspot-secret",
  FIRST_PARTY_LINEAR_CLIENT_ID: "linear-id",
  FIRST_PARTY_LINEAR_CLIENT_SECRET: "linear-secret",
  FIRST_PARTY_MICROSOFT_CLIENT_ID: "microsoft-id",
  FIRST_PARTY_MICROSOFT_CLIENT_SECRET: "microsoft-secret",
  FIRST_PARTY_NOTION_CLIENT_ID: "notion-id",
  FIRST_PARTY_NOTION_CLIENT_SECRET: "notion-secret",
  FIRST_PARTY_SLACK_CLIENT_ID: "slack-id",
  FIRST_PARTY_SLACK_CLIENT_SECRET: "slack-secret",
};

describe("cloud first-party OAuth clients", () => {
  it("enables every registered OAuth 2 provider from complete secret pairs", () => {
    const clients = firstPartyOAuthClientsFor(completeEnv);

    expect(clients.map((client) => client.name)).toEqual([
      "airtable",
      "atlassian",
      "box",
      "clickup",
      "figma",
      "github",
      "gitlab",
      "google",
      "hubspot",
      "linear",
      "microsoft",
      "notion",
      "slack",
    ]);
  });

  it("fails closed when either half of a provider secret pair is absent", () => {
    expect(firstPartyOAuthClientsFor({ FIRST_PARTY_AIRTABLE_CLIENT_ID: "id" })).toEqual([]);
    expect(firstPartyOAuthClientsFor({ FIRST_PARTY_AIRTABLE_CLIENT_SECRET: "secret" })).toEqual([]);
  });

  it("carries provider-specific authorization and token contracts", () => {
    const byName = new Map(
      firstPartyOAuthClientsFor(completeEnv).map((client) => [client.name, client]),
    );

    expect(byName.get("airtable")).toMatchObject({
      tokenEndpointAuthMethod: "basic",
    });
    expect(byName.get("atlassian")).toMatchObject({
      tokenRequestFormat: "json",
      authorizationExtraParams: { audience: "api.atlassian.com", prompt: "consent" },
    });
    expect(byName.get("figma")).toMatchObject({
      tokenEndpointAuthMethod: "basic",
      allowedScopes: expect.arrayContaining(["folder_metadata:read", "folders:read"]),
    });
    expect(byName.get("hubspot")).toMatchObject({
      tokenUrl: "https://api.hubapi.com/oauth/v3/token",
      authorizationExtraParams: {
        optional_scope: "content crm.objects.custom.read crm.schemas.custom.read",
      },
    });
    expect(byName.get("linear")).toMatchObject({ authorizationScopeSeparator: "," });
    expect(byName.get("microsoft")).toMatchObject({
      additionalAuthorizationScopes: ["offline_access"],
      allowedScopes: expect.arrayContaining(["Mail.ReadWrite", "Files.ReadWrite.All"]),
    });
    expect(byName.get("notion")).toMatchObject({
      authorizationScopes: [],
      authorizationExtraParams: { owner: "user" },
      tokenEndpointAuthMethod: "basic",
      tokenRequestFormat: "json",
    });
  });
});
