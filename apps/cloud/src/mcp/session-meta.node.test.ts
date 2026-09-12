// Where an MCP session's organization identity comes from, and what happens
// when the only remaining source — the database — is unreachable.
//
// The production defect: every cold session-DO init read the `organizations`
// row over a brand-new Postgres connection, even though the worker had resolved
// that exact row microseconds earlier on the same request, and even when the DO
// already held the answer in its own storage. A connect timeout on that
// unnecessary connection became an unclassified defect and killed `initialize`.
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Predicate, Result } from "effect";

import { defaultMcpResource } from "@executor-js/host-mcp";
import type { McpSessionInit, SessionMeta } from "@executor-js/cloudflare/mcp/agent-durable-object";

import { UserStoreService } from "../auth/context";
import { UserStoreError } from "../auth/errors";
import { WorkOSClient, type WorkOSClientService } from "../auth/workos";
import {
  isMcpSessionMetaUnavailable,
  resolveSessionMetaForToken,
  SESSION_META_DB_RETRIES,
} from "./session-meta";

const TOKEN: McpSessionInit = {
  organizationId: "org_test",
  orgRoleModel: "organization",
  orgRole: "member",
  userId: "user_test",
  elicitationMode: "model",
  resource: defaultMcpResource,
  artifactsEnabled: true,
};

const STORED: SessionMeta = {
  organizationId: "org_test",
  organizationName: "Stored Org",
  organizationSlug: "stored-org",
  orgRoleModel: "organization",
  orgRole: "admin",
  userId: "user_test",
  resource: defaultMcpResource,
};

/** A user store that always fails the way a wedged Hyperdrive endpoint does,
 *  counting how many times it was asked. */
const countingConnectTimeoutStore = (): {
  readonly layer: Layer.Layer<UserStoreService>;
  readonly calls: () => number;
} => {
  let calls = 0;
  return {
    calls: () => calls,
    layer: Layer.succeed(UserStoreService)({
      use: (operation: string) =>
        Effect.suspend(() => {
          calls += 1;
          return Effect.fail(new UserStoreError({ operation, reason: "connect_timeout" }));
        }),
    } as UserStoreService["Service"]),
  };
};

const namingStore = (): {
  readonly layer: Layer.Layer<UserStoreService>;
  readonly calls: () => number;
} => {
  let calls = 0;
  return {
    calls: () => calls,
    layer: Layer.succeed(UserStoreService)({
      use: (_operation: string, fn: (store: never) => Promise<unknown>) =>
        Effect.suspend(() => {
          calls += 1;
          return Effect.promise(() =>
            fn({
              getOrganization: async (id: string) => ({
                id,
                name: "Database Org",
                slug: "database-org",
              }),
            } as never),
          );
        }),
    } as UserStoreService["Service"]),
  };
};

const unusedWorkOS = Layer.succeed(
  WorkOSClient,
  new Proxy({} as WorkOSClientService, {
    get: (_target, prop) => () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`),
  }),
);

// The props source — the one the overwhelming majority of inits take — is
// covered black-box by `e2e/cloud/mcp-session-cold-init.test.ts`. What stays
// here is what that scenario cannot reach: the sources it falls back to, and
// what an unreachable database does to them.
describe("resolveSessionMetaForToken", () => {
  it("falls back to the meta this session already stored, without touching the store", async () => {
    const store = countingConnectTimeoutStore();

    const meta = await Effect.runPromise(
      resolveSessionMetaForToken(TOKEN, STORED).pipe(
        Effect.provide(Layer.mergeAll(store.layer, unusedWorkOS)),
      ),
    );

    expect(meta.organizationName).toBe("Stored Org");
    expect(meta.organizationSlug).toBe("stored-org");
    expect(meta.orgRole).toBe("member");
    expect(store.calls(), "a restore reuses what it persisted").toBe(0);
  });

  it("does not let a stored admin role authorize legacy init props", async () => {
    const store = countingConnectTimeoutStore();
    const { orgRole: _orgRole, ...legacyToken } = TOKEN;

    const meta = await Effect.runPromise(
      resolveSessionMetaForToken(legacyToken, STORED).pipe(
        Effect.provide(Layer.mergeAll(store.layer, unusedWorkOS)),
      ),
    );

    expect(meta.orgRole).toBeUndefined();
    expect(store.calls()).toBe(0);
  });

  it("uses the fresh role when a warm session's principal is demoted", async () => {
    const store = countingConnectTimeoutStore();
    const admin = await Effect.runPromise(
      resolveSessionMetaForToken({ ...TOKEN, orgRole: "admin" }, STORED).pipe(
        Effect.provide(Layer.mergeAll(store.layer, unusedWorkOS)),
      ),
    );
    const member = await Effect.runPromise(
      resolveSessionMetaForToken(TOKEN, admin).pipe(
        Effect.provide(Layer.mergeAll(store.layer, unusedWorkOS)),
      ),
    );

    expect(admin.orgRole).toBe("admin");
    expect(member.orgRole).toBe("member");
    expect(store.calls()).toBe(0);
  });

  it("reads the database only when nothing else names the org", async () => {
    const store = namingStore();

    const meta = await Effect.runPromise(
      resolveSessionMetaForToken(TOKEN, null).pipe(
        Effect.provide(Layer.mergeAll(store.layer, unusedWorkOS)),
      ),
    );

    expect(meta.organizationName).toBe("Database Org");
    expect(meta.orgRole).toBe("member");
    expect(store.calls()).toBe(1);
  });

  it("retries a connect timeout a bounded number of times, then fails retryably", async () => {
    const store = countingConnectTimeoutStore();

    const result = await Effect.runPromise(
      resolveSessionMetaForToken(TOKEN, null).pipe(
        Effect.provide(Layer.mergeAll(store.layer, unusedWorkOS)),
        Effect.result,
      ),
    );

    expect(Result.isFailure(result), "an unreachable directory is a failure, not a defect").toBe(
      true,
    );
    if (!Result.isFailure(result)) return;
    expect(Predicate.isTagged(result.failure, "McpSessionMetaUnavailableError")).toBe(true);
    expect(
      isMcpSessionMetaUnavailable(result.failure),
      "the worker can recognise it across the Durable Object boundary",
    ).toBe(true);
    expect(store.calls(), "bounded: the first attempt plus its retries").toBe(
      SESSION_META_DB_RETRIES + 1,
    );
  });

  it("does not retry a deterministic query failure", async () => {
    let calls = 0;
    const store = Layer.succeed(UserStoreService)({
      use: (operation: string) =>
        Effect.suspend(() => {
          calls += 1;
          return Effect.fail(new UserStoreError({ operation, reason: "query" }));
        }),
    } as UserStoreService["Service"]);

    const result = await Effect.runPromise(
      resolveSessionMetaForToken(TOKEN, null).pipe(
        Effect.provide(Layer.mergeAll(store, unusedWorkOS)),
        Effect.result,
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(calls, "a query the server answered will answer the same way again").toBe(1);
  });
});
