import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import { AccountBadRequest, AccountError, AccountForbidden } from "./api";
import { DelegationProvider, type DelegationRequestContext } from "./service";
import {
  collectTables,
  ConnectionAddress,
  makeDelegationService,
  Tenant,
  ToolAddress,
  type DelegationService,
  type VerifiedDelegatedCredential,
} from "@executor-js/sdk";
import { createSqliteTestFumaDb, type SqliteTestFumaDb } from "@executor-js/sdk/testing";

import {
  makeDelegationProvider,
  type DelegationAccountKeyStore,
  type DelegationAccountHost,
  type DelegationHuman,
} from "./delegation-provider";

type DelegationScope = typeof import("./api").DelegationScope.Type;

const REQUEST: DelegationRequestContext = {
  headers: { cookie: "session" },
  requestOrigin: "https://executor.test",
  browserOrigin: "https://executor.test",
};
const TENANT = "tenant-provider-test";
const SELF = "human-self";
const ADMIN = "human-admin";
const OTHER = "human-other";
const TOOL = ToolAddress.make("tools.example.connection.main");
const CONNECTION = ConnectionAddress.make("example.connection.main");
const SCOPE: DelegationScope = {
  scopes: ["discover", "invoke"],
  toolkitIds: ["toolkit-main"],
  connectionIds: [String(CONNECTION)],
};
const CORE_SCOPE = {
  actions: ["discover", "invoke"] as const,
  toolkitMembership: [
    {
      toolkitId: "toolkit-main",
      revision: "revision-1",
      toolAddresses: [TOOL],
      connectionAddresses: [CONNECTION],
    },
  ],
  toolAddresses: [TOOL],
  connectionAddresses: [CONNECTION],
};
const CREDENTIAL: VerifiedDelegatedCredential = {
  kind: "external",
  adapter: "test-adapter",
  issuer: "https://issuer.test",
  audience: TENANT,
  subject: "machine-public-subject",
  credentialRef: "machine-reference",
};

let providerKeySequence = 0;

const providerKeyStore = (options?: {
  readonly bindFails?: boolean;
  readonly revokeBoundFails?: boolean;
  readonly revoked?: string[];
  readonly issued?: VerifiedDelegatedCredential[];
}): DelegationAccountKeyStore => ({
  issue: (_request, _input) =>
    Effect.sync(() => {
      providerKeySequence += 1;
      const id = `provider-key-${providerKeySequence}`;
      const credential: VerifiedDelegatedCredential = {
        kind: "issued-key" as const,
        adapter: "test-provider",
        issuer: "https://provider.test",
        audience: TENANT,
        subject: id,
        credentialRef: id,
      };
      options?.issued?.push(credential);
      return {
        credential,
        actorSubject: `machine:${id}`,
        secret: `${id}.secret`,
      };
    }),
  bind: () =>
    options?.bindFails
      ? Effect.fail(new AccountError({ message: "provider binding failed" }))
      : Effect.void,
  rotate: (_request, _input) =>
    Effect.sync(() => {
      providerKeySequence += 1;
      const id = `provider-key-${providerKeySequence}`;
      const credential: VerifiedDelegatedCredential = {
        kind: "issued-key" as const,
        adapter: "test-provider",
        issuer: "https://provider.test",
        audience: TENANT,
        subject: id,
        credentialRef: id,
      };
      options?.issued?.push(credential);
      return {
        credential,
        actorSubject: `machine:${id}`,
        secret: `${id}.secret`,
      };
    }),
  revoke: (_request, input) =>
    Effect.sync(() => {
      options?.revoked?.push(input.credential.credentialRef);
    }),
  revokeBound: () =>
    options?.revokeBoundFails
      ? Effect.fail(new AccountError({ message: "provider revoke failed" }))
      : Effect.void,
});

const target = (id: string, current: string): typeof import("./api").DelegationTarget.Type => ({
  id,
  email: `${id}@example.test`,
  name: id,
  isCurrentUser: id === current,
  status: "verified",
});

const withDb = <A, E>(body: (db: SqliteTestFumaDb) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() })),
    body,
    (db) => Effect.promise(() => db.close()),
  );

const makeHost = (
  db: SqliteTestFumaDb,
  human: DelegationHuman,
  proof: VerifiedDelegatedCredential = CREDENTIAL,
  keys: DelegationAccountKeyStore = providerKeyStore(),
): DelegationAccountHost => {
  const service: DelegationService = makeDelegationService({
    db: db.db,
    tenant: Tenant.make(TENANT),
    issuanceEnabled: true,
    isVerifiedHuman: (subject) =>
      Effect.succeed([SELF, ADMIN, OTHER, "machine:provider-key"].includes(String(subject))),
    isCurrentlyAuthorized: () => Effect.succeed(true),
    isManagementAuthorized: (actor, targetSubject) =>
      Effect.succeed(String(actor) === ADMIN || String(actor) === String(targetSubject ?? actor)),
    verifyProof: () => Effect.succeed(true),
    verifyProviderCredential: () => Effect.succeed(true),
  });
  const targets = [
    target(SELF, human.subject),
    target(ADMIN, human.subject),
    target(OTHER, human.subject),
  ];
  return {
    human: () => Effect.succeed(human),
    service: () => Effect.succeed(service),
    targets: () => Effect.succeed(targets),
    target: (_request, subject) =>
      Effect.succeed(targets.find((item) => item.id === subject) ?? null),
    scope: () => Effect.succeed(CORE_SCOPE),
    proof: () => Effect.succeed({ credential: proof, machineActor: "machine:provider-key" }),
    providerKeys: keys,
    externalAdapters: ["test-adapter"],
    localKeysEnabled: true,
    issuanceEnabled: true,
  };
};

const providerFor = (host: DelegationAccountHost) =>
  Effect.scoped(
    Layer.build(makeDelegationProvider(host)).pipe(
      Effect.map((context) => Context.get(context, DelegationProvider)),
    ),
  );

describe("delegation account provider", () => {
  it.effect("keeps ordinary revoke-all eligible for future consent", () =>
    withDb((db) =>
      Effect.gen(function* () {
        let disabled = false;
        const host: DelegationAccountHost = {
          ...makeHost(db, {
            subject: ADMIN,
            organizationId: TENANT,
            recent: true,
            canFilterTargets: true,
          }),
          onRevokeAll: () =>
            Effect.sync(() => {
              disabled = true;
            }),
        };
        const provider = yield* providerFor(host);
        yield* provider.revokeAllDelegatedCredentials(REQUEST, {
          target: { kind: "self" },
        });
        expect(disabled).toBe(false);
      }),
    ),
  );

  it.effect("limits self users to their own target and grants admins cross-target visibility", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const selfProvider = yield* providerFor(
          makeHost(db, { subject: SELF, organizationId: TENANT, recent: true }),
        );
        const body = {
          label: "Self key",
          target: { kind: "self" as const },
          scope: SCOPE,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        };
        yield* selfProvider.createDelegatedKey(REQUEST, body);
        const denied = yield* selfProvider
          .createDelegatedKey(REQUEST, { ...body, target: { kind: "verified-human", id: OTHER } })
          .pipe(Effect.flip);
        expect(denied).toBeInstanceOf(AccountForbidden);
        const selfRows = yield* selfProvider.listDelegatedCredentials(REQUEST, {});
        expect(selfRows.credentials).toHaveLength(1);
        expect(selfRows.credentials[0]?.target.id).toBe(SELF);
        const foreignRows = yield* selfProvider
          .listDelegatedCredentials(REQUEST, { targetId: OTHER })
          .pipe(Effect.flip);
        expect(foreignRows).toBeInstanceOf(AccountForbidden);

        const adminProvider = yield* providerFor(
          makeHost(db, {
            subject: ADMIN,
            organizationId: TENANT,
            recent: true,
            canFilterTargets: true,
          }),
        );
        yield* adminProvider.createDelegatedKey(REQUEST, {
          ...body,
          target: { kind: "verified-human", id: OTHER },
          label: "Other key",
        });
        yield* adminProvider.createDelegatedKey(REQUEST, {
          ...body,
          target: { kind: "verified-human", id: SELF },
          label: "Admin key for self",
        });
        const otherRows = yield* adminProvider.listDelegatedCredentials(REQUEST, {
          targetId: OTHER,
          includeRevoked: "true",
        });
        expect(otherRows.credentials).toHaveLength(1);
        expect(otherRows.credentials[0]?.target.id).toBe(OTHER);
        expect(otherRows.credentials[0]?.createdBy).toMatchObject({ kind: "human", id: ADMIN });
        const audit = yield* adminProvider.listDelegationAudit(REQUEST, {
          credentialId: otherRows.credentials[0]?.id,
        });
        const targetAudit = yield* adminProvider.listDelegationAudit(REQUEST, {
          targetId: OTHER,
        });
        expect(targetAudit.events.length).toBeGreaterThan(0);
        expect(audit.events.length).toBeGreaterThan(0);
        expect(
          audit.events.every((event) => event.credentialId === otherRows.credentials[0]?.id),
        ).toBe(true);
        expect(audit.events[0]?.actor.kind).toBe("human");
        const selfAudit = yield* selfProvider.listDelegationAudit(REQUEST, {});
        expect(
          selfAudit.events.some(
            (event) => event.actor.kind === "human" && event.actor.id === ADMIN,
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("requires the challenge nonce and preserves the proven machine reference", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const provider = yield* providerFor(
          makeHost(db, { subject: SELF, organizationId: TENANT, recent: true }),
        );
        const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
        const challenge = yield* provider.startDelegationChallenge(REQUEST, {
          adapter: "test-adapter",
          label: "External agent",
          target: { kind: "self" },
          scope: SCOPE,
          expiresAt,
        });
        const badProof = yield* provider
          .completeDelegationProof(REQUEST, challenge.id, { nonce: "wrong", proofType: "bearer" })
          .pipe(Effect.flip);
        expect(badProof).toBeInstanceOf(AccountBadRequest);
        const proven = yield* provider.completeDelegationProof(REQUEST, challenge.id, {
          nonce: challenge.nonce,
          proofType: "bearer",
        });
        expect(proven.status).toBe("proof-complete");
        expect(proven.provenCredential).toMatchObject({
          kind: "external",
          reference: expect.stringContaining("…"),
        });
        const consented = yield* provider.consentDelegationChallenge(REQUEST, challenge.id, {
          scope: SCOPE,
          expiresAt,
        });
        expect(consented.status).toBe("consented");
      }),
    ),
  );

  it.effect("requires recent human authentication for local key mutation", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const provider = yield* providerFor(
          makeHost(db, { subject: SELF, organizationId: TENANT, recent: false }),
        );
        const denied = yield* provider
          .createDelegatedKey(REQUEST, {
            label: "Recent auth key",
            target: { kind: "self" },
            scope: SCOPE,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          })
          .pipe(Effect.flip);
        expect(denied).toBeInstanceOf(AccountForbidden);
      }),
    ),
  );

  it.effect("fails closed when the host has no provider key authority", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const host = makeHost(db, { subject: SELF, organizationId: TENANT, recent: true });
        const provider = yield* providerFor({ ...host, providerKeys: undefined });
        const listed = yield* provider.listDelegatedCredentials(REQUEST, {});
        expect(listed.capabilities.localKeysEnabled).toBe(false);
        const denied = yield* provider
          .createDelegatedKey(REQUEST, {
            label: "Unavailable key",
            target: { kind: "self" },
            scope: SCOPE,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          })
          .pipe(Effect.flip);
        expect(denied).toBeInstanceOf(AccountForbidden);
      }),
    ),
  );

  it.effect("rotates, revokes, and records durable target notices", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const adminProvider = yield* providerFor(
          makeHost(
            db,
            { subject: ADMIN, organizationId: TENANT, recent: true, canFilterTargets: true },
            CREDENTIAL,
          ),
        );
        const created = yield* adminProvider.createDelegatedKey(REQUEST, {
          label: "Rotatable",
          target: { kind: "verified-human", id: OTHER },
          scope: SCOPE,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
        const targetProvider = yield* providerFor(
          makeHost(db, { subject: OTHER, organizationId: TENANT, recent: true }, CREDENTIAL),
        );
        const visible = yield* targetProvider.listDelegationNotifications(REQUEST);
        expect(visible.notifications).toHaveLength(1);
        const notificationId = visible.notifications[0]?.id;
        expect(notificationId).toBeDefined();
        yield* targetProvider.markDelegationNotificationRead(REQUEST, notificationId!);
        const read = yield* targetProvider.listDelegationNotifications(REQUEST);
        expect(read.notifications[0]?.readAt).not.toBeNull();

        const rotated = yield* adminProvider.rotateDelegatedKey(REQUEST, created.credential.id);
        expect(rotated.value).not.toBe(created.value);
        const all = yield* adminProvider.listDelegatedCredentials(REQUEST, {
          targetId: OTHER,
          includeRevoked: "true",
        });
        expect(all.credentials).toHaveLength(2);
        expect(all.credentials.filter((item) => item.lifecycle.status === "revoked")).toHaveLength(
          1,
        );
        yield* adminProvider.revokeDelegatedCredential(REQUEST, rotated.credential.id);
        const revoked = yield* adminProvider.listDelegatedCredentials(REQUEST, {
          targetId: OTHER,
          includeRevoked: "true",
        });
        expect(revoked.credentials.every((item) => item.lifecycle.status === "revoked")).toBe(true);
      }),
    ),
  );

  it.effect("lets administrators revoke grants for removed targets", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const issued: VerifiedDelegatedCredential[] = [];
        const adminHost = makeHost(
          db,
          { subject: ADMIN, organizationId: TENANT, recent: true, canFilterTargets: true },
          CREDENTIAL,
          providerKeyStore({ issued }),
        );
        const adminProvider = yield* providerFor(adminHost);
        yield* adminProvider.createDelegatedKey(REQUEST, {
          label: "Offboarding key",
          target: { kind: "verified-human", id: OTHER },
          scope: SCOPE,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
        const providerCredential = issued[0];
        expect(providerCredential).toBeDefined();
        const service = yield* adminHost.service(REQUEST);
        expect((yield* service.resolve(providerCredential!)).effectiveSubject).toBe(OTHER);

        let disabledSubject: string | null = null;
        const removedTargetHost: DelegationAccountHost = {
          ...adminHost,
          // Revocation is an emergency authority-removal operation. An
          // otherwise valid admin session may use it after the short MFA
          // freshness window has elapsed.
          human: () =>
            Effect.succeed({
              subject: ADMIN,
              organizationId: TENANT,
              recent: false,
              canFilterTargets: true,
            }),
          targets: () => Effect.succeed([target(ADMIN, ADMIN)]),
          target: () => Effect.succeed(null),
          onRevokeAll: (_request, subject) =>
            Effect.sync(() => {
              disabledSubject = subject;
            }),
        };
        const removedTargetProvider = yield* providerFor(removedTargetHost);
        const historical = yield* removedTargetProvider.listDelegatedCredentials(REQUEST, {
          targetId: OTHER,
          includeRevoked: "true",
        });
        expect(historical.credentials[0]?.target).toMatchObject({
          id: OTHER,
          email: "",
          status: "removed",
        });
        const revoked = yield* removedTargetProvider.revokeAllDelegatedCredentials(REQUEST, {
          target: { kind: "verified-human", id: OTHER },
          disableTarget: true,
        });
        expect(revoked.revokedCount).toBe(1);
        expect(disabledSubject).toBe(OTHER);
        const denied = yield* service.resolve(providerCredential!).pipe(Effect.flip);
        expect(denied).toMatchObject({ reason: "revoked" });

        const memberProvider = yield* providerFor(
          makeHost(db, { subject: SELF, organizationId: TENANT, recent: true }),
        );
        const forbidden = yield* memberProvider
          .revokeAllDelegatedCredentials(REQUEST, {
            target: { kind: "verified-human", id: OTHER },
            disableTarget: true,
          })
          .pipe(Effect.flip);
        expect(forbidden).toBeInstanceOf(AccountForbidden);
      }),
    ),
  );

  it.effect("keeps a grant denied when upstream revocation is unavailable", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const issued: VerifiedDelegatedCredential[] = [];
        const host = makeHost(
          db,
          { subject: ADMIN, organizationId: TENANT, recent: false, canFilterTargets: true },
          CREDENTIAL,
          providerKeyStore({ issued, revokeBoundFails: true }),
        );
        // Creation uses a fresh human in production; seed the grant through a
        // sibling provider and then exercise stale-session emergency revoke.
        const creator = yield* providerFor({
          ...host,
          human: () =>
            Effect.succeed({
              subject: ADMIN,
              organizationId: TENANT,
              recent: true,
              canFilterTargets: true,
            }),
        });
        const created = yield* creator.createDelegatedKey(REQUEST, {
          label: "Upstream outage",
          target: { kind: "verified-human", id: OTHER },
          scope: SCOPE,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
        const provider = yield* providerFor(host);
        const failed = yield* provider
          .revokeDelegatedCredential(REQUEST, created.credential.id)
          .pipe(Effect.flip);
        expect(failed).toBeInstanceOf(AccountError);
        const service = yield* host.service(REQUEST);
        const denied = yield* service.resolve(issued[0]!).pipe(Effect.flip);
        expect(denied).toMatchObject({ reason: "revoked" });
      }),
    ),
  );

  it.effect("propagates the host same-origin/session gate before mutation", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const host = makeHost(db, { subject: SELF, organizationId: TENANT, recent: true });
        const gatedHost: DelegationAccountHost = {
          ...host,
          human: () =>
            Effect.fail(new AccountForbidden({ message: "same-origin browser session required" })),
        };
        const provider = yield* providerFor(gatedHost);
        const denied = yield* provider
          .createDelegatedKey(REQUEST, {
            label: "Origin gate",
            target: { kind: "self" },
            scope: SCOPE,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          })
          .pipe(Effect.flip);
        expect(denied).toBeInstanceOf(AccountForbidden);
      }),
    ),
  );

  it.effect("compensates a provider key when core binding fails", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const revoked: string[] = [];
        const host = makeHost(
          db,
          { subject: SELF, organizationId: TENANT, recent: true },
          CREDENTIAL,
          providerKeyStore({ bindFails: true, revoked }),
        );
        const provider = yield* providerFor(host);
        const denied = yield* provider
          .createDelegatedKey(REQUEST, {
            label: "Compensated key",
            target: { kind: "self" },
            scope: SCOPE,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          })
          .pipe(Effect.flip);
        expect(denied).toBeInstanceOf(AccountError);
        expect(revoked).toHaveLength(1);
        const service = yield* host.service(REQUEST);
        expect(yield* service.list()).toHaveLength(0);
      }),
    ),
  );
});
