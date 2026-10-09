import type { ResourceLifecycle } from "../contracts/executor.ts";
import { AppWorkflowsActive } from "../contracts/apps.ts";
import { AppWebhooksActive } from "../contracts/apps.ts";
import { appSlug } from "../contracts/app-slug.ts";
/** Durable configured apps and immutable deployments, sharing one execution path. */
import { Clock, type Crypto, Effect, Schema, Struct } from "effect";
import { SqlError } from "effect/sql";
import {
  App,
  DeployedApp,
  AppNameTaken,
  AppNotFound,
  AppNotDeployed,
  AppSlugTaken,
  AppRequirements,
  type AppCopyOrigin,
  type AppCopySnapshot,
} from "../contracts/apps.ts";
import { makeAppAuthoring } from "./app-authoring.ts";
import {
  AppDeploymentChanged,
  Deployment,
  DeploymentMetadata,
  DeploymentBuildFailed,
  BuildMemoryExceeded,
  DeploymentNotFound,
  DeploymentSummary,
  SourceFiles,
} from "../contracts/deployment.ts";
import type { Executor } from "../contracts/executor.ts";
import {
  RuntimeBuildFailed,
  RuntimeAppsDependencyMissing,
  RuntimeProtocolUnsupported,
  type Runtime,
} from "../contracts/runtime.ts";
import {
  AppCodeId,
  AppId,
  DeploymentId,
  OwnerId,
  StorageError,
  JsonObject,
} from "../contracts/shared.ts";
import { StoredApp, StoredDeployment } from "../contracts/storage.ts";
import { query, transaction, type Query } from "./database.ts";
import { identifyProvider } from "./provider.ts";
import { SourceError, type AppSourceStorage, type RepositoryBackend } from "../contracts/source.ts";
import type { Registry } from "../contracts/registry.ts";
import { resolvePublication } from "./registry.ts";

import type { BlobStorage } from "../contracts/blobs.ts";
import { readDeploymentSource, writeDeploymentSource } from "./deployment-source.ts";
import { readInitialSource, writeInitialSource } from "./initial-source.ts";

type DeployInput = NonNullable<Parameters<Executor["apps"]["deploy"]>[0]>;

/** Read a configured app, applying an optional owner constraint. */

/** Carry the runtime's stage, location and underlying failure to the deployer. */
const deploymentBuildFailed = (owner: OwnerId, name: string, error: RuntimeBuildFailed) => {
  const { stage, dependency, location } = error;
  const hint =
    dependency === undefined ? undefined : `Add ${dependency} to package.json dependencies.`;
  const detail =
    error.declaration !== undefined
      ? error.declaration.message
      : error.message.length > 0
        ? error.message
        : hint;
  // Compiler messages already begin with their location.
  const where =
    location === undefined || detail?.includes(location.file) === true
      ? ""
      : ` in ${location.file}${location.line === undefined ? "" : `:${location.line}${location.column === undefined ? "" : `:${location.column}`}`}`;
  return new DeploymentBuildFailed({
    owner,
    name,
    reason: hint ?? error.declaration?.message ?? "App build failed",
    stage,
    ...(location === undefined ? {} : { location }),
    message: `App build failed at the ${stage} stage${where}${detail === undefined ? "." : `: ${detail}`}`,
  });
};

export const storedApp = (db: Query, input: Parameters<Executor["apps"]["get"]>[0]) =>
  Effect.gen(function* () {
    const row = yield* query(() =>
      db.findFirst("apps", {
        where: (b) =>
          b.and(
            b("id", "=", input.app),
            input.owner === undefined ? true : b("owner", "=", input.owner),
          ),
      }),
    );
    if (row === null) return yield* Effect.fail(new AppNotFound({ app: input.app }));
    return yield* Schema.decodeUnknownEffect(StoredApp)(row).pipe(
      Effect.mapError(() => new StorageError()),
    );
  });

/** Lock the app before changing selections or deployment; only write its immutable code identity, then reread. */
export const lockApp = (db: Query, input: Parameters<Executor["apps"]["get"]>[0]) =>
  Effect.gen(function* () {
    const app = yield* storedApp(db, input);
    yield* query(() =>
      db.updateMany("apps", {
        where: (b) => b.and(b("id", "=", app.id), b("code", "=", app.code)),
        set: { code: app.code },
      }),
    );
    return yield* storedApp(db, input);
  });

/** Read a deployment from this app's lineage, including its retained source and requirements. */
export const storedDeployment = (
  db: Query,
  app: Pick<StoredApp, "id" | "code" | "activeDeployment">,
  deployment: DeploymentId | null = app.activeDeployment,
  deploymentOwner?: OwnerId,
) =>
  Effect.gen(function* () {
    if (deployment === null) return yield* new AppNotDeployed({ app: app.id });
    const row = yield* query(() =>
      db.findFirst("deployments", {
        where: (b) =>
          b.and(
            b("id", "=", deployment),
            b("code", "=", app.code),
            deploymentOwner === undefined ? true : b("owner", "=", deploymentOwner),
          ),
      }),
    );
    if (row === null)
      return yield* Effect.fail(new DeploymentNotFound({ app: app.id, deployment }));
    return yield* Schema.decodeUnknownEffect(StoredDeployment)(row).pipe(
      Effect.mapError(() => new StorageError()),
    );
  });

const StoredDeploymentRequirements = Schema.Struct({ requirements: AppRequirements });

/** Whether any deployment of the app's code applied SQL migrations. */
const hadMigrations = (db: Query, code: AppCodeId) =>
  query(() =>
    db.findMany("deployments", { select: ["requirements"], where: (b) => b("code", "=", code) }),
  ).pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        Schema.decodeUnknownEffect(StoredDeploymentRequirements)(row).pipe(
          Effect.mapError(() => new StorageError()),
        ),
      ),
    ),
    Effect.map((deployed) => deployed.some((deployment) => deployment.requirements.sql === true)),
  );
const AppProjection = Schema.Struct({
  app: StoredApp,
  deployment: Schema.NullOr(StoredDeploymentRequirements),
});
const projectedApp = (row: { readonly app: unknown; readonly deployment: unknown }) =>
  Schema.decodeUnknownEffect(AppProjection)(row).pipe(
    Effect.mapError(() => new StorageError()),
    Effect.flatMap(({ app, deployment }) => {
      if (app.activeDeployment !== null && deployment === null)
        return Effect.fail(new StorageError());
      return Effect.succeed({
        ...Struct.omit(app, ["deploySequence", "activatedSequence"]),
        requirements: deployment === null ? { accounts: {} } : deployment.requirements,
      });
    }),
  );

/** Project an app without reading or decoding its retained source files. */
function project(db: Query, app: StoredApp) {
  if (app.activeDeployment === null)
    return Effect.succeed({
      ...Struct.omit(app, ["deploySequence", "activatedSequence"]),
      requirements: { accounts: {} },
    });
  return query(() =>
    db.findFirst("deployments", {
      select: ["requirements"],
      where: (b) => b.and(b("id", "=", app.activeDeployment), b("code", "=", app.code)),
    }),
  ).pipe(
    Effect.flatMap((row) =>
      row === null
        ? Effect.fail(new StorageError())
        : Schema.decodeUnknownEffect(StoredDeploymentRequirements)(row).pipe(
            Effect.mapError(() => new StorageError()),
          ),
    ),

    Effect.map((deployment): App => ({
      ...Struct.omit(app, ["deploySequence", "activatedSequence"]),
      requirements: deployment.requirements,
    })),
  );
}

/** Translate atomic name/address constraints without hiding unrelated database failures. */
const appWriteFailure = (app: Pick<StoredApp, "owner" | "name" | "slug">) => (error: unknown) => {
  if (SqlError.isSqlError(error) && Schema.is(SqlError.UniqueViolation)(error.reason)) {
    if (error.reason.constraint === "executor_apps_owner_name")
      return new AppNameTaken({ owner: app.owner, name: app.name });
    if (error.reason.constraint === "executor_apps_owner_slug")
      return new AppSlugTaken({ owner: app.owner, slug: app.slug });
  }
  return new StorageError();
};
/** Insert app identity while preserving name and derived-slug uniqueness errors. */
export const createApp = (db: Query, app: StoredApp) =>
  db.create("apps", app).pipe(Effect.mapError(appWriteFailure(app)));

/** Bind app operations; all network/build work finishes before any database transaction. */
export const makeApps = (
  db: Query,
  runtime: Runtime,
  crypto: Crypto.Crypto,
  sources: AppSourceStorage,
  repositories: RepositoryBackend,
  registry: Registry,
  blobs: BlobStorage,
  lifecycle?: ResourceLifecycle,
) => {
  const authoring = makeAppAuthoring(db, sources, repositories, blobs, crypto, lifecycle);
  const deploy = (input: DeployInput, copiedFrom: AppCopyOrigin | null = null) =>
    Effect.gen(function* () {
      // Reserve an order before building. Only successful promotions advance the other counter.
      const before =
        input.app === undefined
          ? null
          : yield* transaction(db, (tx) =>
              Effect.gen(function* () {
                const current = yield* lockApp(tx, { app: input.app, owner: input.owner });
                const deploySequence = current.deploySequence + 1;
                yield* query(() =>
                  tx.updateMany("apps", {
                    where: (b) => b("id", "=", current.id),
                    set: { deploySequence },
                  }),
                );
                return { ...current, deploySequence };
              }),
            );
      const deployName = before === null ? input.name : before.name;
      if (deployName === undefined) return yield* new StorageError();
      if (before === null) {
        const taken = yield* query(() =>
          db.findFirst("apps", {
            where: (b) => b.and(b("owner", "=", input.owner), b("name", "=", deployName)),
          }),
        );
        if (taken !== null)
          return yield* new AppNameTaken({ owner: input.owner, name: deployName });
      }
      const code =
        before === null
          ? AppCodeId.make(
              `code_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`,
            )
          : before.code;
      const sequence = before === null ? 1 : before.deploySequence;
      const suppliedFiles =
        input.commit === undefined
          ? input.files
          : yield* sources.read({ code, commit: input.commit });
      const files = yield* Schema.decodeUnknownEffect(SourceFiles)(suppliedFiles).pipe(
        Effect.mapError(
          () =>
            new DeploymentBuildFailed({
              owner: input.owner,
              name: deployName,
              reason: "Invalid source files",
              stage: "source",
              message: "App build failed: the source files are invalid.",
            }),
        ),
      );
      const built = yield* runtime.build({ files }).pipe(
        Effect.mapError((error) =>
          Schema.is(BuildMemoryExceeded)(error)
            ? error
            : Schema.is(RuntimeProtocolUnsupported)(error)
              ? new DeploymentBuildFailed({
                  owner: input.owner,
                  name: deployName,
                  reason: `${error.message} Declare a supported apps version.`,
                  message: `${error.message} Declare a supported apps version.`,
                })
              : Schema.is(RuntimeAppsDependencyMissing)(error)
                ? new DeploymentBuildFailed({
                    owner: input.owner,
                    name: deployName,
                    reason: error.message,
                    message: error.message,
                  })
                : deploymentBuildFailed(input.owner, deployName, error),
        ),
      );
      const entries = yield* Effect.forEach(
        Object.entries(built.requirements.accounts),
        ([slot, value]) =>
          identifyProvider(value.definition, crypto).pipe(
            Effect.map((provider) => ({
              slot,
              provider,
              cardinality: value.cardinality,
              health: value.health,
            })),
          ),
      );
      const requirements: AppRequirements = {
        ...(built.requirements.capabilities === undefined
          ? {}
          : { capabilities: built.requirements.capabilities }),
        ...(built.requirements.database === undefined
          ? {}
          : { database: built.requirements.database }),
        ...(built.requirements.sql === true ? { sql: true as const } : {}),
        ...(built.requirements.events === undefined ? {} : { events: built.requirements.events }),
        accounts: Object.fromEntries(
          entries.map(({ slot, provider, cardinality, health }) => [
            slot,
            {
              provider: provider.id,
              definition: provider.definition,
              cardinality,
              ...(health === undefined ? {} : { health }),
            },
          ]),
        ),
      };
      // The app's database lives in its data facet, keyed by app ID, so a new app's ID is chosen
      // before its migrations run. A failed migration fails the deploy before anything activates.
      const appId =
        before?.id ??
        AppId.make(
          `app_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`,
        );
      // Migrations are the database. A build without any would drop the ones an earlier deployment
      // applied, whichever deployment is active now, so the app's whole deployment history decides.
      // The build is not asked: bundles of earlier protocols cannot answer. Checked again under the
      // final app lock, since a concurrent deploy may publish migrations meanwhile.
      const droppedMigrations = (target: Query, app: AppCodeId) =>
        requirements.sql === true
          ? Effect.void
          : hadMigrations(target, app).pipe(
              Effect.flatMap((had) => {
                if (!had) return Effect.void;
                const message =
                  "App migration failed: this app's database has applied migrations, but the build has no migrations/. Applied migrations cannot be removed: restore them and deploy again. The previous deployment is still active.";
                return Effect.fail(
                  new DeploymentBuildFailed({
                    owner: input.owner,
                    name: deployName,
                    stage: "migrate",
                    reason: message,
                    message,
                  }),
                );
              }),
            );
      if (before !== null) yield* droppedMigrations(db, before.code);
      if (requirements.sql === true)
        yield* runtime.migrate({ app: appId, build: built.build }).pipe(
          Effect.mapError((error) => {
            const message = `App migration failed${error.message.length === 0 ? "." : `: ${error.message}`}`;
            return new DeploymentBuildFailed({
              owner: input.owner,
              name: deployName,
              stage: "migrate",
              reason: message,
              message,
            });
          }),
          Effect.withSpan("sdk.apps.migrate"),
        );

      const deployment = {
        id: DeploymentId.make(
          `dpl_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`,
        ),
        code,
        owner: input.owner,
        sourceCommit: input.commit ?? null,
        build: built.build,
        createdAt: new Date(yield* Clock.currentTimeMillis),
      };
      yield* writeDeploymentSource(blobs, deployment.id, files);
      // A new app owns an initial workspace independently of this immutable deployment.
      if (before === null) yield* writeInitialSource(blobs, code, files);
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const row = yield* query(() =>
            tx.findFirst("apps", {
              where: (b) =>
                input.app !== undefined
                  ? b.and(b("id", "=", input.app), b("owner", "=", input.owner))
                  : b.and(b("owner", "=", input.owner), b("name", "=", deployName)),
            }),
          );
          const existing =
            row === null ? undefined : yield* lockApp(tx, { app: row.id, owner: input.owner });
          if (existing !== undefined && existing.code !== code)
            return yield* new AppNameTaken({ owner: input.owner, name: deployName });
          if (before !== null && existing === undefined)
            return yield* new AppNotFound({ app: before.id });
          if (input.app !== undefined && existing === undefined)
            return yield* Effect.fail(new AppNotFound({ app: input.app }));
          if (existing !== undefined && input.app === undefined)
            return yield* Effect.fail(new AppNameTaken({ owner: input.owner, name: deployName }));
          if (existing !== undefined) yield* droppedMigrations(tx, existing.code);
          const createdAt = new Date(yield* Clock.currentTimeMillis);
          const promote = existing === undefined || sequence > existing.activatedSequence;
          for (const { provider } of entries) {
            // Apps sharing a provider ID can declare different hosts; the row keeps what they share.
            const definition = yield* Schema.decodeUnknownEffect(JsonObject)(provider.shared).pipe(
              Effect.mapError(() => new StorageError()),
            );
            yield* query(() =>
              tx.upsert("providers", {
                where: (b) => b("id", "=", provider.id),
                create: { id: provider.id, definition },
                update: { definition },
              }),
            );
          }
          const encodedRequirements = yield* Schema.encodeEffect(
            Schema.toCodecJson(AppRequirements),
          )(requirements).pipe(Effect.mapError(() => new StorageError()));
          yield* query(() =>
            tx.create("deployments", {
              ...deployment,
              requirements: encodedRequirements,
              fileCount: files.length,
            }),
          );
          const app = {
            id: appId,
            code,
            repository: existing === undefined ? null : existing.repository,
            owner: input.owner,
            name: existing?.name ?? deployName,
            slug: appSlug(existing?.name ?? deployName),
            activeDeployment: promote ? deployment.id : existing.activeDeployment,
            copiedFrom: existing === undefined ? copiedFrom : existing.copiedFrom,
            createdAt: existing === undefined ? createdAt : existing.createdAt,
          };
          if (existing === undefined) {
            yield* createApp(tx, {
              ...app,
              name: deployName,
              deploySequence: sequence,
              activatedSequence: sequence,
            });
            if (lifecycle) yield* lifecycle.appCreated({ ...app, requirements });
          } else if (promote)
            yield* query(() =>
              tx.updateMany("apps", {
                where: (b) => b("id", "=", app.id),
                set: { activeDeployment: deployment.id, activatedSequence: sequence },
              }),
            );
          if (promote)
            yield* query(() =>
              tx.updateMany("profiles", {
                where: (b) =>
                  b.and(
                    b("app", "=", app.id),
                    b("status", "!=", "removed"),
                    b("status", "!=", "removing"),
                  ),
                set: { status: "pending", failure: null },
              }),
            );
          const projected = promote
            ? { ...app, requirements }
            : yield* project(tx, { ...existing, ...app });
          const deployedApp = yield* Schema.decodeUnknownEffect(DeployedApp)(projected).pipe(
            Effect.mapError(() => new StorageError()),
          );
          return { app: deployedApp, deployment };
        }),
      );
    }).pipe(Effect.withSpan("sdk.apps.deploy"));
  const copy = (input: Parameters<Executor["apps"]["copy"]>[0]) =>
    Effect.gen(function* () {
      const from = input.from;
      const snapshot: AppCopySnapshot =
        typeof from !== "string"
          ? "package" in from
            ? yield* resolvePublication(registry, from)
            : from
          : yield* Effect.gen(function* () {
              const parent = yield* storedApp(db, { app: from });
              if (parent.activeDeployment !== null) {
                const deployment = yield* storedDeployment(db, parent, parent.activeDeployment);
                return {
                  files: yield* readDeploymentSource(blobs, deployment.id),
                  origin: {
                    reference: `app:${parent.id}`,
                    name: parent.name,
                    commit: deployment.sourceCommit,
                  },
                  activation: "deploy" as const,
                };
              }
              const workspace =
                parent.repository === null
                  ? {
                      files: yield* readInitialSource(blobs, parent.code),
                      revision: { commit: null },
                    }
                  : yield* sources.workspace(parent.code);
              if (workspace === null) return yield* new SourceError({ reason: "not-found" });
              return {
                files: workspace.files,
                origin: {
                  reference: `app:${parent.id}`,
                  name: parent.name,
                  commit: workspace.revision.commit,
                },
                activation: "save" as const,
              };
            });
      const create = { owner: input.owner, name: input.name, files: snapshot.files };
      return snapshot.activation === "deploy"
        ? (yield* deploy(create, snapshot.origin)).app
        : yield* authoring.create(create, snapshot.origin);
    }).pipe(Effect.withSpan("sdk.apps.copy"));
  return {
    ...authoring,
    deploy: (input: DeployInput) => deploy(input),
    copy,
    get: (input: Parameters<Executor["apps"]["get"]>[0]) =>
      Effect.gen(function* () {
        const row = yield* query(() =>
          db.findFirst("apps", {
            join: (b) => b.deployment({ select: ["requirements"] }),
            where: (b) =>
              b.and(
                b("id", "=", input.app),
                input.owner === undefined ? true : b("owner", "=", input.owner),
              ),
          }),
        );
        if (row === null) return yield* new AppNotFound({ app: input.app });
        const { deployment, ...app } = row;
        return yield* projectedApp({ app, deployment });
      }).pipe(Effect.withSpan("sdk.apps.get")),
    list: (input: NonNullable<Parameters<Executor["apps"]["list"]>[0]> = {}) =>
      Effect.gen(function* () {
        const account = input.account;
        const installed =
          account === undefined
            ? []
            : yield* query(() =>
                db.findMany("profiles", {
                  select: ["app"],
                  where: (b) =>
                    b.and(
                      input.owner === undefined ? true : b("owner", "=", input.owner),
                      b("status", "!=", "removed"),
                      b("accounts", "json contains", account),
                    ),
                }),
              );
        const rows = yield* query(() =>
          db.findMany("apps", {
            join: (b) => b.deployment({ select: ["requirements"] }),
            where: (b) =>
              b.and(
                input.owner === undefined ? true : b("owner", "=", input.owner),
                input.ids === undefined ? true : b("id", "in", input.ids),
                input.name === undefined ? true : b("name", "=", input.name),
                input.slug === undefined ? true : b("slug", "=", input.slug),
                account === undefined
                  ? true
                  : b(
                      "id",
                      "in",
                      installed.map((item) => item.app),
                    ),
              ),
            orderBy: ["id", "asc"],
          }),
        );
        return yield* Effect.forEach(rows, ({ deployment, ...app }) =>
          projectedApp({ app, deployment }),
        );
      }).pipe(Effect.withSpan("sdk.apps.list")),
    rename: (input: Parameters<Executor["apps"]["rename"]>[0]) =>
      transaction(db, (tx) =>
        Effect.gen(function* () {
          const app = yield* lockApp(tx, input);
          const taken = yield* query(() =>
            tx.findFirst("apps", {
              where: (b) => b.and(b("owner", "=", app.owner), b("name", "=", input.name)),
            }),
          );
          if (taken !== null && taken.id !== app.id)
            return yield* new AppNameTaken({ owner: app.owner, name: input.name });
          const renamed = { ...app, name: input.name, slug: appSlug(input.name) };
          // The derived key and name move atomically; the unique constraint serializes colliding renames.
          yield* tx
            .updateMany("apps", {
              where: (b) => b("id", "=", app.id),
              set: { name: renamed.name, slug: renamed.slug },
            })
            .pipe(Effect.mapError(appWriteFailure(renamed)));
          return yield* project(tx, renamed);
        }),
      ).pipe(Effect.withSpan("sdk.apps.rename")),
    remove: (input: Parameters<Executor["apps"]["remove"]>[0]) =>
      transaction(db, (tx) =>
        Effect.gen(function* () {
          const app = yield* query(() =>
            tx.findFirst("apps", {
              where: (b) =>
                input.owner === undefined
                  ? b("id", "=", input.app)
                  : b.and(b("id", "=", input.app), b("owner", "=", input.owner)),
            }),
          );
          if (app !== null) {
            yield* query(() =>
              tx.updateMany("apps", {
                where: (b) => b("id", "=", app.id),
                set: { createdAt: app.createdAt },
              }),
            );
            const live = yield* query(() =>
              tx.findFirst("webhooks", {
                where: (b) => b.and(b("app", "=", app.id), b("status", "!=", "stopped")),
              }),
            );
            if (live !== null) return yield* new AppWebhooksActive({ app: app.id });
            const run = yield* query(() =>
              tx.findFirst("workflowRuns", {
                where: (b) =>
                  b.and(
                    b("app", "=", app.id),
                    b.or(b("status", "=", "queued"), b("status", "=", "running")),
                  ),
              }),
            );
            if (run !== null) return yield* new AppWorkflowsActive({ app: app.id });
            yield* query(() =>
              tx.deleteMany("workflowRuns", { where: (b) => b("app", "=", app.id) }),
            );

            yield* query(() => tx.deleteMany("webhooks", { where: (b) => b("app", "=", app.id) }));
            yield* query(() =>
              tx.deleteMany("appRecords", { where: (b) => b("app", "=", app.id) }),
            );
            yield* query(() =>
              tx.deleteMany("scheduledRuns", { where: (b) => b("app", "=", app.id) }),
            );
            yield* query(() => tx.deleteMany("schedules", { where: (b) => b("app", "=", app.id) }));
            yield* query(() => tx.deleteMany("profiles", { where: (b) => b("app", "=", app.id) }));
            yield* query(() =>
              tx.deleteMany("accountChecks", { where: (b) => b("app", "=", app.id) }),
            );
            yield* query(() => tx.deleteMany("apps", { where: (b) => b("id", "=", app.id) }));
          }
          return { app: input.app };
        }),
      ).pipe(Effect.withSpan("sdk.apps.remove")),
    activate: (input: Parameters<Executor["apps"]["activate"]>[0]) =>
      transaction(db, (tx) =>
        Effect.gen(function* () {
          const app = yield* lockApp(tx, input);
          if (
            input.expectedDeployment !== undefined &&
            app.activeDeployment !== input.expectedDeployment
          ) {
            return yield* Effect.fail(
              new AppDeploymentChanged({
                app: app.id,
                expected: input.expectedDeployment,
                current: app.activeDeployment,
              }),
            );
          }
          const deployment = yield* storedDeployment(tx, app, input.deployment);
          yield* query(() =>
            tx.updateMany("apps", {
              where: (b) => b("id", "=", app.id),
              set: {
                activeDeployment: deployment.id,
                deploySequence: app.deploySequence + 1,
                activatedSequence: app.deploySequence + 1,
              },
            }),
          );
          yield* query(() =>
            tx.updateMany("profiles", {
              where: (b) =>
                b.and(
                  b("app", "=", app.id),
                  b("status", "!=", "removed"),
                  b("status", "!=", "removing"),
                ),
              set: { status: "pending", failure: null },
            }),
          );
          return {
            ...Struct.omit(app, ["deploySequence", "activatedSequence"]),
            activeDeployment: deployment.id,
            requirements: deployment.requirements,
          };
        }),
      ).pipe(Effect.withSpan("sdk.apps.activate")),
    deployments: (input: Parameters<Executor["apps"]["deployments"]>[0]) =>
      transaction(db, (tx) =>
        Effect.gen(function* () {
          const app = yield* storedApp(tx, input);
          const rows = yield* query(() =>
            tx.findMany("deployments", {
              select: ["id", "code", "owner", "createdAt", "fileCount"],
              where: (b) =>
                b.and(
                  b("code", "=", app.code),
                  input.deploymentOwner === undefined
                    ? true
                    : b("owner", "=", input.deploymentOwner),
                ),
              orderBy: ["createdAt", "desc"],
            }),
          );
          const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(DeploymentSummary))(
            rows,
          ).pipe(Effect.mapError(() => new StorageError()));
          return decoded
            .toSorted(
              (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
            )
            .map((deployment): DeploymentSummary => ({
              id: deployment.id,
              code: deployment.code,
              owner: deployment.owner,
              createdAt: deployment.createdAt,
              fileCount: deployment.fileCount,
            }));
        }),
      ).pipe(Effect.withSpan("sdk.apps.deployments")),
    // Code identity and retained deployments are immutable. These bounded reads
    // need no BEGIN/COMMIT round trips; concurrent removal fails closed.
    deployment: (input: Parameters<Executor["apps"]["deployment"]>[0]) =>
      Effect.gen(function* () {
        const app = yield* storedApp(db, input);
        const version = yield* storedDeployment(db, app, input.deployment, input.deploymentOwner);
        return yield* Schema.decodeUnknownEffect(DeploymentMetadata)(version).pipe(
          Effect.mapError(() => new StorageError()),
        );
      }).pipe(Effect.withSpan("sdk.apps.deployment")),
    source: (input: Parameters<Executor["apps"]["source"]>[0]) =>
      transaction(db, (tx) =>
        Effect.gen(function* () {
          const app = yield* storedApp(tx, input);
          return yield* storedDeployment(tx, app, input.deployment, input.deploymentOwner);
        }),
      ).pipe(
        Effect.flatMap((deployment) =>
          readDeploymentSource(blobs, deployment.id).pipe(
            Effect.map((files) => Deployment.make({ ...deployment, files })),
            Effect.mapError(() => new StorageError()),
          ),
        ),
        Effect.withSpan("sdk.apps.source"),
      ),
  };
};
