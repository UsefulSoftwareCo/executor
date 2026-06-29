import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { OAuthClientSlug } from "./ids";
import { makeTestWorkspaceHarness, memoryCredentialsPlugin } from "./test-config";

// removeClient permanently deletes an owner-scoped oauth_client row, keyed by
// (owner, slug). The owner policy on `oauth_client` prevents removing another
// subject's user app. The op is idempotent and never cascades into connections.

const plugins = [memoryCredentialsPlugin()] as const;

const ORG_CLIENT = OAuthClientSlug.make("acme-org");
const USER_CLIENT = OAuthClientSlug.make("acme-user");

describe("oauth.removeClient", () => {
  it.effect("removes a client so it no longer lists", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });

        yield* executor.oauth.createClient({
          owner: "user",
          slug: USER_CLIENT,
          authorizationUrl: "https://acme.test/authorize",
          tokenUrl: "https://acme.test/token",
          grant: "authorization_code",
          clientId: "user-client-id",
          clientSecret: "user-secret",
        });

        const before = yield* executor.oauth.listClients();
        expect(before.map((client) => String(client.slug))).toContain(String(USER_CLIENT));

        yield* executor.oauth.removeClient("user", USER_CLIENT);

        const after = yield* executor.oauth.listClients();
        expect(after.map((client) => String(client.slug))).not.toContain(String(USER_CLIENT));
      }),
    ),
  );

  it.effect("is idempotent — removing a non-existent client succeeds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });

        // No client was ever created; removing it must not error.
        yield* executor.oauth.removeClient("user", OAuthClientSlug.make("never-existed"));

        const clients = yield* executor.oauth.listClients();
        expect(clients).toEqual([]);
      }),
    ),
  );

  it.effect("removing an org client leaves a user client intact (and vice versa)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });

        yield* executor.oauth.createClient({
          owner: "org",
          slug: ORG_CLIENT,
          authorizationUrl: "https://acme.test/authorize",
          tokenUrl: "https://acme.test/token",
          grant: "authorization_code",
          clientId: "org-client-id",
          clientSecret: "org-secret",
        });
        yield* executor.oauth.createClient({
          owner: "user",
          slug: USER_CLIENT,
          authorizationUrl: "https://byo.test/authorize",
          tokenUrl: "https://byo.test/token",
          grant: "client_credentials",
          clientId: "user-client-id",
          clientSecret: "user-secret",
        });

        // Removing the org client leaves the user client untouched.
        yield* executor.oauth.removeClient("org", ORG_CLIENT);
        const afterOrg = yield* executor.oauth.listClients();
        expect(afterOrg.map((client) => String(client.slug)).sort()).toEqual([String(USER_CLIENT)]);

        // Removing the remaining user client empties the list.
        yield* executor.oauth.removeClient("user", USER_CLIENT);
        const afterUser = yield* executor.oauth.listClients();
        expect(afterUser).toEqual([]);
      }),
    ),
  );

  it.effect("one subject cannot remove another subject's user client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Two executors bind to different subjects in the same tenant against a
        // shared on-disk database, so each owns its own `owner:"user"` rows.
        const dataDir = mkdtempSync(join(tmpdir(), "oauth-remove-client-"));
        const tenant = "shared-tenant";

        const a = yield* makeTestWorkspaceHarness({
          plugins,
          tenant,
          subject: "subject-a",
          dataDir,
        });
        yield* a.executor.oauth.createClient({
          owner: "user",
          slug: OAuthClientSlug.make("a-only"),
          authorizationUrl: "https://a.test/authorize",
          tokenUrl: "https://a.test/token",
          grant: "authorization_code",
          clientId: "a-client-id",
          clientSecret: "a-secret",
        });

        const b = yield* makeTestWorkspaceHarness({
          plugins,
          tenant,
          subject: "subject-b",
          dataDir,
        });

        // B attempts to remove A's user client. The owner policy scopes the
        // delete to B's own subject rows, so A's client is untouched. The op
        // succeeds (idempotent no-op) but must not delete across subjects.
        yield* b.executor.oauth.removeClient("user", OAuthClientSlug.make("a-only"));

        const clientsA = yield* a.executor.oauth.listClients();
        expect(clientsA.map((client) => String(client.slug))).toContain("a-only");
      }),
    ),
  );

  it.effect("removing an org client removes it for all subjects in the tenant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dataDir = mkdtempSync(join(tmpdir(), "oauth-remove-client-org-"));
        const tenant = "shared-tenant";

        const a = yield* makeTestWorkspaceHarness({
          plugins,
          tenant,
          subject: "subject-a",
          dataDir,
        });
        yield* a.executor.oauth.createClient({
          owner: "org",
          slug: OAuthClientSlug.make("shared-org"),
          authorizationUrl: "https://shared.test/authorize",
          tokenUrl: "https://shared.test/token",
          grant: "authorization_code",
          clientId: "shared-client-id",
          clientSecret: "shared-secret",
        });

        const b = yield* makeTestWorkspaceHarness({
          plugins,
          tenant,
          subject: "subject-b",
          dataDir,
        });

        // B (a different subject in the same tenant) removes the shared org app.
        yield* b.executor.oauth.removeClient("org", OAuthClientSlug.make("shared-org"));

        // It is gone for A too — org rows are tenant-shared.
        const clientsA = yield* a.executor.oauth.listClients();
        expect(clientsA.map((client) => String(client.slug))).not.toContain("shared-org");
      }),
    ),
  );
});
