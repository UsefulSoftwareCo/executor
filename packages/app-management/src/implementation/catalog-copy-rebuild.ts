/**
 * Rebuild untouched copies of official catalog apps from their own installed source on the target
 * `apps` release, once. See notes/catalog-copy-rebuild.md.
 *
 * Report mode reads only: the app, its version rows, its versions' source straight from the
 * host's store (`readVersionSource`, never `apps.source`, whose Cloud store fills a cache on a
 * miss), its `main` history (never the working tree, whose first read on Cloud stores a cache
 * object and can create the repository), the SQL rows of its background work, and a build that
 * keeps nothing (`apps.build`). Every write is in `apply` and `finish` below.
 *
 * Apply changes an app in several writes: deploy (which activates), then either a rollback or the
 * commit to `main`. It records `rebuilding` for the app once its check build passed, before the
 * deploy, so a pass that stopped part way, or a run whose pace stopped it before the deploy, finds
 * the record and finishes that app (`resume`) rather than reading the new version as someone
 * else's or building its check again.
 *
 * Apply runs in stages: each scope (`CatalogCopyRebuildScope`) is its own journal run, and copies
 * outside it are recorded `out-of-scope` without a read. An app an earlier stage left part way is
 * finished first, whatever the current scope.
 */
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

/**
 * The host services the step reads and writes through. A host lists the step only when it passes
 * `catalogCopyRebuild`: Cloud always, self-host when its operator turns it on, local never.
 */
export interface CatalogCopyRebuildHost {
  readonly executor: Executor;
  /** The host's own store of retained version source, without any cache in front of it. */
  readonly blobs: BlobStorage;
  readonly catalogCopyRebuild?: {
    /**
     * Called after a copy was rebuilt. Its new version leaves the app's webhook sources pending;
     * Cloud wakes their reconciliation here, and polling recovers a missed wake.
     */
    readonly rebuilt?: (app: App) => Effect.Effect<void, StorageError, SqlClient.SqlClient>;
    /** Which copies apply may change. Reports ignore it and cover every copy. */
    readonly scope: CatalogCopyRebuildScope;
    /**
     * The most compiler builds (check builds and deploys) one run of the step starts. It is asked
     * before each build: a run stops before a copy, or after a copy's check with `rebuilding`
     * recorded, and the next run resumes it. Only a host whose runs have a deadline paces (Cloud),
     * and e2e runs.
     */
    readonly pace?: number;
    /**
     * The pass from which an app still `failed` or `conflict` is recorded `gave-up`, and one still
     * `rebuilding` is recorded `unfinished`, so an outage that never ends completes the stage.
     */
    readonly passes: number;
  };
}

/**
 * Read a stage's scope (see {@link CatalogCopyRebuildScope}). Its run is named by a digest of the
 * scope's tokens, sorted and without repeats, so the same scope resumes the same stage.
 */
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
    // A maximum alone names no copies; say `all max:<n>` for any `n` copies.
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

/**
 * The in-progress outcome apply records once an app's check build passed, before its first write
 * to the app.
 */
const rebuilding = "rebuilding" satisfies CatalogCopyRebuildOutcome;
/** `rebuilding` past the host's retry bound; the next stage still finishes it. */
const unfinished = "unfinished" satisfies CatalogCopyRebuildOutcome;

/** The compiler builds one run of the step has started, which its pace counts. */
interface Compiler {
  builds: number;
  /** The most builds one run starts; unset, no bound. */
  readonly pace: number | undefined;
}

/** Whether the run's pace lets it start another compiler build. */
const admitted = (compiler: Compiler) =>
  compiler.pace === undefined || compiler.builds < compiler.pace;

/** The reviewed targets, imported when a pass lists its items, so they stay out of startup. */
const reviewedTargets = Effect.tryPromise({
  try: () => import("./catalog-copy-snapshots.ts"),
  catch: (cause) => cause,
}).pipe(Effect.map((module) => module.catalogCopyTargets));

const Busy = Schema.Array(Schema.Struct({ busy: Schema.Union([Schema.Boolean, Schema.Number]) }));

/**
 * Whether the app has background work a new version would reconcile: schedules, webhook
 * subscriptions, workflow runs or profiles. Read-only.
 */
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

/**
 * Whether a copy's origin is an install from an official app feed: a package in the catalog's
 * scope, recorded with the feed's own `apps/<id>.json` source document as its reference, as every
 * feed install has since the feed shipped. A copy of another app records `app:<id>` and the
 * parent's display name, which anyone can set, so it is not one.
 */
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

/** JSON with object keys sorted, so equal values compare equal whatever their key order. */
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

/**
 * Whether two versions declare the same requirements: each account requirement's name, scope,
 * cardinality and provider ID (which hashes the whole provider definition but its hosts and setup
 * help), and the same SQL, document store and events. Capabilities name what the framework
 * supports (`toolIndex`, `sharedDefinitions`, ...), so they differ between releases by design and
 * are not compared; neither are icons or an account check's presence, which change no fit.
 */
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
    // Builds before protocol 11 declare no events; an empty record declares none either.
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

/**
 * Whether a build failure says nothing about the source: the build could not install a
 * dependency, such as `apps` itself from an npm registry it cannot reach. Another pass retries it,
 * as it does a build the host's compiler or runner did not answer (`BuildUnanswered`).
 */
const unreachable = (error: VersionBuildFailed) => error.stage === "dependencies";

/**
 * The build of one upgraded source, by its digest. A pass builds each reviewed target once however
 * many copies hold it. A build that failed for a reason outside the source is not kept, so the
 * next copy, and the next pass, tries again.
 */
type Built =
  | { readonly kind: "built"; readonly requirements: AppRequirements }
  | { readonly kind: "build-failed" };

type Target = { readonly owner: App["owner"]; readonly app: App["id"] };

/** A retained version with its requirements and files, read past any cache. */
const retained = (host: CatalogCopyRebuildHost, target: Target, version: VersionId) =>
  Effect.gen(function* () {
    const row = yield* host.executor.apps.version({ ...target, version });
    const files = yield* readVersionSource(host.blobs, row.id);
    return { id: row.id, requirements: row.requirements, files };
  });

/** The app's versions, oldest first. The first holds the files the install copied. */
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
  // An earlier apply, of this stage or an earlier one, recorded that it was changing this app
  // and stopped before its outcome. It is finished whatever this stage's scope.
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
    // The running files' own package is the identity the reviewed digest below covers.
    const pkg = declaredPackage(running.files);
    if (pkg === undefined || pkg !== app.copiedFrom?.name) return "not-catalog" as const;
    if (catalogCopyHeldPackages.includes(pkg)) return "held-tool-names" as const;
    const from = declaredRelease(running.files);
    if (from === undefined) return "unmapped" as const;
    const order = compareReleases(from, catalogCopyRebuildTargetRelease);
    if (order === undefined) return "unmapped" as const;
    if (order >= 0) return "current" as const;

    // Untouched: the running source is the app's first version's, the install's files.
    const first = (yield* oldestFirst(host, target))[0];
    if (first === undefined) return "conflict" as const;
    const installed = first.id === running.id ? running : yield* retained(host, target, first.id);
    if (!sourceFilesEqual(installed.files, running.files)) return "edited" as const;

    // Only the reviewed upgrade of a published catalog snapshot is ever deployed.
    // An unmapped install is logged by its package, release and digest only (catalog content, no
    // identity), so its snapshot can be reviewed and added to the targets by a later step.
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

    // And `main` holds only the install: a repository not created yet starts from the install's
    // files, and one created has only its first commit. History is read, never the working tree.
    if (app.repository !== null && (yield* host.executor.apps.history(target)).length !== 1)
      return "edited" as const;

    if (yield* backgroundWork(app)) return "background-work" as const;
    const addsTools = catalogCopyToolsAddedPackages.includes(pkg);

    // An app finished from its record passed its check build before the record was made (below),
    // so it is not built again: a pace of one build per run then still deploys it. The deploy's
    // own requirements check (`finish`) still guards it.
    if (!resuming) {
      // The build keeps nothing; it says whether the upgrade builds and what it declares.
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
      // The check passed. Recorded now, a run whose pace stops the app before its deploy, or one
      // that stops part way, leaves the app for the next pass to finish from here.
      yield* progress.record(rebuilding);
    }

    // Apply. The deploy is a build the pace counts; a run with none left stops here, before the
    // app's working tree is read, and the next run deploys it.
    if (!admitted(compiler)) return dataStepPaused;
    // Main is read now (this may create the repository from the install's files).
    const workspace = yield* host.executor.apps.workspace(target);
    if (!sourceFilesEqual(workspace.files, running.files)) return "edited" as const;
    // Background work may have started since the check above; the build took a while.
    if (yield* backgroundWork(app)) return "background-work" as const;
    compiler.builds += 1;
    yield* Effect.log("Catalog copy rebuild started", {
      app: listed.id,
      replaced: running.id,
      from,
      to: catalogCopyRebuildTargetRelease,
    });
    // Only over the version checked above, with nothing activated meanwhile; otherwise nothing
    // is recorded and the app is someone else's again (`conflict`).
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
            // Nothing was activated; the next pass builds it again (and checks it again first,
            // unless it is being finished from its record).
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
    // One unavailable repository, store or build service must not stop the rest; a later pass
    // retries it.
    Effect.catch((error) =>
      Effect.logWarning("Catalog copy rebuild failed", listed.id, error).pipe(
        Effect.as("failed" as const),
      ),
    ),
    // A failure, even reading the app, says nothing about how far the earlier rebuild got. Its
    // record stands until an outcome shows what the app runs, so the next pass of any stage
    // finishes it rather than reading the new version as `current` or leaving it `out-of-scope`.
    Effect.map((outcome): CatalogCopyRebuildOutcome | typeof dataStepPaused =>
      resuming && outcome === "failed" ? rebuilding : outcome,
    ),
    Effect.withSpan("apps.catalog_rebuild.app", {
      attributes: { "app.id": listed.id, "apps.catalog_rebuild.mode": mode },
    }),
  );
};

/**
 * After the deploy, any failure leaves the app part way: the outcome stays `rebuilding`, so the
 * next pass finishes it. A concurrent activation is someone else's choice and is left alone.
 */
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

/**
 * Finish a rebuild whose version is active: compare its requirements with the replaced version's
 * and activate the replaced one again if they differ, or record what now runs on `main`.
 */
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
    // A deploy activates its version at once. If it declares other requirements after all, the
    // replaced version is activated again before anything else reads the app's accounts, guarded
    // by this step's own version.
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
    // The IDs an operator needs to undo this app: activate `replaced` with `expectedVersion`
    // set to `version`.
    yield* Effect.log("Catalog copy rebuilt", {
      ...ids,
      from: rebuild.from,
      to: catalogCopyRebuildTargetRelease,
    });
    if (host.catalogCopyRebuild?.rebuilt !== undefined) yield* host.catalogCopyRebuild.rebuilt(app);
    // Main gets what now runs, on the revision just read, if it still holds the install's files.
    // Other files on main are someone's work since and are kept.
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
            : // A conflict means main moved, unless it did not: then the write itself failed.
              host.executor.apps
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

/**
 * Finish an app an earlier apply recorded it was rebuilding. If the app runs the install's files,
 * the rebuild never activated or its rollback finished, and it is handled from the start
 * (`restart`). If it runs the upgrade of the install's files, the rebuild activated: finish it
 * against the newest earlier version that holds the install's files, the one it replaced. Any
 * other files are someone's deploy since; the app is theirs.
 */
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
      // `deployReplacing` records a version only when it activates it. A retained version with
      // the upgraded files means the rebuild ran and the install's files were put back since,
      // by the step's own rollback or by someone's undo: that choice stands.
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

/**
 * The step over every catalog copy on this host. Each app is safe to handle again: a rebuilt app
 * reads as `current`, an app part way through is finished from its `rebuilding` record, and the
 * commit names the revision it was based on.
 */
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
