// Cloud-only: the neutral /api/account surface — the exact contract the shared
// React shell + api-keys page consume. Happy paths go through the typed
// AccountHttpApi client (the same contract the UI's AccountApiClient uses);
// refusal edges and the bearer cross-check use raw fetch with the identity's
// real sealed-session cookie (the org-limit cross-check pattern).
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { AccountHttpApi } from "@executor-js/api";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

scenario(
  "Account · /account/me reflects the signed-in user and their organization",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: apiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiClient(AccountHttpApi, identity);

    const me = yield* client.account.me();
    expect(me.user.email, "the session's own user is reported").toBe(identity.label);
    expect(me.user.id, "the user has a stable id").toMatch(/^user_/);
    // newIdentity() created this identity's org as "Org <local-part>".
    const orgName = `Org ${identity.label.split("@")[0]}`;
    expect(me.organization?.name, "the active organization is the identity's own").toBe(orgName);
  }),
);

scenario(
  "Account · an API key is minted once, authorizes the API as a bearer, and can be revoked",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: apiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiClient(AccountHttpApi, identity);

    // Create: the plaintext secret is returned exactly once, masked everywhere else.
    const created = yield* client.account.createApiKey({ payload: { name: "e2e key" } });
    expect(created.name, "the key carries the requested name").toBe("e2e key");
    expect(created.value, "create returns the one-time plaintext secret").not.toBe("");
    expect(created.obfuscatedValue, "the display value is masked, not the secret").not.toBe(
      created.value,
    );

    // The created secret is a working credential for the protected API.
    const bearer = yield* Effect.promise(() =>
      fetch(new URL("/api/integrations", target.baseUrl), {
        headers: { authorization: `Bearer ${created.value}` },
      }),
    );
    expect(bearer.status, "the bearer authenticates the protected API").toBe(200);
    const integrations = (yield* Effect.promise(() => bearer.json())) as ReadonlyArray<{
      slug: string;
    }>;
    expect(
      integrations.map((i) => i.slug),
      "the authorized call sees the workspace's integrations",
    ).toContain("executor");

    // List: the key shows up masked; the plaintext secret is never re-served.
    const listed = yield* client.account.listApiKeys();
    const mine = listed.apiKeys.find((key) => key.id === created.id);
    expect(mine?.name, "the created key appears in the list").toBe("e2e key");
    expect(JSON.stringify(listed), "the list never leaks the plaintext secret").not.toContain(
      created.value,
    );

    // Revoke: the key disappears from the account.
    const revoked = yield* client.account.revokeApiKey({ params: { apiKeyId: created.id } });
    expect(revoked.success, "revoke reports success").toBe(true);
    const after = yield* client.account.listApiKeys();
    expect(
      after.apiKeys.map((key) => key.id),
      "the revoked key is gone from the list",
    ).not.toContain(created.id);
  }),
);

scenario(
  "Account · the account surface refuses anonymous and organization-less callers",
  {},
  Effect.gen(function* () {
    const target = yield* Target;

    // Anonymous: no session cookie at all → 401.
    const anonymous = yield* Effect.promise(() =>
      fetch(new URL("/api/account/me", target.baseUrl)),
    );
    expect(anonymous.status, "no session → unauthorized").toBe(401);

    // A real session that has not joined an organization yet: identity is
    // visible (drives onboarding), but org-scoped resources are forbidden.
    const orgless = yield* target.newIdentity({ org: false });
    const me = yield* Effect.promise(() =>
      fetch(new URL("/api/account/me", target.baseUrl), { headers: orgless.headers ?? {} }),
    );
    expect(me.status, "an org-less session can still see itself").toBe(200);
    const body = (yield* Effect.promise(() => me.json())) as {
      user: { email: string };
      organization: unknown;
    };
    expect(body.user.email, "it is the signed-in user").toBe(orgless.label);
    expect(body.organization, "no organization is active yet").toBeNull();

    const keys = yield* Effect.promise(() =>
      fetch(new URL("/api/account/api-keys", target.baseUrl), {
        headers: orgless.headers ?? {},
      }),
    );
    expect(keys.status, "org-scoped API keys are forbidden without an organization").toBe(403);
  }),
);
