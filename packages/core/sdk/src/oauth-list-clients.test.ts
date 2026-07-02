import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";

import { OAuthClientSlug } from "./ids";
import { makeTestWorkspaceHarness, memoryCredentialsPlugin } from "./test-config";

// listClients returns metadata-only summaries of the clients visible to the
// caller — the tenant's org clients plus the caller's own user clients — and
// NEVER the client secret. Cross-subject user clients stay hidden.

const plugins = [memoryCredentialsPlugin()] as const;

const ORG_CLIENT = OAuthClientSlug.make("acme-org");
const USER_CLIENT = OAuthClientSlug.make("acme-user");

describe("oauth.listClients", () => {
  it.effect("rejects metadata URLs persisted as authorization URLs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });

        const error = yield* Effect.flip(
          executor.oauth.createClient({
            owner: "org",
            slug: ORG_CLIENT,
            authorizationUrl: "https://mcp.example.com/.well-known/oauth-authorization-server",
            tokenUrl: "https://mcp.example.com/token",
            grant: "authorization_code",
            clientId: "client-id",
            clientSecret: "client-secret",
          }),
        );

        expect(Predicate.isTagged("StorageError")(error)).toBe(true);
        expect(error).toEqual(
          expect.objectContaining({
            _tag: "StorageError",
            message: expect.stringContaining("authorization endpoint"),
          }),
        );
        expect(yield* executor.oauth.listClients()).toEqual([]);
      }),
    ),
  );

  it.effect("returns owner-visible clients as summaries without the secret", () =>
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
          clientSecret: "org-super-secret",
        });
        yield* executor.oauth.createClient({
          owner: "user",
          slug: USER_CLIENT,
          authorizationUrl: "https://byo.test/authorize",
          tokenUrl: "https://byo.test/token",
          grant: "client_credentials",
          clientId: "user-client-id",
          clientSecret: "user-super-secret",
        });

        const clients = yield* executor.oauth.listClients();

        // Both the org-shared client and the caller's own user client are
        // visible.
        const bySlug = new Map(clients.map((client) => [String(client.slug), client]));
        expect(bySlug.size).toBe(2);

        const org = bySlug.get(String(ORG_CLIENT));
        const user = bySlug.get(String(USER_CLIENT));
        expect(org).toBeDefined();
        expect(user).toBeDefined();

        expect(org).toEqual({
          owner: "org",
          slug: ORG_CLIENT,
          grant: "authorization_code",
          authorizationUrl: "https://acme.test/authorize",
          tokenUrl: "https://acme.test/token",
          resource: null,
          clientId: "org-client-id",
          origin: { kind: "manual" },
        });
        expect(user!.owner).toBe("user");
        expect(user!.grant).toBe("client_credentials");
        expect(user!.clientId).toBe("user-client-id");

        // The secret is NEVER projected onto a summary.
        for (const client of clients) {
          expect(Object.keys(client)).not.toContain("clientSecret");
          expect(JSON.stringify(client)).not.toContain("secret");
        }
      }),
    ),
  );

  it.effect("hides another user's clients from the caller", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Two executors bind to different subjects in the same tenant against a
        // shared on-disk database, so each owns its own `owner:"user"` rows.
        const dataDir = mkdtempSync(join(tmpdir(), "oauth-list-clients-"));
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

        // B binds to subject-b, so it sees the shared org client but NOT
        // subject-a's user client.
        const clientsB = yield* b.executor.oauth.listClients();
        const slugsB = clientsB.map((client) => String(client.slug)).sort();
        expect(slugsB).toEqual(["shared-org"]);
      }),
    ),
  );

  it.effect("classifies legacy MCP DCR-looking clients as dynamic registration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { config, executor } = yield* makeTestWorkspaceHarness({ plugins });

        yield* executor.oauth.createClient({
          owner: "org",
          slug: OAuthClientSlug.make("axiom-mcp"),
          authorizationUrl: "https://mcp.axiom.co/authorize",
          tokenUrl: "https://mcp.axiom.co/token",
          grant: "authorization_code",
          clientId: "old-dcr-client",
          clientSecret: "",
          resource: "https://mcp.axiom.co/mcp",
          origin: { kind: "manual" },
        });
        yield* Effect.promise(() =>
          config.db.updateMany("oauth_client", {
            where: (b) => b("slug", "=", "axiom-mcp"),
            set: { origin_kind: null, origin_integration: null },
          }),
        );

        const clients = yield* executor.oauth.listClients();
        expect(clients[0]?.origin).toEqual({
          kind: "dynamic_client_registration",
          integration: null,
        });
      }),
    ),
  );
});
