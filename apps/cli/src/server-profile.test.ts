import { afterEach, describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";

import {
  cliServerConnectionProfileRows,
  clearCliServerConnectionProfileAuth,
  defaultCliServerConnectionProfile,
  parseCliServerConnectionStore,
  readCliServerConnectionStore,
  removeCliServerConnectionProfile,
  setDefaultCliServerConnectionProfile,
  upsertCliServerConnectionProfile,
  upsertCliServerLoginProfile,
  updateCliServerConnectionProfileAfterOAuthRefresh,
} from "./server-profile";
import { readCliServerAuth } from "./server-connection";

const previousDataDir = process.env.EXECUTOR_DATA_DIR;

afterEach(() => {
  if (previousDataDir === undefined) {
    delete process.env.EXECUTOR_DATA_DIR;
  } else {
    process.env.EXECUTOR_DATA_DIR = previousDataDir;
  }
});

const accessToken = (claims: Record<string, unknown>) =>
  `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

const oauthConnection = (token: string) => ({
  origin: "https://executor.example",
  auth: {
    kind: "oauth" as const,
    accessToken: token,
    refreshToken: `refresh-${token}`,
  },
});

describe("CLI server connection profiles", () => {
  it("round-trips named server connections and default selection", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(join(tmpdir(), "executor-server-profiles-"));
      process.env.EXECUTOR_DATA_DIR = dataDir;

      try {
        yield* upsertCliServerConnectionProfile({
          name: "remote",
          connection: {
            origin: "https://executor.example/api",
            auth: { kind: "bearer", token: "key_123" },
          },
          makeDefault: true,
        });

        const store = yield* readCliServerConnectionStore();
        expect(store.defaultProfile).toBe("remote");
        expect(store.profiles).toHaveLength(1);
        expect(store.profiles[0]?.connection.kind).toBe("http");
        expect(store.profiles[0]?.connection.origin).toBe("https://executor.example");
        expect(store.profiles[0]?.connection.apiBaseUrl).toBe("https://executor.example/api");
        expect(store.profiles[0]?.connection.auth).toEqual({
          kind: "bearer",
          token: "key_123",
        });
        expect(defaultCliServerConnectionProfile(store)?.name).toBe("remote");
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(BunServices.layer)));

  it("switches and removes the default profile", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(join(tmpdir(), "executor-server-profiles-"));
      process.env.EXECUTOR_DATA_DIR = dataDir;

      try {
        yield* upsertCliServerConnectionProfile({
          name: "local",
          connection: { origin: "localhost:4788" },
          makeDefault: true,
        });
        yield* upsertCliServerConnectionProfile({
          name: "remote",
          connection: { origin: "https://executor.example" },
          makeDefault: false,
        });

        const switched = yield* setDefaultCliServerConnectionProfile("remote");
        expect(switched.defaultProfile).toBe("remote");

        const removed = yield* removeCliServerConnectionProfile("remote");
        expect(removed.defaultProfile).toBeNull();
        expect(removed.profiles.map((profile) => profile.name)).toEqual(["local"]);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(BunServices.layer)));

  it("serializes concurrent updates and keeps credential files owner-only", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(join(tmpdir(), "executor-server-profiles-"));
      process.env.EXECUTOR_DATA_DIR = dataDir;

      try {
        yield* Effect.all(
          Array.from({ length: 12 }, (_, index) =>
            upsertCliServerConnectionProfile({
              name: `remote-${index}`,
              connection: {
                origin: `https://executor-${index}.example`,
                auth: { kind: "bearer", token: `key-${index}` },
              },
              makeDefault: index === 0,
            }),
          ),
          { concurrency: "unbounded" },
        );

        const store = yield* readCliServerConnectionStore();
        expect(store.profiles.map((profile) => profile.name)).toEqual(
          Array.from({ length: 12 }, (_, index) => `remote-${index}`).sort(),
        );

        const storePath = join(dataDir, "server-connections.json");
        expect(statSync(storePath).mode & 0o777).toBe(0o600);
        expect(
          readdirSync(dataDir).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")),
        ).toEqual([]);

        chmodSync(storePath, 0o644);
        yield* readCliServerConnectionStore();
        expect(statSync(storePath).mode & 0o777).toBe(0o600);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(BunServices.layer)));

  it("serializes concurrent stale-lock reclaimers without deleting a fresh writer lock", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(join(tmpdir(), "executor-server-profiles-"));
      process.env.EXECUTOR_DATA_DIR = dataDir;

      try {
        const lockPath = join(dataDir, "server-connections.json.lock");
        writeFileSync(lockPath, `${JSON.stringify({ pid: 999_999_999, owner: "stale-owner" })}\n`, {
          mode: 0o600,
        });

        yield* Effect.all(
          Array.from({ length: 24 }, (_, index) =>
            upsertCliServerConnectionProfile({
              name: `contender-${index}`,
              connection: { origin: `https://contender-${index}.example` },
              makeDefault: false,
            }),
          ),
          { concurrency: "unbounded" },
        );

        const store = yield* readCliServerConnectionStore();
        expect(store.profiles).toHaveLength(24);
        expect(new Set(store.profiles.map((profile) => profile.name)).size).toBe(24);
        expect(
          readdirSync(dataDir).filter((name) => name.startsWith("server-connections.json.lock")),
        ).toEqual([]);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(BunServices.layer)));

  it("treats a displaced live owner's tombstone as an advisory lock", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(join(tmpdir(), "executor-server-profiles-"));
      process.env.EXECUTOR_DATA_DIR = dataDir;

      try {
        const tombstonePath = join(dataDir, "server-connections.json.lock.tombstone-live-owner");
        writeFileSync(
          tombstonePath,
          `${JSON.stringify({ pid: process.pid, owner: "other-live-owner" })}\n`,
          { mode: 0o600 },
        );

        const outcome = yield* Effect.race(
          upsertCliServerConnectionProfile({
            name: "blocked",
            connection: { origin: "https://blocked.example" },
            makeDefault: true,
          }).pipe(Effect.as("acquired" as const)),
          Effect.sleep("75 millis").pipe(Effect.as("blocked" as const)),
        );
        expect(outcome).toBe("blocked");

        rmSync(tombstonePath, { force: true });
        yield* upsertCliServerConnectionProfile({
          name: "unblocked",
          connection: { origin: "https://unblocked.example" },
          makeDefault: true,
        });
        const store = yield* readCliServerConnectionStore();
        expect(store.profiles.map((profile) => profile.name)).toEqual(["unblocked"]);
        expect(
          readdirSync(dataDir).filter((name) => name.startsWith("server-connections.json.lock")),
        ).toEqual([]);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(BunServices.layer)));

  it("keeps same-origin accounts distinct and reuses a logged-out account profile", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(join(tmpdir(), "executor-server-profiles-"));
      process.env.EXECUTOR_DATA_DIR = dataDir;

      try {
        const first = yield* upsertCliServerLoginProfile({
          suggestedName: "account",
          account: {
            subject: "shared-user",
            organizationId: "org-a",
            email: "shared@example.com",
          },
          connection: oauthConnection(accessToken({ sub: "shared-user", org_id: "org-a" })),
        });
        const second = yield* upsertCliServerLoginProfile({
          suggestedName: "account",
          account: {
            subject: "shared-user",
            organizationId: "org-b",
            email: "shared@example.com",
          },
          connection: oauthConnection(accessToken({ sub: "shared-user", org_id: "org-b" })),
        });

        expect(first.profile.name).toBe("account");
        expect(second.profile.name).toBe("account-2");

        const loggedOut = yield* clearCliServerConnectionProfileAuth(second.profile.name);
        const loggedOutProfile = loggedOut.profiles.find(
          (profile) => profile.name === second.profile.name,
        );
        expect(loggedOutProfile?.connection.auth).toBeUndefined();
        expect(loggedOutProfile?.account).toEqual({
          subject: "shared-user",
          organizationId: "org-b",
          email: "shared@example.com",
        });

        const signedOutRows = cliServerConnectionProfileRows(loggedOut, undefined);
        expect(
          signedOutRows.map(({ account, organization, auth }) => ({
            account,
            organization,
            auth,
          })),
        ).toEqual([
          { account: "shared@example.com", organization: "org-a", auth: "stored-auth" },
          { account: "shared@example.com", organization: "org-b", auth: "signed-out" },
        ]);
        const environmentRows = cliServerConnectionProfileRows(
          loggedOut,
          readCliServerAuth({ EXECUTOR_AUTH_TOKEN: "environment-token" }),
        );
        expect(environmentRows.map((row) => row.auth)).toEqual(["stored-auth", "env-auth"]);

        const relogged = yield* upsertCliServerLoginProfile({
          suggestedName: "account",
          account: {
            subject: "shared-user",
            organizationId: "org-b",
            email: "shared@example.com",
          },
          connection: oauthConnection(accessToken({ sub: "shared-user", org_id: "org-b" })),
        });
        expect(relogged.profile.name).toBe("account-2");
        expect(relogged.store.profiles).toHaveLength(2);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(BunServices.layer)));

  it("migrates a legacy oauth profile by matching its token identity", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(join(tmpdir(), "executor-server-profiles-"));
      process.env.EXECUTOR_DATA_DIR = dataDir;

      try {
        writeFileSync(
          join(dataDir, "server-connections.json"),
          JSON.stringify({
            version: 1,
            defaultProfile: "legacy",
            profiles: [
              {
                name: "legacy",
                connection: oauthConnection(
                  accessToken({ sub: "legacy-user", org_id: "legacy-org" }),
                ),
              },
            ],
          }),
          { mode: 0o600 },
        );

        const legacy = yield* readCliServerConnectionStore();
        expect(cliServerConnectionProfileRows(legacy, undefined)[0]).toMatchObject({
          account: "legacy-user",
          organization: "legacy-org",
          auth: "stored-auth",
        });
        const loggedOut = yield* clearCliServerConnectionProfileAuth("legacy");
        expect(loggedOut.profiles[0]?.account).toEqual({
          subject: "legacy-user",
          organizationId: "legacy-org",
        });

        const migrated = yield* upsertCliServerLoginProfile({
          suggestedName: "new-name",
          account: {
            subject: "legacy-user",
            organizationId: "legacy-org",
            email: "legacy@example.com",
          },
          connection: oauthConnection(accessToken({ sub: "legacy-user", org_id: "legacy-org" })),
        });
        expect(migrated.profile.name).toBe("legacy");
        expect(migrated.store.profiles).toHaveLength(1);
        expect(migrated.profile.account).toEqual({
          subject: "legacy-user",
          organizationId: "legacy-org",
          email: "legacy@example.com",
        });
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(BunServices.layer)));

  it("does not let a stale refresh restore credentials after logout", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(join(tmpdir(), "executor-server-profiles-"));
      process.env.EXECUTOR_DATA_DIR = dataDir;

      try {
        const originalToken = accessToken({ sub: "user-a", org_id: "org-a" });
        const saved = yield* upsertCliServerLoginProfile({
          suggestedName: "account",
          account: { subject: "user-a", organizationId: "org-a" },
          connection: oauthConnection(originalToken),
        });

        yield* clearCliServerConnectionProfileAuth(saved.profile.name);
        const updated = yield* updateCliServerConnectionProfileAfterOAuthRefresh({
          name: saved.profile.name,
          previousAccessToken: originalToken,
          connection: oauthConnection(accessToken({ sub: "user-a", org_id: "org-a", v: 2 })),
        });
        expect(updated).toBe(false);

        const store = yield* readCliServerConnectionStore();
        expect(store.profiles[0]?.connection.auth).toBeUndefined();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(BunServices.layer)));

  it("drops malformed profiles when parsing", () => {
    const store = parseCliServerConnectionStore(
      JSON.stringify({
        version: 1,
        defaultProfile: "missing",
        profiles: [
          { name: "valid", connection: { origin: "https://executor.example" } },
          { name: "bad space", connection: { origin: "https://ignored.example" } },
          { name: "no-origin", connection: {} },
        ],
      }),
    );

    expect(store.defaultProfile).toBeNull();
    expect(store.profiles.map((profile) => profile.name)).toEqual(["valid"]);
  });

  it("preserves desktop sidecar profile kind", () => {
    const store = parseCliServerConnectionStore(
      JSON.stringify({
        version: 1,
        defaultProfile: "desktop",
        profiles: [
          {
            name: "desktop",
            connection: {
              kind: "desktop-sidecar",
              key: "desktop-sidecar",
              origin: "http://127.0.0.1:4789",
              auth: { kind: "basic", username: "executor", password: "secret" },
            },
          },
        ],
      }),
    );

    expect(store.defaultProfile).toBe("desktop");
    expect(store.profiles[0]?.connection.kind).toBe("desktop-sidecar");
    expect(store.profiles[0]?.connection.auth).toEqual({
      kind: "basic",
      username: "executor",
      password: "secret",
    });
  });
});
