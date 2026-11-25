import {
  readVersionSource,
  sourceFilesEqual,
  type App,
  type AppCopyOrigin,
  type AppRequirements,
  type BlobStorage,
  type Executor,
  type SourceFiles,
  type StorageError,
  type VersionBuildFailed,
  type VersionId,
} from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
  dataStepPaused,
  type DataStep,
  type DataStepItemProgress,
  type DataStepMode,
} from "../contracts/data-steps.ts";
import {
  CatalogCopyRebuildScopeInvalid,
  catalogCopyRebuildChanged,
  catalogCopyHeldPackages,
  catalogCopyRebuildMessage,
  catalogCopyRebuildTargetRelease,
  catalogCopyToolsAddedPackages,
  catalogPackageScope,
  type CatalogCopyRebuildOutcome,
  type CatalogCopyRebuildScope,
} from "../contracts/catalog-copy-rebuild.ts";
import {
  compareReleases,
  declaredPackage,
  declaredRelease,
  sourceDigest,
  upgradedFiles,
} from "./catalog-copy-upgrade.ts";

export interface CatalogCopyRebuildHost {
  readonly executor: Executor;
  readonly blobs: BlobStorage;
  readonly catalogCopyRebuild?: {
    readonly rebuilt?: (app: App) => Effect.Effect<void, StorageError, SqlClient.SqlClient>;
    readonly scope: CatalogCopyRebuildScope;
    readonly pace?: number;
    readonly passes: number;
  };
}

export const catalogCopyRebuildScope = (text: string) =>
  Effect.gen(function* () {
    const tokens = [...new Set(text.split(/[\s,]+/u).filter((token) => token !== ""))].toSorted();
    const owners = new Set<string>();
    const apps = new Set<string>();
    let all = false;
    let max: number | undefined;
    for (const token of tokens) {
      const [kind, value = "", ...rest] = token.split(":");
      if (token === "all") all = true;
      else if (kind === "organization" && value !== "" && rest.length === 0) owners.add(token);
      else if (kind === "app" && value !== "" && rest.length === 0) apps.add(value);
      else if (kind === "max" && /^\d+$/u.test(value) && rest.length === 0 && max === undefined)
        max = Number(value);
      else return yield* new CatalogCopyRebuildScopeInvalid({ token });
    }
    if (max !== undefined && !all && owners.size === 0 && apps.size === 0)
      return yield* new CatalogCopyRebuildScopeInvalid({ token: `max:${max}` });
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokens.join(" "))),
    );
    const hex = Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const scope: CatalogCopyRebuildScope = {
      run: `apply:scope-${hex}`,
      all,
      owners,
      apps,
      max,
    };
    return scope;
  });

const inScope = (scope: CatalogCopyRebuildScope, app: App) =>
  scope.all || scope.owners.has(app.owner) || scope.apps.has(app.id);

const rebuilding = "rebuilding" satisfies CatalogCopyRebuildOutcome;
const unfinished = "unfinished" satisfies CatalogCopyRebuildOutcome;

interface Compiler {
  builds: number;
  readonly pace: number | undefined;
}

const admitted = (compiler: Compiler) =>
  compiler.pace === undefined || compiler.builds < compiler.pace;

const reviewedTargets = Effect.tryPromise({
  try: () => import("./catalog-copy-snapshots.ts"),
  catch: (cause) => cause,
}).pipe(Effect.map((module) => module.catalogCopyTargets));

const Busy = Schema.Array(Schema.Struct({ busy: Schema.Union([Schema.Boolean, Schema.Number]) }));

const backgroundWork = (app: App) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`select (
        exists (select 1 from executor_schedules where app = ${app.id})
        or exists (select 1 from executor_webhooks where app = ${app.id})
        or exists (select 1 from executor_workflow_runs where app = ${app.id})
        or exists (select 1 from executor_installations where app = ${app.id})
      ) as busy`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Busy)));
    const busy = rows[0]?.busy;
    return busy === true || busy === 1;
  });

const catalogInstall = (origin: AppCopyOrigin | null) => {
  if (origin === null || !origin.name.startsWith(catalogPackageScope)) return false;
  const reference = URL.parse(origin.reference);
  return (
    reference !== null &&
    (reference.protocol === "https:" || reference.protocol === "http:") &&
    reference.search === "" &&
    reference.hash === "" &&
    /\/apps\/[^/]+\.json$/u.test(reference.pathname)
  );
};

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).toSorted(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : item,
  );

export const sameRequirements = (running: AppRequirements, rebuilt: AppRequirements) => {
  const accounts = (requirements: AppRequirements) =>
    Object.fromEntries(
      Object.entries(requirements.accounts).map(([name, requirement]) => [
        name,
        {
          scope: requirement.scope,
          provider: requirement.provider,
          cardinality: requirement.cardinality,
        },
      ]),
    );
  const rest = (requirements: AppRequirements) => ({
    sql: requirements.sql ?? false,
    database: requirements.database ?? null,
    events:
      requirements.events === undefined || Object.keys(requirements.events).length === 0
        ? null
        : requirements.events,
  });
  return (
    canonical(accounts(running)) === canonical(accounts(rebuilt)) &&
    canonical(rest(running)) === canonical(rest(rebuilt))
  );
};

const unreachable = (error: VersionBuildFailed) => error.stage === "dependencies";

type Built =
  | { readonly kind: "built"; readonly requirements: AppRequirements }
  | { readonly kind: "build-failed" };

type Target = { readonly owner: App["owner"]; readonly app: App["id"] };

const retained = (host: CatalogCopyRebuildHost, target: Target, version: VersionId) =>
  Effect.gen(function* () {
    const row = yield* host.executor.apps.version({ ...target, version });
    const files = yield* readVersionSource(host.blobs, row.id);
    return { id: row.id, requirements: row.requirements, files };
  });

const oldestFirst = (host: CatalogCopyRebuildHost, target: Target) =>
  host.executor.apps
    .versions(target)
    .pipe(
      Effect.map((versions) =>
        versions.toSorted(
          (left, right) =>
            left.createdAt.getTime() - right.createdAt.getTime() ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        ),
      ),
    );

const rebuildApp = (
  host: CatalogCopyRebuildHost,
  listed: App,
  mode: DataStepMode,
  progress: DataStepItemProgress,
  targets: ReadonlySet<string>,
  builds: Map<string, Built>,
  compiler: Compiler,
) => {
  const resuming =
    mode === "apply" && (progress.previous === rebuilding || progress.previous === unfinished);
  return Effect.gen(function* () {
    const target = { owner: listed.owner, app: listed.id };
    if (mode === "apply" && !resuming) {
      const scope = host.catalogCopyRebuild?.scope;
      if (scope === undefined || !inScope(scope, listed)) return "out-of-scope" as const;
      if (
        scope.max !== undefined &&
        (yield* progress.count(catalogCopyRebuildChanged)) >= scope.max
      )
        return "out-of-scope" as const;
    }
    const app = yield* host.executor.apps.get(target);
    if (app.activeVersion === null) return "undeployed" as const;
    if (!catalogInstall(app.copiedFrom)) return "not-catalog" as const;
    if (resuming) {
      const resumed = yield* resume(host, app, target);
      if (resumed !== "restart") return resumed;
    }
    const running = yield* retained(host, target, app.activeVersion);
    const pkg = declaredPackage(running.files);
    if (pkg === undefined || pkg !== app.copiedFrom?.name) return "not-catalog" as const;
    if (catalogCopyHeldPackages.includes(pkg)) return "held-tool-names" as const;
    const from = declaredRelease(running.files);
    if (from === undefined) return "unmapped" as const;
    const order = compareReleases(from, catalogCopyRebuildTargetRelease);
    if (order === undefined) return "unmapped" as const;
    if (order >= 0) return "current" as const;

    const first = (yield* oldestFirst(host, target))[0];
    if (first === undefined) return "conflict" as const;
    const installed = first.id === running.id ? running : yield* retained(host, target, first.id);
    if (!sourceFilesEqual(installed.files, running.files)) return "edited" as const;

    const next = upgradedFiles(running.files, catalogCopyRebuildTargetRelease);
    if (next === undefined) {
      yield* Effect.log("Catalog copy has no recognized upgrade", { package: pkg, from });
      return "unmapped" as const;
    }
    const digest = yield* sourceDigest(next);
    if (!targets.has(digest)) {
      yield* Effect.log("Catalog copy has no reviewed target", { package: pkg, from, digest });
      return "unmapped" as const;
    }

    if (app.repository !== null && (yield* host.executor.apps.history(target)).length !== 1)
      return "edited" as const;

    if (yield* backgroundWork(app)) return "background-work" as const;
    const addsTools = catalogCopyToolsAddedPackages.includes(pkg);

    if (!resuming) {
      const cached = builds.get(digest);
      if (cached === undefined) {
        if (!admitted(compiler)) return dataStepPaused;
        compiler.builds += 1;
      }
      const built: Built | undefined =
        cached ??
        (yield* host.executor.apps.build({ owner: app.owner, name: app.name, files: next }).pipe(
          Effect.map((result): Built => ({ kind: "built", requirements: result.requirements })),
          Effect.catchTags({
            VersionBuildFailed: (error) =>
              unreachable(error)
                ? Effect.logWarning("Catalog copy check build could not install a dependency", {
                    app: listed.id,
                    message: error.message,
                  }).pipe(Effect.as(undefined))
                : Effect.succeed<Built>({ kind: "build-failed" }),
            BuildMemoryExceeded: () => Effect.succeed<Built>({ kind: "build-failed" }),
            BuildUnanswered: () =>
              Effect.logWarning(
                "Catalog copy check build had no answer from the compiler or runner",
                {
                  app: listed.id,
                },
              ).pipe(Effect.as(undefined)),
          }),
          Effect.catch((error) =>
            Effect.logWarning("Catalog copy check build failed", listed.id, error).pipe(
              Effect.as(undefined),
            ),
          ),
        ));
      if (built === undefined) return "failed" as const;
      builds.set(digest, built);
      if (built.kind === "build-failed") return "build-failed" as const;
      if (!sameRequirements(running.requirements, built.requirements))
        return "requirements-changed" as const;
      if (mode === "report")
        return addsTools ? ("rebuild-adds-tools" as const) : ("rebuild" as const);
      yield* progress.record(rebuilding);
    }

    if (!admitted(compiler)) return dataStepPaused;
    const workspace = yield* host.executor.apps.workspace(target);
    if (!sourceFilesEqual(workspace.files, running.files)) return "edited" as const;
    if (yield* backgroundWork(app)) return "background-work" as const;
    compiler.builds += 1;
    yield* Effect.log("Catalog copy rebuild started", {
      app: listed.id,
      replaced: running.id,
      from,
      to: catalogCopyRebuildTargetRelease,
    });
    return yield* Effect.gen(function* () {
      const deployed = yield* host.executor.apps
        .deployReplacing({ ...target, files: next, expectedVersion: running.id })
        .pipe(
          Effect.catchTags({
            VersionBuildFailed: (error) =>
              Effect.logWarning("Catalog copy does not build on the target release", {
                app: listed.id,
                message: error.message,
              }).pipe(
                Effect.as(unreachable(error) ? ("failed" as const) : ("build-failed" as const)),
              ),
            BuildUnanswered: () =>
              Effect.logWarning("Catalog copy build had no answer from the compiler or runner", {
                app: listed.id,
              }).pipe(Effect.as("failed" as const)),
          }),
        );
      if (typeof deployed === "string") return deployed;
      if (deployed.app.activeVersion !== deployed.version.id) return "conflict" as const;
      return yield* finish(host, deployed.app, {
        replaced: running,
        version: { id: deployed.version.id, requirements: deployed.app.requirements },
        installed: installed.files,
        next,
        from,
        addsTools,
      });
    }).pipe(keepIntent(listed));
  }).pipe(
    Effect.catchTag("AppNotFound", () => Effect.succeed("removed" as const)),
    Effect.tap((outcome) => Effect.annotateCurrentSpan("apps.catalog_rebuild.outcome", outcome)),
    Effect.catch((error) =>
      Effect.logWarning("Catalog copy rebuild failed", listed.id, error).pipe(
        Effect.as("failed" as const),
      ),
    ),
    Effect.map((outcome): CatalogCopyRebuildOutcome | typeof dataStepPaused =>
      resuming && outcome === "failed" ? rebuilding : outcome,
    ),
    Effect.withSpan("apps.catalog_rebuild.app", {
      attributes: { "app.id": listed.id, "apps.catalog_rebuild.mode": mode },
    }),
  );
};

const keepIntent =
  (listed: App) =>
  <A extends CatalogCopyRebuildOutcome | "restart", E extends { readonly _tag: string }, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A | "removed" | "conflict" | typeof rebuilding, never, R> =>
    effect.pipe(
      Effect.catch((error): Effect.Effect<"removed" | "conflict" | typeof rebuilding> =>
        error._tag === "AppNotFound"
          ? Effect.succeed("removed" as const)
          : error._tag === "AppVersionChanged"
            ? Effect.succeed("conflict" as const)
            : Effect.logWarning(
                "Catalog copy rebuild stopped part way; the next pass finishes it",
                { app: listed.id, error },
              ).pipe(Effect.as(rebuilding)),
      ),
    );

const finish = (
  host: CatalogCopyRebuildHost,
  app: App,
  rebuild: {
    readonly replaced: { readonly id: VersionId; readonly requirements: AppRequirements };
    readonly version: { readonly id: VersionId; readonly requirements: AppRequirements };
    readonly installed: SourceFiles;
    readonly next: SourceFiles;
    readonly from: string;
    readonly addsTools: boolean;
  },
) =>
  Effect.gen(function* () {
    const target = { owner: app.owner, app: app.id };
    const ids = { app: app.id, replaced: rebuild.replaced.id, version: rebuild.version.id };
    if (!sameRequirements(rebuild.replaced.requirements, rebuild.version.requirements)) {
      yield* host.executor.apps.activate({
        ...target,
        version: rebuild.replaced.id,
        expectedVersion: rebuild.version.id,
      });
      yield* Effect.logWarning(
        "Catalog copy rebuild declared other requirements; rolled back",
        ids,
      );
      return "rolled-back" as const;
    }
    yield* Effect.log("Catalog copy rebuilt", {
      ...ids,
      from: rebuild.from,
      to: catalogCopyRebuildTargetRelease,
    });
    if (host.catalogCopyRebuild?.rebuilt !== undefined) yield* host.catalogCopyRebuild.rebuilt(app);
    const outcome = rebuild.addsTools ? ("rebuilt-adds-tools" as const) : ("rebuilt" as const);
    const main = yield* host.executor.apps.workspace(target);
    if (sourceFilesEqual(main.files, rebuild.next)) return outcome;
    if (!sourceFilesEqual(main.files, rebuild.installed)) {
      yield* Effect.logWarning("Catalog copy main holds other work; kept", ids);
      return outcome;
    }
    yield* host.executor.apps
      .commit({
        ...target,
        expected: main.revision.commit,
        files: rebuild.next,
        message: catalogCopyRebuildMessage(rebuild.from, catalogCopyRebuildTargetRelease),
      })
      .pipe(
        Effect.catchTag("SourceError", (error) =>
          error.reason !== "conflict"
            ? Effect.fail(error)
            : host.executor.apps
                .workspace(target)
                .pipe(
                  Effect.flatMap((now) =>
                    now.revision.commit === main.revision.commit
                      ? Effect.fail(error)
                      : Effect.logWarning(
                          "Catalog copy main changed during its rebuild; kept",
                          ids,
                        ),
                  ),
                ),
        ),
      );
    return outcome;
  });

const resume = (host: CatalogCopyRebuildHost, app: App, target: Target) =>
  Effect.gen(function* () {
    if (app.activeVersion === null) return "undeployed" as const;
    const versions = yield* oldestFirst(host, target);
    const first = versions[0];
    if (first === undefined) return "conflict" as const;
    const installed = yield* retained(host, target, first.id);
    const active = yield* retained(host, target, app.activeVersion);
    const from = declaredRelease(installed.files);
    const next = upgradedFiles(installed.files, catalogCopyRebuildTargetRelease);
    if (from === undefined || next === undefined) return "edited" as const;
    if (sourceFilesEqual(active.files, installed.files)) {
      for (const version of versions.toReversed()) {
        if (version.id === active.id) continue;
        if (sourceFilesEqual((yield* retained(host, target, version.id)).files, next)) {
          yield* Effect.logWarning("Catalog copy rebuild was undone before it finished; left", {
            app: app.id,
            version: version.id,
          });
          return "rolled-back" as const;
        }
      }
      return "restart" as const;
    }
    if (!sourceFilesEqual(active.files, next)) return "edited" as const;
    const activeAt = versions.find((version) => version.id === active.id)?.createdAt.getTime();
    let replaced: Effect.Success<ReturnType<typeof retained>> | undefined;
    for (const version of versions.toReversed()) {
      if (activeAt === undefined || version.createdAt.getTime() >= activeAt) continue;
      const candidate = yield* retained(host, target, version.id);
      if (sourceFilesEqual(candidate.files, installed.files)) {
        replaced = candidate;
        break;
      }
    }
    if (replaced === undefined) return "edited" as const;
    yield* Effect.log("Catalog copy rebuild resumed", {
      app: app.id,
      replaced: replaced.id,
      version: active.id,
    });
    const pkg = declaredPackage(installed.files);
    return yield* finish(host, app, {
      replaced,
      version: active,
      installed: installed.files,
      next,
      from,
      addsTools: pkg !== undefined && catalogCopyToolsAddedPackages.includes(pkg),
    });
  }).pipe(keepIntent(app));

export const catalogCopyRebuildStep = (
  host: CatalogCopyRebuildHost,
  name: string,
): DataStep<SqlClient.SqlClient> => {
  const builds = new Map<string, Built>();
  const settings = host.catalogCopyRebuild;
  const pace = settings?.pace;
  const compiler: Compiler = { builds: 0, pace };
  return {
    name,
    retry: ["conflict", "failed", rebuilding],
    expected: ["conflict"],
    ...(settings === undefined
      ? {}
      : {
          applyRun: settings.scope.run,
          exhausted: {
            passes: settings.passes,
            outcomes: { failed: "gave-up", conflict: "gave-up", [rebuilding]: unfinished },
          },
        }),
    ...(pace === undefined ? {} : { more: Effect.sync(() => admitted(compiler)) }),
    items: Effect.gen(function* () {
      const apps = yield* host.executor.apps.list({});
      const targets = yield* reviewedTargets;
      return apps
        .filter((app) => app.copiedFrom?.name.startsWith(catalogPackageScope) === true)
        .map((app) => ({
          id: app.id,
          owner: app.owner,
          run: (mode: DataStepMode, progress: DataStepItemProgress) =>
            rebuildApp(host, app, mode, progress, targets, builds, compiler),
        }));
    }),
  };
};
