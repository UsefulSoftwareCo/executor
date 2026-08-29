// ---------------------------------------------------------------------------
// MCP connection-pool key
//
// The key decides which pooled session a call may reuse, and it is retained as
// a `Map` key for the POOL's lifetime — much longer than the call that produced
// it. Two things therefore have to hold at once, and they pull in opposite
// directions:
//
//   * it must still SEPARATE identities — a different credential value, or a
//     different rendered auth header, must never reuse somebody else's
//     authenticated session;
//   * it must not RETAIN the credential — the secret that distinguishes two
//     identities must not survive in the key that distinguishes them.
//
// A digest satisfies both. These tests pin both halves, because a change that
// satisfied only the second (say, dropping the credential from the key) would
// look like a privacy improvement and be a session-hijack bug.
//
// The pool itself composes on top: it is a `Map` keyed by this string, so
// "different key" ⇒ "different session" is the pool's own property, covered in
// `connection-pool.test.ts`.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { connectionPoolKey } from "./plugin";
import type { ConnectorInput } from "./connection";

const SECRET = "sk-live-poolkey-Zq7!x-SECRET";
const OTHER_SECRET = "sk-live-poolkey-Zq7!x-ROTATED";

type RemoteInput = Extract<ConnectorInput, { readonly transport: "remote" }>;

const remoteInput = (overrides: Partial<RemoteInput> = {}): RemoteInput => ({
  transport: "remote",
  endpoint: "https://mcp.example.com/sse",
  remoteTransport: "streamable-http",
  headers: { authorization: `Bearer ${SECRET}` },
  ...overrides,
});

const IDENTITY = { owner: "org", connection: "default" } as const;

describe("MCP connection-pool key", () => {
  it.effect("is a bare SHA-256 digest — no plaintext rides along", () =>
    Effect.gen(function* () {
      const key = yield* connectionPoolKey(remoteInput(), "bearer", { token: SECRET }, IDENTITY);

      // Asserted positively as well as negatively: "does not contain the
      // secret" alone would still pass for a key that appended the digest to
      // the plaintext identity.
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(key).not.toContain(SECRET);
      expect(key).not.toContain(`Bearer ${SECRET}`);
      expect(key).not.toContain("mcp.example.com");
    }),
  );

  it.effect("the same identity keeps producing the same key, so reuse is unchanged", () =>
    Effect.gen(function* () {
      const first = yield* connectionPoolKey(remoteInput(), "bearer", { token: SECRET }, IDENTITY);
      const second = yield* connectionPoolKey(remoteInput(), "bearer", { token: SECRET }, IDENTITY);

      expect(first).toBe(second);
    }),
  );

  it.effect("a rotated credential value produces a different key", () =>
    Effect.gen(function* () {
      // The case this field exists for: a refreshed access token must dial a
      // fresh session rather than reuse one authenticated with the old token.
      const before = yield* connectionPoolKey(
        remoteInput({ headers: {} }),
        "bearer",
        {
          token: SECRET,
        },
        IDENTITY,
      );
      const after = yield* connectionPoolKey(
        remoteInput({ headers: {} }),
        "bearer",
        {
          token: OTHER_SECRET,
        },
        IDENTITY,
      );

      expect(after).not.toBe(before);
    }),
  );

  it.effect("a different rendered auth header produces a different key", () =>
    Effect.gen(function* () {
      // `buildConnectorInput` renders apikey placements onto `headers`, so the
      // same secret reaches the key by a second route. Separation has to hold
      // there too.
      const mine = yield* connectionPoolKey(
        remoteInput({ headers: { authorization: `Bearer ${SECRET}` } }),
        "bearer",
        {},
        IDENTITY,
      );
      const theirs = yield* connectionPoolKey(
        remoteInput({ headers: { authorization: `Bearer ${OTHER_SECRET}` } }),
        "bearer",
        {},
        IDENTITY,
      );

      expect(theirs).not.toBe(mine);
    }),
  );

  it.effect("a credential carried in a query param separates too", () =>
    Effect.gen(function* () {
      // Servers that authenticate via `?token=` put the secret here instead.
      const mine = yield* connectionPoolKey(
        remoteInput({ headers: {}, queryParams: { token: SECRET } }),
        "query",
        {},
        IDENTITY,
      );
      const theirs = yield* connectionPoolKey(
        remoteInput({ headers: {}, queryParams: { token: OTHER_SECRET } }),
        "query",
        {},
        IDENTITY,
      );

      expect(theirs).not.toBe(mine);
      expect(mine).not.toContain(SECRET);
    }),
  );

  it.effect("insertion order does not split one identity into two", () =>
    Effect.gen(function* () {
      // `sortedRecord` exists for this: a key that changed with property order
      // would silently dial a new session per call and never reuse anything.
      const oneWay = yield* connectionPoolKey(
        remoteInput({ headers: { authorization: `Bearer ${SECRET}`, "x-team": "acme" } }),
        "bearer",
        { token: SECRET, region: "eu" },
        IDENTITY,
      );
      const otherWay = yield* connectionPoolKey(
        remoteInput({ headers: { "x-team": "acme", authorization: `Bearer ${SECRET}` } }),
        "bearer",
        { region: "eu", token: SECRET },
        IDENTITY,
      );

      expect(otherWay).toBe(oneWay);
    }),
  );

  it.effect("a different endpoint or template separates identities", () =>
    Effect.gen(function* () {
      const base = yield* connectionPoolKey(remoteInput(), "bearer", { token: SECRET }, IDENTITY);
      const otherEndpoint = yield* connectionPoolKey(
        remoteInput({ endpoint: "https://mcp.other.example.com/sse" }),
        "bearer",
        { token: SECRET },
        IDENTITY,
      );
      const otherTemplate = yield* connectionPoolKey(
        remoteInput(),
        "apikey",
        { token: SECRET },
        IDENTITY,
      );

      expect(otherEndpoint).not.toBe(base);
      expect(otherTemplate).not.toBe(base);
    }),
  );
  it.effect("separates two connections that share an identical no-auth recipe", () =>
    Effect.gen(function* () {
      // An app-server session accumulates the user's approvals. A Codex
      // integration carries no credential, so without the connection in the
      // key every owner hashes alike — and one owner's "for this
      // conversation" grant would answer another owner's prompt.
      const recipe = {
        transport: "stdio" as const,
        command: "/usr/local/bin/codex",
        args: ["app-server"],
        env: { CODEX_HOME: "/home/a/.codex" },
        appServer: { server: "messages" },
      };

      const mine = yield* connectionPoolKey(
        recipe,
        "none",
        {},
        {
          owner: "org",
          connection: "default",
        },
      );
      const theirs = yield* connectionPoolKey(
        recipe,
        "none",
        {},
        {
          owner: "user:someone-else",
          connection: "default",
        },
      );

      expect(theirs).not.toBe(mine);
    }),
  );

  it.effect("separates two projected surfaces that import different modules", () =>
    Effect.gen(function* () {
      const base = {
        transport: "stdio" as const,
        command: "/usr/local/bin/codex",
        args: ["app-server"],
        env: { CODEX_HOME: "/home/a/.codex" },
      };
      const first = yield* connectionPoolKey(
        {
          ...base,
          appServer: {
            server: "node_repl",
            surface: "browser" as const,
            modulePath: "/a/client.mjs",
          },
        },
        "none",
        {},
        IDENTITY,
      );
      const second = yield* connectionPoolKey(
        {
          ...base,
          appServer: {
            server: "node_repl",
            surface: "browser" as const,
            modulePath: "/b/client.mjs",
          },
        },
        "none",
        {},
        IDENTITY,
      );

      expect(second).not.toBe(first);
    }),
  );
});
