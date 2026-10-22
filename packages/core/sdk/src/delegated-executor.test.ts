import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import {
  makeDelegationService,
  type DelegationContext,
  type DelegationScope,
  type DelegationService,
} from "./delegation";
import { collectTables, createExecutor, type Executor } from "./executor";
import { DelegationDeniedError } from "./fuma-runtime";
import { ConnectionAddress, ProviderKey, Subject, Tenant, ToolAddress } from "./ids";
import { definePlugin, tool } from "./plugin";
import { createSqliteTestFumaDb, type SqliteTestFumaDb } from "./sqlite-test-db";
import { makeTestConfig, memoryCredentialsPlugin } from "./testing";

const TENANT = "delegated-executor-tenant";
const CREATOR = Subject.make("administrator-creator");
const TARGET = Subject.make("member-target");
const ALLOWED = ToolAddress.make("delegation-fixture.allowed");
const LATER = ToolAddress.make("delegation-fixture.later");
const CORE_CONNECTIONS_LIST = ToolAddress.make("executor.coreTools.connections.list");
const CORE_PROVIDER_LIST = ToolAddress.make("executor.coreTools.providers.list");
const CORE_OAUTH_CLIENTS_LIST = ToolAddress.make("executor.coreTools.oauth.clients.list");

const toolkit = (toolAddresses: readonly ToolAddress[]) => ({
  toolkitId: "fixture-toolkit",
  revision: "revision-1",
  toolAddresses,
  connectionAddresses: [],
});

const scopeFor = (
  toolAddresses: readonly ToolAddress[],
  connectionAddresses?: readonly string[],
): DelegationScope => ({
  actions: ["discover", "invoke"],
  toolkitMembership: [toolkit(toolAddresses)],
  toolAddresses,
  ...(connectionAddresses === undefined ? {} : { connectionAddresses }),
});

const fixturePlugin = (calls: string[]) =>
  definePlugin(() => ({
    id: "delegation-fixture" as const,
    storage: () => ({}),
    staticIntegrations: () => [
      {
        id: "delegation-fixture",
        kind: "test",
        name: "Delegation fixture",
        tools: [
          tool({
            name: "allowed",
            description: "A tool included in the consent snapshot.",
            execute: () => Effect.sync(() => void calls.push("allowed")),
          }),
          tool({
            name: "later",
            description: "A tool added after the consent snapshot.",
            execute: () => Effect.sync(() => void calls.push("later")),
          }),
        ],
      },
    ],
  }))();

interface DelegationFixture {
  readonly db: SqliteTestFumaDb;
  readonly service: DelegationService;
  readonly grant: DelegationContext;
  readonly executor: Executor;
}

const withDb = <A, E>(body: (db: SqliteTestFumaDb) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() })),
    body,
    (db) => Effect.promise(() => db.close()),
  );

const expectDenied = <A>(
  effect: Effect.Effect<A, unknown>,
  reason: DelegationDeniedError["reason"],
) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error).toBeInstanceOf(DelegationDeniedError);
      expect((error as DelegationDeniedError).reason).toBe(reason);
    }),
  );

const makeService = (
  db: SqliteTestFumaDb,
  tenant: string,
  controls: {
    readonly verified?: () => boolean;
    readonly authorized?: () => boolean;
    readonly now?: () => number;
  } = {},
): DelegationService =>
  makeDelegationService({
    db: db.db,
    tenant: Tenant.make(tenant),
    issuanceEnabled: true,
    now: controls.now,
    isVerifiedHuman: () => Effect.succeed(controls.verified?.() ?? true),
    isCurrentlyAuthorized: () => Effect.succeed(controls.authorized?.() ?? true),
    isManagementAuthorized: () => Effect.succeed(true),
    verifyProof: () => Effect.succeed(true),
  });

const issueExecutor = (
  db: SqliteTestFumaDb,
  service: DelegationService,
  calls: string[],
  input: {
    readonly scope: DelegationScope;
    readonly tenant?: string;
    readonly subject?: Subject;
    readonly coreTools?: boolean;
  },
): Effect.Effect<DelegationFixture, unknown> =>
  Effect.gen(function* () {
    const issued = yield* service.createIssuedKey({
      createdBy: CREATOR,
      effectiveSubject: input.subject ?? TARGET,
      label: "Deterministic fixture key",
      scope: input.scope,
    });
    const grant = yield* service.resolveIssuedKey(issued.secret);
    const plugins = [fixturePlugin(calls), memoryCredentialsPlugin()] as const;
    const config = makeTestConfig({
      tenant: input.tenant ?? TENANT,
      subject: input.subject ?? TARGET,
      plugins,
      ...(input.coreTools === true ? { coreTools: { includeProviders: true } } : {}),
    });
    const executor = yield* createExecutor({
      ...config,
      db: db.db,
      delegation: grant,
    });
    return { db, service, grant, executor };
  });

describe("delegated executor authorization", () => {
  it.effect("filters catalog and schema to the frozen toolkit snapshot", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const service = makeService(db, TENANT);
        const fixture = yield* issueExecutor(db, service, calls, {
          scope: scopeFor([ALLOWED]),
        });

        const listed = yield* fixture.executor.tools.list();
        expect(listed.map((tool) => String(tool.address))).toEqual([String(ALLOWED)]);
        expect((yield* fixture.executor.tools.schema(ALLOWED))?.address).toBe(ALLOWED);
        yield* expectDenied(fixture.executor.tools.schema(LATER), "scope");
        expect(yield* fixture.executor.execute(ALLOWED, {})).toBeUndefined();
        yield* expectDenied(fixture.executor.execute(LATER, {}), "scope");
        expect(calls).toEqual(["allowed"]);
      }),
    ),
  );

  it.effect("denies an empty toolkit and explicit empty connection allowlist", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const service = makeService(db, TENANT);
        const fixture = yield* issueExecutor(db, service, calls, {
          scope: {
            actions: ["discover", "invoke"],
            toolkitMembership: [],
            toolAddresses: [],
            connectionAddresses: [],
          },
        });

        expect(yield* fixture.executor.tools.list()).toEqual([]);
        yield* expectDenied(fixture.executor.execute(ALLOWED, {}), "scope");
        const emptyConnections = yield* issueExecutor(db, service, calls, {
          scope: scopeFor([ALLOWED], []),
        });
        yield* expectDenied(
          emptyConnections.grant.revalidate({
            operation: "invoke",
            tool: ALLOWED,
            connection: ConnectionAddress.make("tools.example.user.empty"),
          }),
          "scope",
        );
        expect(calls).toEqual([]);
      }),
    ),
  );

  it.effect("does not inherit creator administration or provider and secret access", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const service = makeService(db, TENANT);
        const fixture = yield* issueExecutor(db, service, calls, {
          coreTools: true,
          scope: scopeFor([
            ALLOWED,
            CORE_CONNECTIONS_LIST,
            CORE_PROVIDER_LIST,
            CORE_OAUTH_CLIENTS_LIST,
          ]),
        });

        expect(fixture.grant.actorSubject === CREATOR).toBe(false);
        expect(fixture.grant.effectiveSubject === TARGET).toBe(true);
        yield* expectDenied(fixture.executor.connections.list(), "management");
        yield* expectDenied(fixture.executor.providers.list(), "management");
        yield* expectDenied(fixture.executor.execute(CORE_CONNECTIONS_LIST, {}), "management");
        yield* expectDenied(fixture.executor.execute(CORE_PROVIDER_LIST, {}), "management");
        yield* expectDenied(fixture.executor.execute(CORE_OAUTH_CLIENTS_LIST, {}), "management");
        expect(calls).toEqual([]);
      }),
    ),
  );

  it.effect("rechecks revocation and membership on an existing executor", () =>
    withDb((db) =>
      Effect.gen(function* () {
        let verified = true;
        let authorized = true;
        const calls: string[] = [];
        const service = makeService(db, TENANT, {
          verified: () => verified,
          authorized: () => authorized,
        });
        const fixture = yield* issueExecutor(db, service, calls, {
          scope: scopeFor([ALLOWED]),
        });

        yield* fixture.executor.execute(ALLOWED, {});
        yield* service.revoke({ grantId: fixture.grant.grantId, actorSubject: CREATOR });
        yield* expectDenied(fixture.executor.execute(ALLOWED, {}), "revoked");

        const second = yield* issueExecutor(db, service, calls, {
          scope: scopeFor([ALLOWED]),
        });
        authorized = false;
        yield* expectDenied(second.executor.execute(ALLOWED, {}), "unauthorized");
        verified = false;
        yield* expectDenied(second.executor.execute(ALLOWED, {}), "unauthorized");
        expect(calls).toEqual(["allowed"]);
      }),
    ),
  );

  it.effect("rejects tenant and executor subject mismatches", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const service = makeService(db, TENANT);
        const issued = yield* service.createIssuedKey({
          createdBy: CREATOR,
          effectiveSubject: TARGET,
          label: "Tenant binding fixture",
          scope: scopeFor([ALLOWED]),
        });
        const otherTenant = makeService(db, "other-tenant");
        yield* expectDenied(otherTenant.resolveIssuedKey(issued.secret), "unmapped");

        const config = makeTestConfig({
          tenant: TENANT,
          subject: Subject.make("wrong-subject"),
          plugins: [fixturePlugin([])] as const,
        });
        const mismatch = yield* Effect.result(
          createExecutor({ ...config, db: db.db, delegation: issued.grant }),
        );
        expect(Result.isFailure(mismatch)).toBe(true);
      }),
    ),
  );

  it.effect("guards provider item discovery through the public provider surface", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const service = makeService(db, TENANT);
        const fixture = yield* issueExecutor(db, service, [], {
          scope: scopeFor([ALLOWED]),
        });
        yield* expectDenied(
          fixture.executor.providers.items(ProviderKey.make("memory")),
          "management",
        );
      }),
    ),
  );
});
