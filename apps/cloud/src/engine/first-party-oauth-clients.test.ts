import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

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

// The reviewed consumer scope boundary of the Executor-owned Google app.
//
// These assertions used to live in `e2e/scenarios/first-party-oauth.test.ts`,
// read off `listClients`. The app is now gated, so it has no public read surface
// to introspect — the bundle is only observable on the config it is built from,
// which is here. The e2e still owns the BEHAVIOUR the boundary produces (which
// scopes an `oauth.start` requests, and that admin scopes are refused).
const GOOGLE_SCOPE = (suffix: string) => `https://www.googleapis.com/auth/${suffix}`;

describe("cloud first-party Google app", () => {
  const google = () =>
    firstPartyOAuthClientsFor(completeEnv).find((client) => client.name === "google");

  it("declares the Google app but withholds it without a configured rollout", async () => {
    const client = google();
    expect(client, "the env-declared first-party Google app is configured").toBeDefined();
    // The entry MUST stay declared: `loadClient` resolves it by slug for every
    // existing connection's refresh and reconnect. The listing policy stops it
    // being offered for new connections.
    expect(client?.isListed).toBeDefined();
    if (client?.isListed === undefined) return;
    expect(
      await Effect.runPromise(client.isListed({ userId: "test-user", organizationId: "test-org" })),
    ).toBe(false);
  });

  it("covers the reviewed consumer bundle", () => {
    const allowed = google()?.allowedScopes;
    expect(allowed).toBeDefined();
    for (const scope of [
      "calendar",
      "meetings.space.readonly",
      "spreadsheets",
      "drive.file",
      "drive",
      "documents",
      "presentations",
      "forms.body",
      "forms.responses.readonly",
      "tasks",
      "contacts",
      "contacts.other.readonly",
      "directory.readonly",
      "user.addresses.read",
      "user.birthday.read",
      "user.emails.read",
      "user.gender.read",
      "user.organization.read",
      "user.phonenumbers.read",
      "photoslibrary.appendonly",
      "photoslibrary.edit.appcreateddata",
      "photospicker.mediaitems.readonly",
      "webmasters",
      "gmail.settings.basic",
    ]) {
      expect(allowed).toContain(GOOGLE_SCOPE(scope));
    }
    // `gmail.modify` stays in the host-enforced allowlist on purpose: a
    // connection created before the full-Gmail review still declares it, and
    // `resolveFirstPartyScopes` filters discovered scopes through this list, so
    // dropping it would break those reconnects — as the legacy-spec case in the
    // e2e asserts. The invariant that new Gmail presets request
    // `mail.google.com` instead lives in the preset unit tests
    // (packages/plugins/openapi/.../presets.test.ts), which is where the
    // request-side scope choice is actually decided.
    expect(allowed).toContain("https://mail.google.com/");
    expect(allowed).toContain(GOOGLE_SCOPE("gmail.modify"));
  });

  it("excludes the scopes held back from consumer review", () => {
    const allowed = google()?.allowedScopes;
    expect(allowed).toBeDefined();
    for (const scope of [
      "gmail.settings.sharing",
      "admin.directory.user",
      "youtube",
      "cloud-platform",
    ]) {
      expect(allowed).not.toContain(GOOGLE_SCOPE(scope));
    }
  });
});
