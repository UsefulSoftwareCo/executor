import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "@effect/vitest";

import { cloudFirstPartyOAuthClients } from "./execution-stack";

// The reviewed consumer scope boundary of the Executor-owned Google app.
//
// These assertions used to live in `e2e/scenarios/first-party-oauth.test.ts`,
// read off `listClients`. The app is now `unlisted`, so it has no read surface
// to introspect — the bundle is only observable on the config it is built from,
// which is here. The e2e still owns the BEHAVIOUR the boundary produces (which
// scopes an `oauth.start` requests, and that admin scopes are refused).
const GOOGLE_SCOPE = (suffix: string) => `https://www.googleapis.com/auth/${suffix}`;

describe("cloud first-party oauth clients", () => {
  beforeAll(() => {
    env.FIRST_PARTY_GOOGLE_CLIENT_ID = "test-google-client";
    env.FIRST_PARTY_GOOGLE_CLIENT_SECRET = "test-google-secret";
  });

  const google = () => cloudFirstPartyOAuthClients().find((client) => client.name === "google");

  it("declares the Google app but withholds it from every listing", () => {
    const client = google();
    expect(client, "the env-declared first-party Google app is configured").toBeDefined();
    // The entry MUST stay declared: `loadClient` resolves it by slug for every
    // existing connection's refresh and reconnect. `unlisted` is what stops it
    // being offered for new connections.
    expect(client?.unlisted).toBe(true);
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
