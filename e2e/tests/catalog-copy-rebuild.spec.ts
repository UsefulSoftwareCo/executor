/**
 * Installed catalog copies keep the `apps` framework they were built with, so a framework fix
 * (E-042's account merge, in beta.140) never reaches them. The one-off
 * `13_rebuild_catalog_copies_on_current_apps` data step rebuilds untouched copies from their own
 * installed source on beta.140 with only the reviewed upgrade, and leaves every other copy alone.
 *
 * Self-host lists the step only when its operator turns it on; these scenarios start the product
 * with it on and data steps held in report mode. They install real Popupsmart sources from the
 * catalog's history through the official feed: the October source (beta.88, before requirements
 * had scopes) and the November source (beta.100).
 *
 * The first scenario adds the October source redeployed with an edit, and with an edit committed
 * to `main`; the October source with an edited README, which is no published snapshot; a stand-in
 * for a package whose tool names change on beta.140; a synthetic app on the host's release; and a
 * copy of an app the organization deployed itself under a catalog package's name, which is no
 * catalog install. A report start writes nothing: the rows of every table the step could touch
 * hash the same before and after it. An apply start rebuilds the two untouched copies to exactly
 * the files the catalog's own move to beta.100 wrote, with the pin on beta.140, and keeps their
 * requirements, provider IDs, linked accounts and tools (names, descriptions, output schemas and
 * the input each account takes); every other copy is unchanged. Activating the replaced version
 * restores the October source with the same accounts and tools, and a later start changes
 * nothing.
 *
 * The others break an apply part way, as the product's own storage and network can: an npm
 * registry out of reach, a compiler that does not answer, an activation that lands while the step
 * builds, and a `main` commit that fails after the deploy. Each copy is left as its owner would expect, and the next start finishes
 * what the step began, even when that start's stage no longer covers it.
 *
 * Apply runs in stages. Each scope the operator sets is its own run: copies outside it are left
 * exactly as they were and stay eligible, a finished stage does not run again, and a wider stage
 * rebuilds the rest. An outage that never ends gives up after three starts, so the host finishes
 * its data steps; the next stage tries those copies again. A copy left part way stays to be
 * finished through a failed read, the bound and a stage that does not name it.
 *
 * A paced run (an e2e-only setting on self-host, as Cloud paces each tick) starts no more compiler
 * builds than its pace: at one build a start, a copy is checked at one start and deployed at the
 * next.
 */
import { expect, layer } from "@effect/vitest";
import { Config, Effect, FileSystem, Schema } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { Committed, Workspace } from "../support/app-authoring.ts";
import { serverControl } from "../support/server-control.ts";
import { dataStepSummaries, nextDataStepSummary } from "../support/data-steps.ts";
import { appsVersion, declaredApps } from "../support/apps-release.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { Resource } from "../support/contracts.ts";
import { linkedAccountIds } from "../support/app-accounts.ts";
import {
  catalogSnapshotFiles,
  catalogSnapshots,
  officialApps,
} from "../support/public-catalogs.ts";

const step = "13_rebuild_catalog_copies_on_current_apps";
/** The release the step rebuilds on. */
const targetRelease = "0.0.1-beta.140";
const october = "0.0.1-beta.88";
const november = "0.0.1-beta.100";

/** The journal run of the apply stage with this scope, named as the product names it. */
const stageRun = (scope: string) => {
  const tokens = [...new Set(scope.split(/[\s,]+/u).filter((token) => token !== ""))].toSorted();
  const hex = createHash("sha256").update(tokens.join(" ")).digest("hex").slice(0, 16);
  return `apply:scope-${hex}`;
};

type Files = ReadonlyArray<{ readonly path: string; readonly content: string }>;
const sorted = (files: Files) => files.toSorted((left, right) => (left.path < right.path ? -1 : 1));
/** `files` with only the manifest's `apps` release changed, in place. */
const repinned = (files: Files, from: string, to: string): Files =>
  files.map((file) =>
    file.path === "package.json"
      ? { ...file, content: file.content.replace(`"apps": "${from}"`, `"apps": "${to}"`) }
      : file,
  );
/** What a rebuilt October or November copy runs and holds on `main`: the catalog's own move. */
const rebuiltFiles = () =>
  sorted(repinned(catalogSnapshotFiles(catalogSnapshots.november.id), november, targetRelease));
const octoberFiles = () => sorted(catalogSnapshotFiles(catalogSnapshots.october.id));

const Requirement = Schema.Struct({
  provider: Schema.String,
  scope: Schema.String,
  cardinality: Schema.String,
});
const App = Schema.Struct({
  id: Schema.String,
  code: Schema.String,
  name: Schema.String,
  activeVersion: Schema.NullOr(Schema.String),
  requirements: Schema.Struct({ accounts: Schema.Record(Schema.String, Requirement) }),
});
type App = typeof App.Type;
const Versions = Schema.Array(Schema.Struct({ id: Schema.String }));
const RunningSource = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
/** A page of the tool listing: each tool's name, kind, description and schemas. */
const Tools = Schema.Struct({
  items: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  next: Schema.optional(Schema.String),
});
const Sum = Schema.Struct({ sum: Schema.String });

type Json = { readonly [key: string]: unknown };
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** JSON with object keys sorted and empty `$defs` left out, so equal schemas compare equal. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : isObject(value)
      ? Object.fromEntries(
          Object.entries(value)
            .filter(
              ([key, item]) =>
                !(key === "$defs" && isObject(item) && Object.keys(item).length === 0),
            )
            .toSorted(([left], [right]) => (left < right ? -1 : 1))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
/**
 * An account router's input schema as account ID -> the input that account takes. Each branch
 * names its accounts as `accountId`'s `const` or `enum`.
 */
const inputsByAccount = (schema: unknown) => {
  const branches = isObject(schema) && Array.isArray(schema.anyOf) ? schema.anyOf : [schema];
  const inputs: Record<string, string> = {};
  for (const branch of branches) {
    if (!isObject(branch) || !isObject(branch.properties)) return JSON.stringify(canonical(schema));
    const { accountId, ...properties } = branch.properties;
    const ids = !isObject(accountId)
      ? []
      : typeof accountId.const === "string"
        ? [accountId.const]
        : Array.isArray(accountId.enum)
          ? accountId.enum
          : [];
    const input = JSON.stringify(canonical({ ...branch, properties }));
    for (const id of ids) inputs[String(id)] = input;
  }
  return Object.keys(inputs).length === 0
    ? JSON.stringify(canonical(schema))
    : JSON.stringify(canonical(inputs));
};

/** The product's API for the organization's apps, and the step's log, for one scenario. */
const rebuildFixture = Effect.gen(function* () {
  const actors = yield* Actors;
  const api = yield* Api;
  const target = yield* Target;
  const log = `${target.directory}/server.log`;
  const organization = actors.organization.id;
  const owner = `organization:${organization}`;
  const prefix = `/api/organizations/${organization}`;
  const request = (method: "GET" | "POST" | "DELETE", path: string, data?: unknown) =>
    api.request(actors.owner, method, `${prefix}${path}`, data);
  const ok = <A>(schema: Schema.ConstraintDecoder<A, never>) =>
    Effect.flatMap((response: { readonly status: number; readonly body: unknown }) => {
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return body(schema, response);
    });
  const created: App[] = [];
  yield* Effect.addFinalizer(() =>
    Effect.forEach(created, (app) => request("DELETE", `/apps/${app.id}`)).pipe(Effect.ignore),
  );
  const remember = (app: App) => Effect.sync(() => created.push(app));
  const install = (entry: string, name: string) =>
    request("POST", "/apps/install", {
      entry,
      name: `${name} ${randomUUID().slice(0, 8)}`,
    }).pipe(ok(App), Effect.tap(remember));
  const get = (app: App) => request("GET", `/apps/${app.id}`).pipe(ok(App));
  const workspace = (app: App) => request("GET", `/apps/${app.id}/workspace`).pipe(ok(Workspace));
  const main = (app: App) => workspace(app).pipe(Effect.map((source) => sorted(source.files)));
  const running = (app: App) =>
    request("GET", `/apps/${app.id}/source`).pipe(
      ok(RunningSource),
      Effect.map((result) => sorted(result.files)),
    );
  const versions = (app: App) =>
    request("GET", `/apps/${app.id}/versions`).pipe(
      ok(Versions),
      Effect.map((list) => list.map((version) => version.id).toSorted()),
    );
  const summaries = dataStepSummaries(log, step).pipe(Effect.map((all) => all.length));
  /** Run `start` and return the summary the step's pass logged in it. */
  const nextSummary = <E, R>(start: Effect.Effect<void, E, R>) =>
    Effect.gen(function* () {
      const seen = yield* summaries;
      yield* start;
      return yield* nextDataStepSummary(log, step, seen);
    });
  /** Stop the product and have its later starts apply data steps. */
  const holdApply = Effect.gen(function* () {
    yield* serverControl("stop");
    yield* serverControl("data-steps", 200, { mode: "apply" });
  });

  const links = (app: App) => linkedAccountIds(actors.owner, `${prefix}/apps/${app.id}`);

  /** A synthetic account connected from `app`, which links it for the app's requirement. */
  const connect = (app: App, label: string) =>
    Effect.gen(function* () {
      const pending = yield* request(
        "POST",
        `/apps/${app.id}/accounts/user/popupsmart/connections`,
        {},
      ).pipe(ok(Resource));
      const account = (yield* request("POST", `/connections/${pending.id}/submit`, {
        method: "apiKey",
        label,
        fields: { token: `synthetic-${randomUUID()}` },
      }).pipe(ok(Resource))).id;
      yield* Effect.addFinalizer(() =>
        request("DELETE", `/accounts/${account}`).pipe(Effect.ignore),
      );
      return account;
    });

  // The product started with the step on and held, so it reported before these apps existed.
  expect(yield* nextDataStepSummary(log, step, 0)).toMatchObject({
    mode: "report",
    status: "complete",
  });
  return {
    actors,
    target,
    owner,
    prefix,
    request,
    ok,
    remember,
    install,
    get,
    workspace,
    main,
    running,
    versions,
    summaries,
    nextSummary,
    holdApply,
    links,
    connect,
  };
});

layer(HostedLive, { excludeTestServices: true })("Catalog copy rebuild data step", (it) => {
  it.effect(
    scenarios.catalogCopyRebuild.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const {
            owner,
            request,
            ok,
            remember,
            install,
            get,
            workspace,
            main,
            running,
            versions,
            summaries,
            nextSummary,
            holdApply,
            links,
            connect,
          } = yield* rebuildFixture;
          /**
           * Every tool by name, with what each linked account accepts. beta.140's account router
           * merges accounts whose input is the same into one branch (`accountId` an `enum` rather
           * than one `const` branch per account), drops an empty `$defs` and adds `kindConfirmed`,
           * so the comparison reads the input per account: the same accounts must accept the same
           * input, and every other field (kind, description, output schema) must be unchanged.
           * Popupsmart lists one tool per account router, on one page.
           */
          const tools = (app: App) =>
            request("GET", `/apps/${app.id}/tools`).pipe(
              ok(Tools),
              Effect.tap((page) => Effect.sync(() => expect(page.next).toBeUndefined())),
              Effect.map((page) =>
                page.items
                  .map((item) => {
                    const {
                      version: _version,
                      deployment: _deployment,
                      kindConfirmed: _kindConfirmed,
                      inputSchema,
                      ...tool
                    } = item;
                    return JSON.stringify({ ...tool, inputs: inputsByAccount(inputSchema) });
                  })
                  .toSorted(),
              ),
            );
          // Untouched copies: the October source (protocol 12) with two accounts, the November
          // source (protocol 13) with one.
          const novemberFiles = sorted(catalogSnapshotFiles(catalogSnapshots.november.id));
          expect(declaredApps(octoberFiles())).toBe(october);
          expect(declaredApps(novemberFiles)).toBe(november);
          const untouched = yield* install(catalogSnapshots.october.id, "Popupsmart October");
          yield* connect(untouched, "First");
          yield* connect(untouched, "Second");
          const current = yield* install(catalogSnapshots.november.id, "Popupsmart November");
          yield* connect(current, "Only");
          // Edited: a later version runs other files than the install.
          const redeployed = yield* install(catalogSnapshots.october.id, "Popupsmart redeployed");
          yield* request("POST", `/apps/${redeployed.id}/deploy`, {
            files: catalogSnapshotFiles(catalogSnapshots.altered.id),
          }).pipe(ok(Schema.Struct({ app: App })));
          // Edited: main holds work that was never deployed.
          const drafted = yield* install(catalogSnapshots.october.id, "Popupsmart drafted");
          yield* request("POST", `/apps/${drafted.id}/commits`, {
            expected: (yield* workspace(drafted)).revision.commit,
            files: catalogSnapshotFiles(catalogSnapshots.altered.id),
            message: "Edit the README",
          }).pipe(ok(Committed));
          // Unmapped: installed from a source no catalog commit published.
          const altered = yield* install(catalogSnapshots.altered.id, "Popupsmart altered");
          // Held: a package whose tool names change on beta.140.
          const held = yield* install(catalogSnapshots.held.id, "Netsapiens");
          // Current: already on the host's release.
          const synthetic = yield* install(officialApps.mail.id, "Synthetic mail");
          expect(declaredApps(yield* running(synthetic))).toBe(appsVersion);
          // Not a catalog install: a copy of an app the organization deployed itself, under a
          // catalog package's name and with the October files. A copy records its parent's name
          // and an `app:` origin, so only the name looks like the catalog's.
          const owned = yield* request("POST", "/apps/deploy", {
            name: `@executor.sh/popupsmart-${randomUUID().slice(0, 8)}`,
            files: catalogSnapshotFiles(catalogSnapshots.october.id),
          }).pipe(ok(App), Effect.tap(remember));
          const copied = yield* request("POST", "/apps/copies", {
            from: { app: owned.id },
            name: `Popupsmart owned copy ${randomUUID().slice(0, 8)}`,
          }).pipe(ok(App), Effect.tap(remember));
          expect(yield* running(copied)).toEqual(octoberFiles());

          const apps = [untouched, current, redeployed, drafted, altered, held, synthetic, copied];
          const state = Effect.forEach(apps, (app) =>
            Effect.all({
              app: get(app),
              versions: versions(app),
              running: running(app),
              main: main(app),
              links: links(app),
            }),
          );
          const before = yield* state;
          const toolsBefore = {
            untouched: yield* tools(untouched),
            current: yield* tools(current),
          };
          // With linked accounts the copies list their tools; an empty list would prove nothing.
          expect(toolsBefore.untouched.length).toBeGreaterThan(0);
          expect(toolsBefore.current.length).toBeGreaterThan(0);

          // Every row of the tables the step could change, for these apps, as one hash per
          // table. The journal is the only thing a report may write.
          const ids = apps.map((app) => `'${app.id}'`).join(", ");
          const tables = {
            apps: `select t::text as row from executor_apps t where id in (${ids})`,
            versions: `select t::text as row from executor_deployments t where code in (select code from executor_apps where id in (${ids}))`,
            links: `select t::text as row from hosted_app_account_links t where app in (${ids})`,
            accounts: `select t::text as row from executor_accounts t where id in (select account from hosted_app_account_links where app in (${ids}))`,
            records: `select t::text as row from executor_app_records t where app in (${ids})`,
            schedules: `select t::text as row from executor_schedules t where app in (${ids})`,
            subscriptions: `select t::text as row from executor_webhooks t where app in (${ids})`,
            profiles: `select t::text as row from executor_installations t where app in (${ids})`,
          };
          const checksums = Effect.gen(function* () {
            const [first, ...rest] = Object.values(tables).map((query) => ({
              sql: `select md5(coalesce(string_agg(row, '|' order by row), '')) as sum from (${query}) rows`,
            }));
            if (first === undefined) return yield* Effect.die("No tables to hash");
            const results = yield* legacyStorage([first, ...rest]);
            const sums = yield* Effect.forEach(results, (rows) =>
              Schema.decodeUnknownEffect(Sum)(rows[0]),
            );
            return Object.fromEntries(
              Object.keys(tables).map((name, index) => [name, sums[index]]),
            );
          });
          // The hashes stop the product; the report start starts it again.
          const hashedBefore = yield* checksums;
          const report = yield* nextSummary(serverControl("start"));
          expect(report).toMatchObject({ mode: "report", status: "complete", pass: 1 });
          expect(report.owners[owner]).toEqual({
            rebuild: 2,
            edited: 2,
            unmapped: 1,
            "held-tool-names": 1,
            current: 1,
            "not-catalog": 1,
          });
          expect(yield* checksums).toEqual(hashedBefore);
          yield* serverControl("start");
          expect(yield* state).toEqual(before);

          // Apply: the mode changes only while the product is stopped.
          yield* holdApply;
          const applied = yield* nextSummary(serverControl("start"));
          // With the step on and no scope, the stage covers every copy.
          expect(applied).toMatchObject({
            mode: "apply",
            run: stageRun("all"),
            status: "complete",
            pass: 1,
          });
          expect(applied.owners[owner]).toEqual({
            rebuilt: 2,
            edited: 2,
            unmapped: 1,
            "held-tool-names": 1,
            current: 1,
            "not-catalog": 1,
          });

          // Both untouched copies now run, and main holds, exactly the catalog's own November
          // source with the pin on beta.140: the October copy got the same move the catalog made.
          const expected = rebuiltFiles();
          const after = yield* state;
          for (const [index, app] of [untouched, current].entries()) {
            const was = before[index]!;
            const now = after[index]!;
            expect(now.app.id).toBe(app.id);
            expect(now.app.activeVersion).not.toBe(was.app.activeVersion);
            expect(now.running).toEqual(expected);
            expect(now.main).toEqual(expected);
            // Same requirement names, scopes, cardinalities and provider IDs; same accounts.
            expect(now.app.requirements).toEqual(was.app.requirements);
            expect(now.links).toEqual(was.links);
            // The replaced version is retained.
            expect(now.versions).toEqual([...was.versions, now.app.activeVersion ?? ""].toSorted());
          }
          expect(yield* tools(untouched)).toEqual(toolsBefore.untouched);
          expect(yield* tools(current)).toEqual(toolsBefore.current);
          // Every other copy is unchanged, the owned copy included.
          for (const index of [2, 3, 4, 5, 6, 7])
            expect(after[index], apps[index]?.name).toEqual(before[index]);

          // Undo: activating the replaced version restores the October source, with the same
          // provider, accounts and tools.
          const rebuiltVersion = after[0]?.app.activeVersion ?? null;
          yield* request("POST", `/apps/${untouched.id}/activate`, {
            version: before[0]?.app.activeVersion,
            expectedVersion: rebuiltVersion,
          }).pipe(ok(Schema.Unknown));
          const undone = yield* get(untouched);
          expect(undone.activeVersion).toBe(before[0]?.app.activeVersion);
          expect(undone.requirements).toEqual(before[0]?.app.requirements);
          expect(yield* running(untouched)).toEqual(octoberFiles());
          expect(yield* links(untouched)).toEqual(before[0]?.links);
          expect(yield* tools(untouched)).toEqual(toolsBefore.untouched);

          // A later start runs nothing and changes nothing.
          const quiet = yield* summaries;
          const settled = yield* state;
          yield* serverControl("restart");
          expect(yield* summaries).toBe(quiet);
          expect(yield* state).toEqual(settled);
        }),
      ),
    // The product starts five times and builds on beta.88, beta.100 and beta.140.
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.catalogCopyRebuildUnreachableRegistry.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const { owner, install, get, main, running, versions, nextSummary, holdApply } =
            yield* rebuildFixture;
          const registry = yield* Config.NonEmptyString("E2E_NPM_REGISTRY");
          const copy = yield* install(catalogSnapshots.october.id, "Popupsmart offline");
          const before = { app: yield* get(copy), versions: yield* versions(copy) };

          // The first apply start cannot reach any registry, as on an offline host or with its
          // mirror down: nothing listens on port 1. The step's builds need apps beta.140 from
          // npm, which no earlier build on this product installed.
          yield* holdApply;
          yield* serverControl("environment", 200, { EXECUTOR_NPM_REGISTRY: "http://127.0.0.1:1" });
          const offline = yield* nextSummary(serverControl("start"));
          // Nothing about the source is known, so the copy is retried rather than recorded as a
          // copy that does not build, which no later start would revisit.
          expect(offline).toMatchObject({ mode: "apply", status: "retrying", pass: 1 });
          expect(offline.owners[owner]).toEqual({ failed: 1 });
          expect(yield* get(copy)).toEqual(before.app);
          expect(yield* versions(copy)).toEqual(before.versions);

          // With the registry back, the next start rebuilds it.
          yield* serverControl("stop");
          yield* serverControl("environment", 200, { EXECUTOR_NPM_REGISTRY: registry });
          const online = yield* nextSummary(serverControl("start"));
          expect(online).toMatchObject({ mode: "apply", status: "complete", pass: 2 });
          expect(online.owners[owner]).toEqual({ rebuilt: 1 });
          expect(yield* running(copy)).toEqual(rebuiltFiles());
          expect(yield* main(copy)).toEqual(rebuiltFiles());
          expect((yield* get(copy)).requirements).toEqual(before.app.requirements);
        }),
      ),
    // The product starts three times and builds on beta.88 and beta.140.
    { timeout: 240_000 },
  );

  it.effect(
    scenarios.catalogCopyRebuildCompilerUnavailable.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const { owner, install, get, main, running, versions, nextSummary, holdApply } =
            yield* rebuildFixture;
          // Two copies of one source: a pass builds each upgraded source once for all its copies,
          // so a failure kept for the first would decide the second.
          const copies = [
            yield* install(catalogSnapshots.october.id, "Popupsmart first"),
            yield* install(catalogSnapshots.october.id, "Popupsmart second"),
          ];
          const before = yield* Effect.forEach(copies, (copy) =>
            Effect.all({ app: get(copy), versions: versions(copy) }),
          );
          const unchanged = Effect.gen(function* () {
            for (const [index, copy] of copies.entries()) {
              expect(yield* get(copy)).toEqual(before[index]?.app);
              expect(yield* versions(copy)).toEqual(before[index]?.versions);
              expect(yield* running(copy)).toEqual(octoberFiles());
            }
          });

          // The first apply start's calls to the compiler fail without an answer, as when the
          // compiler is down: the step's check builds never reach it. Nothing about the source is
          // known, so both copies are retried rather than recorded as copies that do not build,
          // which no later start would revisit.
          yield* holdApply;
          yield* serverControl("environment", 200, { EXECUTOR_TEST_COMPILER_UNAVAILABLE: "all" });
          const down = yield* nextSummary(serverControl("start"));
          expect(down).toMatchObject({ mode: "apply", status: "retrying", pass: 1 });
          expect(down.owners[owner]).toEqual({ failed: 2 });
          yield* unchanged;

          // The next start's check builds answer, and only the deploys that keep their build go
          // unanswered: the same, after the step said it was rebuilding them.
          yield* serverControl("stop");
          yield* serverControl("environment", 200, {
            EXECUTOR_TEST_COMPILER_UNAVAILABLE: "retained",
          });
          const deploys = yield* nextSummary(serverControl("start"));
          expect(deploys).toMatchObject({ mode: "apply", status: "retrying", pass: 2 });
          expect(deploys.owners[owner]).toEqual({ failed: 2 });
          yield* unchanged;

          // With the compiler back, the next start rebuilds both.
          yield* serverControl("stop");
          yield* serverControl("environment", 200, { EXECUTOR_TEST_COMPILER_UNAVAILABLE: "" });
          const back = yield* nextSummary(serverControl("start"));
          expect(back).toMatchObject({ mode: "apply", status: "complete", pass: 3 });
          expect(back.owners[owner]).toEqual({ rebuilt: 2 });
          for (const [index, copy] of copies.entries()) {
            expect(yield* running(copy)).toEqual(rebuiltFiles());
            expect(yield* main(copy)).toEqual(rebuiltFiles());
            expect((yield* get(copy)).requirements).toEqual(before[index]?.app.requirements);
          }
        }),
      ),
    // The product starts four times and builds on beta.88 and beta.140.
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.catalogCopyRebuildConcurrentActivation.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const { owner, request, ok, install, get, main, running, versions, nextSummary } =
            yield* rebuildFixture;
          // Each copy runs its install. The first also retains an edited version, deployed and
          // then replaced by the install again, which a person can activate at any time.
          const switched = yield* install(catalogSnapshots.october.id, "Popupsmart switched");
          const edited = yield* request("POST", `/apps/${switched.id}/deploy`, {
            files: catalogSnapshotFiles(catalogSnapshots.altered.id),
          }).pipe(ok(Schema.Struct({ app: App })));
          yield* request("POST", `/apps/${switched.id}/activate`, {
            version: switched.activeVersion,
            expectedVersion: edited.app.activeVersion,
          }).pipe(ok(Schema.Unknown));
          const reactivated = yield* install(catalogSnapshots.october.id, "Popupsmart reactivated");
          const apps = [switched, reactivated];
          const state = Effect.forEach(apps, (app) =>
            Effect.all({
              app: get(app),
              versions: versions(app),
              running: running(app),
              main: main(app),
            }),
          );
          const before = yield* state;
          expect(before[0]?.running).toEqual(octoberFiles());

          // A person activates a version while the step builds its deploy: once the deploy has
          // reserved its order, the product stores exactly what an activation stores. For the
          // first copy that is the edited version; for the second, the version it already runs.
          // Each fires once, on the deploy's reservation (the only write that moves the deploy
          // order alone). The product is stopped while the fixture is written.
          const races = [
            { app: switched.id, activate: edited.app.activeVersion ?? "" },
            { app: reactivated.id, activate: reactivated.activeVersion ?? "" },
          ];
          yield* legacyStorage([
            {
              sql: "CREATE TABLE executor_test_race (app text primary key, activate text not null)",
            },
            ...races.map((race) => ({
              sql: "INSERT INTO executor_test_race (app, activate) VALUES ($1, $2)",
              params: [race.app, race.activate],
            })),
            {
              sql: `CREATE FUNCTION executor_test_race() RETURNS trigger LANGUAGE plpgsql AS $$
                DECLARE chosen text;
                BEGIN
                  DELETE FROM executor_test_race WHERE app = NEW.id RETURNING activate INTO chosen;
                  IF chosen IS NOT NULL THEN
                    UPDATE executor_apps SET active_deployment = chosen,
                      deploy_sequence = NEW.deploy_sequence + 1,
                      activated_sequence = NEW.deploy_sequence + 1
                    WHERE id = NEW.id;
                  END IF;
                  RETURN NULL;
                END $$`,
            },
            {
              sql: `CREATE TRIGGER executor_test_race AFTER UPDATE OF deploy_sequence ON executor_apps
                FOR EACH ROW WHEN (NEW.deploy_sequence = OLD.deploy_sequence + 1
                  AND NEW.activated_sequence = OLD.activated_sequence
                  AND NEW.active_deployment IS NOT DISTINCT FROM OLD.active_deployment)
                EXECUTE FUNCTION executor_test_race()`,
            },
          ]);
          yield* serverControl("data-steps", 200, { mode: "apply" });
          const raced = yield* nextSummary(serverControl("start"));
          // The person's activation wins; the step's deploy records nothing and is retried.
          expect(raced).toMatchObject({ mode: "apply", status: "retrying", pass: 1 });
          expect(raced.owners[owner]).toEqual({ conflict: 2 });
          const during = yield* state;
          expect(during[0]?.app.activeVersion).toBe(edited.app.activeVersion);
          expect(during[1]?.app.activeVersion).toBe(reactivated.activeVersion);
          for (const index of [0, 1]) {
            // No version of the step's is retained, and main still holds the install.
            expect(during[index]?.versions).toEqual(before[index]?.versions);
            expect(during[index]?.main).toEqual(octoberFiles());
          }
          expect(during[0]?.running).toEqual(
            sorted(catalogSnapshotFiles(catalogSnapshots.altered.id)),
          );

          // The next start finds the first copy running the person's edit and leaves it; the
          // second runs its install still, untouched, and is rebuilt.
          const settled = yield* nextSummary(serverControl("restart"));
          expect(settled).toMatchObject({ mode: "apply", status: "complete", pass: 2 });
          expect(settled.owners[owner]).toEqual({ edited: 1, rebuilt: 1 });
          const after = yield* state;
          expect(after[0]).toEqual(during[0]);
          expect(after[1]?.running).toEqual(rebuiltFiles());
          expect(after[1]?.main).toEqual(rebuiltFiles());
        }),
      ),
    // The product starts four times and builds on beta.88 and beta.140.
    { timeout: 240_000 },
  );

  it.effect(
    scenarios.catalogCopyRebuildInterrupted.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const {
            target,
            owner,
            request,
            ok,
            install,
            get,
            workspace,
            main,
            running,
            versions,
            nextSummary,
          } = yield* rebuildFixture;
          const fs = yield* FileSystem.FileSystem;
          // Two copies: the step finishes the first; someone undoes the second before it can.
          const copy = yield* install(catalogSnapshots.october.id, "Popupsmart interrupted");
          const undone = yield* install(catalogSnapshots.october.id, "Popupsmart undone");
          const copies = [copy, undone];
          // Reading main creates each app's repository from the install's files.
          for (const app of copies)
            expect(sorted((yield* workspace(app)).files)).toEqual(octoberFiles());
          const installed = yield* Effect.forEach(copies, versions);

          // Main's branch is locked, as by a Git process that did not finish: the step's deploy
          // succeeds and its commit to main fails after it.
          const locks = copies.map(
            (app) => `${target.directory}/data/repositories/${app.code}.git/refs/heads/main.lock`,
          );
          yield* serverControl("stop");
          for (const lock of locks) yield* fs.writeFileString(lock, "");
          yield* serverControl("data-steps", 200, { mode: "apply" });
          const stopped = yield* nextSummary(serverControl("start"));
          // Each app runs the rebuild with main still on the install: that is not done, and the
          // step says so rather than recording a rebuilt app.
          expect(stopped).toMatchObject({ mode: "apply", status: "retrying", pass: 1 });
          expect(stopped.owners[owner]).toEqual({ rebuilding: 2 });
          const deployed = yield* Effect.forEach(copies, get);
          for (const [index, app] of copies.entries()) {
            expect(deployed[index]?.activeVersion).not.toBe(app.activeVersion);
            expect(yield* running(app)).toEqual(rebuiltFiles());
            expect(yield* main(app)).toEqual(octoberFiles());
          }
          // Someone puts the second back on its install, as the documented undo does.
          yield* request("POST", `/apps/${undone.id}/activate`, {
            version: undone.activeVersion,
            expectedVersion: deployed[1]?.activeVersion,
          }).pipe(ok(Schema.Unknown));

          // The next start runs another stage, whose scope names neither copy, and still finishes
          // the first rebuild: main gets what runs, and nothing is deployed again. The second's
          // undo stands: no new deploy, main left on the install.
          yield* serverControl("stop");
          for (const lock of locks) yield* fs.remove(lock);
          const elsewhere = `app:app_${randomUUID()}`;
          yield* serverControl("environment", 200, {
            EXECUTOR_CATALOG_COPY_REBUILD_SCOPE: elsewhere,
          });
          const finished = yield* nextSummary(serverControl("start"));
          expect(finished).toMatchObject({
            mode: "apply",
            run: stageRun(elsewhere),
            status: "complete",
            pass: 1,
          });
          expect(finished.owners[owner]).toEqual({ rebuilt: 1, "rolled-back": 1 });
          for (const [index, app] of copies.entries())
            expect(yield* versions(app)).toEqual(
              [...installed[index]!, deployed[index]?.activeVersion ?? ""].toSorted(),
            );
          expect((yield* get(copy)).activeVersion).toBe(deployed[0]?.activeVersion);
          expect(yield* running(copy)).toEqual(rebuiltFiles());
          expect(yield* main(copy)).toEqual(rebuiltFiles());
          expect((yield* get(undone)).activeVersion).toBe(undone.activeVersion);
          expect(yield* running(undone)).toEqual(octoberFiles());
          expect(yield* main(undone)).toEqual(octoberFiles());
        }),
      ),
    // The product starts four times and builds on beta.88 and beta.140.
    { timeout: 240_000 },
  );

  it.effect(
    scenarios.catalogCopyRebuildStaged.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const {
            actors,
            owner,
            install,
            get,
            main,
            running,
            versions,
            summaries,
            nextSummary,
            holdApply,
            links,
            connect,
          } = yield* rebuildFixture;
          const copies = [
            yield* install(catalogSnapshots.october.id, "Popupsmart first stage"),
            yield* install(catalogSnapshots.october.id, "Popupsmart second stage"),
            yield* install(catalogSnapshots.october.id, "Popupsmart last stage"),
          ];
          // Each copy has a linked account, which every stage must leave linked.
          for (const copy of copies) yield* connect(copy, "Stage");
          const state = Effect.forEach(copies, (copy) =>
            Effect.all({
              app: get(copy),
              versions: versions(copy),
              running: running(copy),
              main: main(copy),
              links: links(copy),
            }),
          );
          const before = yield* state;
          const rebuilt = (index: number, now: Effect.Success<typeof state>) => {
            expect(now[index]?.app.activeVersion).not.toBe(before[index]?.app.activeVersion);
            expect(now[index]?.running).toEqual(rebuiltFiles());
            expect(now[index]?.main).toEqual(rebuiltFiles());
            expect(now[index]?.app.requirements).toEqual(before[index]?.app.requirements);
            expect(now[index]?.links).toEqual(before[index]?.links);
          };
          const [first, second, last] = copies;
          if (first === undefined || second === undefined || last === undefined)
            return yield* Effect.die("Three copies");

          // The first stage names one copy. The others are not read or changed: same version,
          // versions, running files, main and linked accounts.
          yield* holdApply;
          const one = `app:${first.id}`;
          yield* serverControl("environment", 200, { EXECUTOR_CATALOG_COPY_REBUILD_SCOPE: one });
          const firstStage = yield* nextSummary(serverControl("start"));
          expect(firstStage).toMatchObject({
            mode: "apply",
            run: stageRun(one),
            status: "complete",
            pass: 1,
          });
          expect(firstStage.owners[owner]).toEqual({ rebuilt: 1, "out-of-scope": 2 });
          const afterFirst = yield* state;
          rebuilt(0, afterFirst);
          expect(afterFirst[1]).toEqual(before[1]);
          expect(afterFirst[2]).toEqual(before[2]);

          // A finished stage does not run again.
          const quiet = yield* summaries;
          yield* serverControl("restart");
          expect(yield* summaries).toBe(quiet);
          expect(yield* state).toEqual(afterFirst);

          // A wider stage with a maximum changes only that many more copies, in ID order. Once it
          // has, every later copy is out of its scope without a read, so the copy the first stage
          // rebuilt reads `current` only when it comes before the one this stage rebuilds.
          const capped = "all max:1";
          const [earlier, later] = [second, last].toSorted((left, right) =>
            left.id < right.id ? -1 : 1,
          );
          if (earlier === undefined || later === undefined) return yield* Effect.die("Two copies");
          yield* serverControl("stop");
          yield* serverControl("environment", 200, { EXECUTOR_CATALOG_COPY_REBUILD_SCOPE: capped });
          const secondStage = yield* nextSummary(serverControl("start"));
          expect(secondStage).toMatchObject({
            run: stageRun(capped),
            status: "complete",
            pass: 1,
          });
          expect(secondStage.owners[owner]).toEqual(
            first.id < earlier.id
              ? { current: 1, rebuilt: 1, "out-of-scope": 1 }
              : { rebuilt: 1, "out-of-scope": 2 },
          );
          const afterSecond = yield* state;
          expect(afterSecond[0]).toEqual(afterFirst[0]);
          const earlierIndex = copies.indexOf(earlier);
          const laterIndex = copies.indexOf(later);
          rebuilt(earlierIndex, afterSecond);
          expect(afterSecond[laterIndex]).toEqual(before[laterIndex]);

          // The organization's stage rebuilds the copy left, and changes neither of the others.
          const organization = `organization:${actors.organization.id}`;
          yield* serverControl("stop");
          yield* serverControl("environment", 200, {
            EXECUTOR_CATALOG_COPY_REBUILD_SCOPE: organization,
          });
          const lastStage = yield* nextSummary(serverControl("start"));
          expect(lastStage).toMatchObject({
            run: stageRun(organization),
            status: "complete",
            pass: 1,
          });
          expect(lastStage.owners[owner]).toEqual({ current: 2, rebuilt: 1 });
          const afterLast = yield* state;
          expect(afterLast[0]).toEqual(afterSecond[0]);
          expect(afterLast[earlierIndex]).toEqual(afterSecond[earlierIndex]);
          rebuilt(laterIndex, afterLast);
        }),
      ),
    // The product starts six times and builds on beta.88 and beta.140.
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.catalogCopyRebuildGivesUp.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const {
            actors,
            owner,
            install,
            get,
            running,
            versions,
            summaries,
            nextSummary,
            holdApply,
          } = yield* rebuildFixture;
          const registry = yield* Config.NonEmptyString("E2E_NPM_REGISTRY");
          // Two copies of different sources, each with its own check build.
          const copies = [
            yield* install(catalogSnapshots.october.id, "Popupsmart outage"),
            yield* install(catalogSnapshots.november.id, "Popupsmart outage November"),
          ];
          const before = yield* Effect.forEach(copies, (copy) =>
            Effect.all({ app: get(copy), versions: versions(copy) }),
          );
          const unchanged = Effect.forEach(copies, (copy, index) =>
            Effect.gen(function* () {
              expect(yield* get(copy)).toEqual(before[index]?.app);
              expect(yield* versions(copy)).toEqual(before[index]?.versions);
            }),
          );
          // The registry stays out of reach. Each start records both copies `failed`; the third
          // start gives up on them, so the host's data steps complete instead of holding every
          // later start.
          yield* holdApply;
          yield* serverControl("environment", 200, { EXECUTOR_NPM_REGISTRY: "http://127.0.0.1:1" });
          for (const pass of [1, 2, 3]) {
            const summary = yield* nextSummary(
              pass === 1 ? serverControl("start") : serverControl("restart"),
            );
            if (pass < 3) {
              expect(summary).toMatchObject({ mode: "apply", status: "retrying", pass });
              expect(summary.owners[owner]).toEqual({ failed: 2 });
            } else {
              expect(summary).toMatchObject({ mode: "apply", status: "complete", pass });
              expect(summary.owners[owner]).toEqual({ "gave-up": 2 });
            }
            yield* unchanged;
          }

          // The stage is finished: with the registry back, a start runs nothing.
          yield* serverControl("stop");
          yield* serverControl("environment", 200, { EXECUTOR_NPM_REGISTRY: registry });
          const quiet = yield* summaries;
          yield* serverControl("start");
          expect(yield* summaries).toBe(quiet);
          yield* unchanged;

          // The next stage tries them afresh and rebuilds both.
          const organization = `organization:${actors.organization.id}`;
          yield* serverControl("stop");
          yield* serverControl("environment", 200, {
            EXECUTOR_CATALOG_COPY_REBUILD_SCOPE: organization,
          });
          const next = yield* nextSummary(serverControl("start"));
          expect(next).toMatchObject({ run: stageRun(organization), status: "complete" });
          expect(next.owners[owner]).toEqual({ rebuilt: 2 });
          for (const copy of copies) expect(yield* running(copy)).toEqual(rebuiltFiles());
        }),
      ),
    // The product starts six times and builds on beta.88, beta.100 and beta.140.
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.catalogCopyRebuildPaced.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const {
            owner,
            install,
            get,
            main,
            running,
            versions,
            summaries,
            nextSummary,
            holdApply,
          } = yield* rebuildFixture;
          // Two copies of different sources, so neither's check build serves the other. Items run
          // in ID order.
          const copies = [
            yield* install(catalogSnapshots.october.id, "Popupsmart paced"),
            yield* install(catalogSnapshots.november.id, "Popupsmart paced November"),
          ].toSorted((left, right) => (left.id < right.id ? -1 : 1));
          const state = Effect.forEach(copies, (copy) =>
            Effect.all({
              app: get(copy),
              versions: versions(copy),
              running: running(copy),
              main: main(copy),
            }),
          );
          const before = yield* state;
          const rebuilt = (index: number, now: Effect.Success<typeof state>) => {
            expect(now[index]?.app.activeVersion).not.toBe(before[index]?.app.activeVersion);
            expect(now[index]?.running).toEqual(rebuiltFiles());
            expect(now[index]?.main).toEqual(rebuiltFiles());
            // One deploy: the check build kept nothing, and the deploy was not repeated.
            expect(now[index]?.versions).toEqual(
              [...(before[index]?.versions ?? []), now[index]?.app.activeVersion ?? ""].toSorted(),
            );
          };

          // Each start may start one compiler build. A copy takes two, its check build and its
          // deploy, so each start does half a copy and ends no pass.
          yield* holdApply;
          yield* serverControl("environment", 200, {
            EXECUTOR_TEST_CATALOG_COPY_REBUILD_PACE: "1",
          });
          const quiet = yield* summaries;
          // The first start checks the first copy, and stops before its deploy.
          yield* serverControl("start");
          expect(yield* summaries).toBe(quiet);
          expect(yield* state).toEqual(before);

          // The next deploys it without checking it again, and stops before the second copy.
          yield* serverControl("restart");
          expect(yield* summaries).toBe(quiet);
          const afterDeploy = yield* state;
          rebuilt(0, afterDeploy);
          expect(afterDeploy[1]).toEqual(before[1]);

          // The next checks the second copy.
          yield* serverControl("restart");
          expect(yield* summaries).toBe(quiet);
          expect(yield* state).toEqual(afterDeploy);

          // The next deploys it, and the pass ends.
          const done = yield* nextSummary(serverControl("restart"));
          expect(done).toMatchObject({
            mode: "apply",
            run: stageRun("all"),
            status: "complete",
            pass: 1,
          });
          expect(done.owners[owner]).toEqual({ rebuilt: 2 });
          const after = yield* state;
          expect(after[0]).toEqual(afterDeploy[0]);
          rebuilt(1, after);
        }),
      ),
    // The product starts five times and builds on beta.88, beta.100 and beta.140.
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.catalogCopyRebuildIntentKept.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const { target, owner, install, get, workspace, main, running, versions, nextSummary } =
            yield* rebuildFixture;
          const fs = yield* FileSystem.FileSystem;
          // Two copies, in the order the step handles them. Each start's failure to read the
          // second is caused right after the step records the first.
          const copies = [
            yield* install(catalogSnapshots.october.id, "Popupsmart kept"),
            yield* install(catalogSnapshots.october.id, "Popupsmart unread"),
          ].toSorted((left, right) => (left.id < right.id ? -1 : 1));
          const [first, unread] = copies;
          if (first === undefined || unread === undefined) return yield* Effect.die("Two copies");
          for (const app of copies)
            expect(sorted((yield* workspace(app)).files)).toEqual(octoberFiles());
          const installed = yield* Effect.forEach(copies, versions);
          const lock = (app: App) =>
            `${target.directory}/data/repositories/${app.code}.git/refs/heads/main.lock`;

          // Both commits to main fail after the deploy, as in the interrupted scenario: each copy
          // runs its rebuild with main still on the install, and the step says it is not done.
          yield* serverControl("stop");
          for (const app of copies) yield* fs.writeFileString(lock(app), "");
          yield* serverControl("data-steps", 200, { mode: "apply" });
          const stopped = yield* nextSummary(serverControl("start"));
          expect(stopped).toMatchObject({ mode: "apply", status: "retrying", pass: 1 });
          expect(stopped.owners[owner]).toEqual({ rebuilding: 2 });
          const deployed = yield* Effect.forEach(copies, get);
          const partWay = Effect.forEach(copies, (app, index) =>
            Effect.gen(function* () {
              expect((yield* get(app)).activeVersion).toBe(deployed[index]?.activeVersion);
              expect(yield* running(app)).toEqual(rebuiltFiles());
              expect(yield* main(app)).toEqual(octoberFiles());
            }),
          );

          // From now on, whenever the step records the first copy, the second's active version
          // can no longer be read (its stored requirements are not requirements), as when storage
          // fails; the step's own record of the second puts it back. The listing at the start of
          // each pass reads it intact. The first copy's main stays locked, so each start records
          // it; the second's lock is gone.
          const unreadVersion = deployed[1]?.activeVersion ?? "";
          yield* serverControl("stop");
          yield* fs.remove(lock(unread));
          yield* legacyStorage([
            {
              sql: `CREATE TABLE executor_test_read_fault AS
                SELECT id, requirements, ''::text AS after_item, ''::text AS unread_item
                FROM executor_deployments WITH NO DATA`,
            },
            {
              sql: `INSERT INTO executor_test_read_fault
                SELECT id, requirements, $1, $2 FROM executor_deployments WHERE id = $3`,
              params: [first.id, unread.id, unreadVersion],
            },
            {
              sql: `CREATE FUNCTION executor_test_read_fault() RETURNS trigger LANGUAGE plpgsql AS $$
                DECLARE fault executor_test_read_fault%ROWTYPE;
                BEGIN
                  SELECT * INTO fault FROM executor_test_read_fault;
                  IF NEW.name <> '${step}' THEN RETURN NULL; END IF;
                  IF NEW.item = fault.after_item THEN
                    UPDATE executor_deployments SET requirements = '"unreadable"' WHERE id = fault.id;
                  ELSIF NEW.item = fault.unread_item THEN
                    UPDATE executor_deployments SET requirements = fault.requirements WHERE id = fault.id;
                  END IF;
                  RETURN NULL;
                END $$`,
            },
            {
              sql: `CREATE TRIGGER executor_test_read_fault
                AFTER INSERT OR UPDATE ON private_hosted_data_step_items
                FOR EACH ROW EXECUTE FUNCTION executor_test_read_fault()`,
            },
          ]);

          // The second copy cannot be read at either retry of the stage. It stays to be finished:
          // `rebuilding`, then `unfinished` at the host's bound, never `failed` or `gave-up`, which
          // a later pass would check afresh and read as `current` with main left on the install.
          const retried = yield* nextSummary(serverControl("start"));
          expect(retried).toMatchObject({ mode: "apply", status: "retrying", pass: 2 });
          expect(retried.owners[owner]).toEqual({ rebuilding: 2 });
          yield* partWay;
          const bounded = yield* nextSummary(serverControl("restart"));
          expect(bounded).toMatchObject({ mode: "apply", status: "complete", pass: 3 });
          expect(bounded.owners[owner]).toEqual({ unfinished: 2 });
          yield* partWay;

          // A later stage that names neither copy still finishes both, the second through one
          // more failed read.
          const elsewhere = `app:app_${randomUUID()}`;
          yield* serverControl("stop");
          yield* serverControl("environment", 200, {
            EXECUTOR_CATALOG_COPY_REBUILD_SCOPE: elsewhere,
          });
          const unreadable = yield* nextSummary(serverControl("start"));
          expect(unreadable).toMatchObject({
            mode: "apply",
            run: stageRun(elsewhere),
            status: "retrying",
            pass: 1,
          });
          expect(unreadable.owners[owner]).toEqual({ rebuilding: 2 });
          yield* partWay;

          // With storage and main back, the next start finishes both: main gets what runs, and
          // nothing is deployed again.
          yield* serverControl("stop");
          yield* fs.remove(lock(first));
          yield* legacyStorage([
            { sql: "DROP TRIGGER executor_test_read_fault ON private_hosted_data_step_items" },
            { sql: "DROP FUNCTION executor_test_read_fault()" },
            { sql: "DROP TABLE executor_test_read_fault" },
          ]);
          const finished = yield* nextSummary(serverControl("start"));
          expect(finished).toMatchObject({
            mode: "apply",
            run: stageRun(elsewhere),
            status: "complete",
            pass: 2,
          });
          expect(finished.owners[owner]).toEqual({ rebuilt: 2 });
          for (const [index, app] of copies.entries()) {
            expect((yield* get(app)).activeVersion).toBe(deployed[index]?.activeVersion);
            expect(yield* running(app)).toEqual(rebuiltFiles());
            expect(yield* main(app)).toEqual(rebuiltFiles());
            expect(yield* versions(app)).toEqual(
              [...installed[index]!, deployed[index]?.activeVersion ?? ""].toSorted(),
            );
          }
        }),
      ),
    // The product starts six times and builds on beta.88 and beta.140.
    { timeout: 300_000 },
  );
});
