/** Profile identity is independent of account equality, display names, and deployment selection. */
import { Clock, Effect, Schema, type Crypto } from "effect";
import { Profile, ProfileConflict, ProfileNotFound } from "../contracts/profiles.ts";
import { ProfileId, StorageError, type AppId, type OwnerId } from "../contracts/shared.ts";
import { AccountSelectionInvalid } from "../contracts/apps.ts";
import type { Executor } from "../contracts/executor.ts";
import { query, transaction, type Query } from "./database.ts";
import { storedApp, storedDeployment, lockApp } from "./apps.ts";
import { validateSelection } from "./selection.ts";

/** Resolve only the named profile within the named app and owner. */
export const storedProfile = (
  db: Query,
  input: {
    readonly app: AppId;
    readonly profile: ProfileId;
    readonly owner?: OwnerId | undefined;
  },
) =>
  Effect.gen(function* () {
    const row = yield* query(() =>
      db.findFirst("profiles", {
        where: (b) =>
          b.and(
            b("id", "=", input.profile),
            b("app", "=", input.app),
            input.owner === undefined ? true : b("owner", "=", input.owner),
          ),
      }),
    );
    if (row === null) return yield* new ProfileNotFound({ app: input.app, profile: input.profile });
    return yield* Schema.decodeUnknownEffect(Profile)(row).pipe(
      Effect.mapError(() => new StorageError()),
    );
  });

/** Configuration writes only validate and persist intent; network setup belongs to reconciliation. */
export const makeProfiles = (db: Query, crypto: Crypto.Crypto) => {
  const validate = (
    tx: Query,
    app: Effect.Success<ReturnType<typeof storedApp>>,
    profile: Profile,
  ) =>
    Effect.gen(function* () {
      const accounts = profile.accounts;
      if (app.activeDeployment === null) {
        if (Object.keys(accounts).length > 0)
          return yield* new AccountSelectionInvalid({
            app: app.id,
            slot: "accounts",
            reason: "unknown_slot",
          });
        return;
      }
      const deployment = yield* storedDeployment(tx, app).pipe(
        Effect.mapError(() => new StorageError()),
      );
      yield* validateSelection(tx, app.id, deployment.requirements, accounts);
    });
  const operations = {
    create: (input: Parameters<Executor["apps"]["profiles"]["create"]>[0]) =>
      transaction(db, (tx) =>
        Effect.gen(function* () {
          const app = yield* lockApp(tx, { app: input.app, owner: input.owner });
          const request = {
            ...(input.name === undefined ? {} : { name: input.name }),
            accounts: input.accounts,
            webhookConfig: input.webhookConfig ?? {},
          };
          const previous = yield* query(() =>
            tx.findFirst("profiles", {
              where: (b) =>
                b.and(
                  b("app", "=", app.id),
                  b("subject", "=", input.subject),
                  b("idempotencyKey", "=", input.idempotencyKey),
                ),
            }),
          );
          if (previous !== null) {
            const saved = yield* storedProfile(tx, { app: app.id, profile: previous.id });
            if (!Schema.toEquivalence(Schema.Json)(previous.request, request))
              return yield* new ProfileConflict({
                profile: saved.id,
                reason: "idempotency",
              });
            return saved;
          }
          const profile = Profile.make({
            id: ProfileId.make(
              `ins_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`,
            ),
            app: app.id,
            owner: app.owner,
            subject: input.subject,
            ...request,
            name: input.name ?? null,
            revision: 1,
            enabled: true,
            status: "pending",
            failure: null,
            reconciledDeployment: null,
            reconciledRevision: null,
            createdAt: new Date(yield* Clock.currentTimeMillis),
          });
          yield* validate(tx, app, profile);
          yield* query(() =>
            tx.create("profiles", {
              ...profile,
              idempotencyKey: input.idempotencyKey,
              request,
              lease: null,
              leaseUntil: new Date(0),
            }),
          );
          return profile;
        }),
      ),
    setEnabled: (input: Parameters<Executor["apps"]["profiles"]["setEnabled"]>[0]) =>
      transaction(db, (tx) =>
        Effect.gen(function* () {
          yield* lockApp(tx, input);
          const current = yield* storedProfile(tx, input);
          if (current.revision !== input.expectedRevision)
            return yield* new ProfileConflict({
              profile: current.id,
              reason: "revision",
            });
          if (current.status === "removed" || current.status === "removing")
            return yield* new ProfileConflict({
              profile: current.id,
              reason: "inactive",
            });
          if (current.enabled === input.enabled) return current;
          const next = Profile.make({
            ...current,
            enabled: input.enabled,
            revision: current.revision + 1,
            status: "pending",
            failure: null,
          });
          yield* query(() =>
            tx.updateMany("profiles", {
              where: (b) => b("id", "=", current.id),
              set: {
                enabled: next.enabled,
                revision: next.revision,
                status: next.status,
                failure: null,
              },
            }),
          );
          return next;
        }),
      ),
    get: (input: Parameters<Executor["apps"]["profiles"]["get"]>[0]) => storedProfile(db, input),
    list: (input: Parameters<Executor["apps"]["profiles"]["list"]>[0]) =>
      Effect.gen(function* () {
        yield* storedApp(db, input);
        const rows = yield* query(() =>
          db.findMany("profiles", {
            where: (b) =>
              b.and(
                b("app", "=", input.app),
                b("status", "!=", "removed"),
                input.owner === undefined ? true : b("owner", "=", input.owner),
                input.subject === undefined ? true : b("subject", "=", input.subject),
              ),
            orderBy: ["createdAt", "asc"],
          }),
        );
        return yield* Schema.decodeUnknownEffect(Schema.Array(Profile))(rows).pipe(
          Effect.mapError(() => new StorageError()),
        );
      }),
    listMany: (input: Parameters<Executor["apps"]["profiles"]["listMany"]>[0]) =>
      Effect.gen(function* () {
        if (input.apps.length === 0) return [];
        const rows = yield* query(() =>
          db.findMany("profiles", {
            where: (b) =>
              b.and(
                b("app", "in", input.apps),
                b("owner", "=", input.owner),
                b("subject", "=", input.subject),
                b("status", "!=", "removed"),
              ),
            orderBy: ["createdAt", "asc"],
          }),
        );
        return yield* Schema.decodeUnknownEffect(Schema.Array(Profile))(rows).pipe(
          Effect.mapError(() => new StorageError()),
        );
      }),
    update: (input: Parameters<Executor["apps"]["profiles"]["update"]>[0]) =>
      transaction(db, (tx) =>
        Effect.gen(function* () {
          const app = yield* lockApp(tx, input);
          const current = yield* storedProfile(tx, input);
          if (current.revision !== input.expectedRevision)
            return yield* new ProfileConflict({
              profile: current.id,
              reason: "revision",
            });
          if (current.status === "removed" || current.status === "removing")
            return yield* new ProfileConflict({
              profile: current.id,
              reason: "inactive",
            });
          const next = Profile.make({
            ...current,
            accounts: input.accounts,
            webhookConfig: input.webhookConfig ?? current.webhookConfig,
            revision: current.revision + 1,
            status: "pending",
            failure: null,
          });
          yield* validate(tx, app, next);
          yield* query(() =>
            tx.updateMany("profiles", {
              where: (b) => b("id", "=", current.id),
              set: {
                accounts: next.accounts,
                webhookConfig: next.webhookConfig,
                revision: next.revision,
                status: next.status,
                failure: null,
              },
            }),
          );
          return next;
        }),
      ),
  };
  return {
    ...operations,
    reconcile: (input: Parameters<Executor["apps"]["profiles"]["reconcile"]>[0]) =>
      operations.get(input),
    remove: (input: Parameters<Executor["apps"]["profiles"]["remove"]>[0]) =>
      transaction(db, (tx) =>
        Effect.gen(function* () {
          yield* lockApp(tx, input);
          const current = yield* storedProfile(tx, input);
          if (current.status === "removed") return current;
          yield* query(() =>
            tx.updateMany("profiles", {
              where: (b) => b("id", "=", current.id),
              set: { status: "removing", failure: null },
            }),
          );
          return Profile.make({ ...current, status: "removing", failure: null });
        }),
      ),
  };
};
