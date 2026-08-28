import { afterEach, describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";

import {
  defaultCliServerConnectionProfile,
  parseCliServerConnectionStore,
  readCliServerConnectionStore,
  removeCliServerConnectionProfile,
  setDefaultCliServerConnectionProfile,
  upsertCliServerConnectionProfile,
} from "./server-profile";

const previousDataDir = process.env.EXECUTOR_DATA_DIR;

afterEach(() => {
  if (previousDataDir === undefined) {
    delete process.env.EXECUTOR_DATA_DIR;
  } else {
    process.env.EXECUTOR_DATA_DIR = previousDataDir;
  }
});

describe("CLI server connection profiles", () => {
  it.effect("round-trips named server connections and default selection", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(join(tmpdir(), "executor-server-profiles-"));
      process.env.EXECUTOR_DATA_DIR = dataDir;

      try {
        yield* upsertCliServerConnectionProfile({
          name: "remote",
          connection: {
            origin: "https://executor.example/api",
            auth: { kind: "bearer", token: "key_123" },
            headers: {
              "CF-Access-Client-Id": { kind: "env", name: "EXECUTOR_CF_ACCESS_CLIENT_ID" },
            },
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
        expect(store.profiles[0]?.connection.headers).toEqual({
          "CF-Access-Client-Id": { kind: "env", name: "EXECUTOR_CF_ACCESS_CLIENT_ID" },
        });
        expect(defaultCliServerConnectionProfile(store)?.name).toBe("remote");
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("switches and removes the default profile", () =>
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
    }).pipe(Effect.provide(BunServices.layer)),
  );

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
              headers: {
                "CF-Access-Client-Id": {
                  kind: "env",
                  name: "EXECUTOR_CF_ACCESS_CLIENT_ID",
                },
              },
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
    expect(store.profiles[0]?.connection.headers).toEqual({
      "CF-Access-Client-Id": { kind: "env", name: "EXECUTOR_CF_ACCESS_CLIENT_ID" },
    });
  });

  // -------------------------------------------------------------------------
  // File permissions.
  //
  // This store holds live credentials for a hosted server — a bearer token, or
  // an OAuth access token and its long-lived refresh token. Nothing pinned its
  // mode before, so it was created with the process umask (0644 by default) and
  // readable by every other account on the machine.
  //
  // Both cases are covered because they need different mechanisms: `mode` on
  // create, and a `chmod` for the overwrite. The overwrite is the common path
  // here, since the store is rewritten on every silent token refresh.
  // -------------------------------------------------------------------------

  it.effect("creates the credential store owner-only", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(join(tmpdir(), "executor-server-profiles-mode-"));
      process.env.EXECUTOR_DATA_DIR = dataDir;

      try {
        yield* upsertCliServerConnectionProfile({
          name: "remote",
          connection: {
            origin: "https://executor.example",
            auth: { kind: "bearer", token: "key_should_not_be_world_readable" },
          },
          makeDefault: true,
        });

        const mode = statSync(join(dataDir, "server-connections.json")).mode & 0o777;
        expect(mode).toBe(0o600);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("tightens a pre-existing world-readable credential store on rewrite", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(join(tmpdir(), "executor-server-profiles-chmod-"));
      process.env.EXECUTOR_DATA_DIR = dataDir;
      const storePath = join(dataDir, "server-connections.json");

      try {
        // A store left behind by an older version, world-readable. `mode` on
        // write is ignored for an existing file, so only the chmod fixes this.
        writeFileSync(storePath, JSON.stringify({ version: 1, profiles: [] }));
        chmodSync(storePath, 0o644);

        yield* upsertCliServerConnectionProfile({
          name: "remote",
          connection: {
            origin: "https://executor.example",
            auth: { kind: "bearer", token: "key_should_not_be_world_readable" },
          },
          makeDefault: true,
        });

        expect(statSync(storePath).mode & 0o777).toBe(0o600);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
