/**
 * Removal of a test stage whose Alchemy records the shared state store can no longer read.
 *
 * On 2026-11-06 a deploy bootstrapped a new state store over the live one (`patches/alchemy.md`,
 * "State store probe"). That replaced the store's encryption key, and AES-CTR decrypts a record
 * written under the old key to bytes that are not JSON, so every read of it is an HTTP 500. Alchemy
 * cannot plan a destroy without those records. Only an explicit `test-stage destroy --by-name`
 * removes such a stage, by the names and tags the stage implies; eviction and scheduled cleanup
 * never do.
 *
 * Every selector is exact for one stage and cannot match production or another stage:
 * - Workers carry both `alchemy:stack:executor-next-hosted` and `alchemy:stage:test-<slug>`.
 * - Routes in any of the account's zones, Workers custom domains and Workflows are selected by
 *   their script, a physical name recomputed for this stack, one of its Workers and the stage, so
 *   they are found after their Worker is gone.
 * - Buckets are Alchemy physical names for this stack, logical ID and stage. A long stage's name
 *   is truncated with a hash of the full name, which is recomputed, so it is exact as well.
 * - Test-zone DNS is `<slug>.<test zone>` or one label under it.
 * - App-zone DNS lies under the app base the stage's own AppPages route serves, read before
 *   anything is removed, never under its slug: manual stages choose their own base. Production
 *   writes `*.<team>.<app zone>`, so the name that shape takes under the base is excluded.
 * - The Neon branch, Axiom monitors and ingest token and the observability destination carry
 *   `test-<slug>` in names the stack builds from the stage (`telemetry.ts`, `preview-database.ts`).
 *
 * Removal refuses, before changing anything, a stage whose records name a kind it cannot remove
 * (PlanetScale's Hyperdrive connection, certificate and roles, or anything it does not know) or
 * whose Artifacts namespace it cannot confirm empty.
 */
import { createHash } from "node:crypto";
import { Config, Console, Duration, Effect, Option, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { layer as alchemyRuntime } from "alchemy/Alchemist/Runtime";
import { store } from "alchemy/Alchemist/routes/state";
import { makeHttpStateStore } from "alchemy/State";
import { TestStageFailed } from "../contracts/test-stage-lifetime.ts";
import { testStagePrefix } from "../infrastructure/stage.ts";

const stack = "executor-next-hosted";
const failed = (message: string) => new TestStageFailed({ message });

/** The stack's Workers, by logical ID; their names are Alchemy physical names of at most 54. */
const workerIds = [
  "Api",
  "AppClaims",
  "AppCompiler",
  "AppData",
  "AppDomainController",
  "AppOutbound",
  "AppPages",
  "ArtifactsCredentials",
  "Authoring",
  "Dashboard",
  "Edge",
  "Formatter",
  "InfraRunner",
  "InvocationTelemetry",
  "Marketing",
  "McpServer",
];
const workerNameLength = 54;

/** What removal by name does with each record the stack writes, keyed by logical ID. */
const recordKinds: Readonly<Record<string, "removed" | "kept" | "planetscale">> = {
  // Removed by the selectors below: Workers, Workflows, buckets, test-zone DNS, app-zone DNS, the
  // Neon branch, Axiom monitors and token and the observability destination.
  ...Object.fromEntries(
    [
      ...workerIds,
      "AppWorkflows",
      "OrganizationRemoval",
      "Provisioning",
      "V1Import",
      "V1ImportWorkflow",
      "AppBuilds",
      "SiteAssets",
      "EdgeHost",
      "RoleHost-api",
      "RoleHost-app",
      "RoleHost-mcp",
      "AppDomains",
      "PreviewDatabase",
      "AppBrowserFailures",
      "AppTelemetryRejected",
      "AppTraceContextMissing",
      "RunnerFallback",
      "SupervisorRefusals",
      "TelemetryExportFailures",
      "TelemetryIngest",
      "PlatformTraces",
    ].map((id) => [id, "removed"]),
  ),
  // Nothing outside the state store, something removed with the Neon branch (roles, schema,
  // fixtures), or the telemetry datasets every stage adopts and retains.
  ...Object.fromEntries(
    [
      "ResumeAppDomains",
      "AppCredentialKey",
      "AppDomainControlSecret",
      "AppHostCallSecret",
      "AuthSecret",
      "BackgroundJobSecret",
      "BillingInstance",
      "BillingSecret",
      "EncryptionKey",
      "MailInstance",
      "MailSecret",
      "McpSessionKeyA",
      "McpSessionKeyB",
      "RuntimePassword",
      "WorkflowRunSecret",
      "Site",
      "Migrations",
      "RuntimeRole",
      "ScenarioFixtures",
      "TelemetryLogs",
      "TelemetryMetrics",
      "TelemetryTraces",
    ].map((id) => [id, "kept"]),
  ),
  ...Object.fromEntries(
    ["DatabaseCertificateAuthority", "DatabaseConnection", "MigrationRole", "PreviewPoolSize"].map(
      (id) => [id, "planetscale"],
    ),
  ),
};

/**
 * The shared state store, or the one `TEST_STAGE_STATE_STORE_URL` names: the scenarios in
 * `test-stage-unreadable.spec.ts` point it at a recorded copy.
 */
const sharedState = Effect.gen(function* () {
  const url = yield* Config.option(Config.String("TEST_STAGE_STATE_STORE_URL"));
  if (Option.isNone(url))
    return yield* store({ backend: "cloudflare" }).pipe(Effect.provide(alchemyRuntime()));
  const token = yield* Config.Redacted("TEST_STAGE_STATE_STORE_TOKEN");
  return yield* makeHttpStateStore({
    url: url.value,
    authToken: Redacted.value(token),
    id: "http",
  });
});

/** A record that fails to decrypt answers HTTP 500 on every read; other failures are not that. */
const isUndecryptable = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "StateStoreError" &&
  "http" in error &&
  typeof error.http === "object" &&
  error.http !== null &&
  "status" in error.http &&
  error.http.status === 500;

/**
 * The stage's records and whether they can be read. Each read is retried; the stage counts as
 * unreadable only when every record still fails as an undecryptable record does. Anything else,
 * including some records readable and others not, is an error rather than a guess.
 */
export const stageRecords = (slug: string) =>
  Effect.gen(function* () {
    const shared = yield* sharedState;
    const target = { stack, stage: `${testStagePrefix}${slug}` };
    const fqns = yield* shared.list(target);
    const backoff = yield* Config.Duration("TEST_STAGE_API_BACKOFF").pipe(
      Config.withDefault(Duration.seconds(1)),
    );
    const reads = yield* Effect.forEach(
      fqns,
      (fqn) =>
        shared
          .get({ ...target, fqn })
          .pipe(Effect.retry({ times: 2, schedule: Schedule.exponential(backoff) }), Effect.result),
      { concurrency: 8 },
    );
    const unreadable = reads.flatMap((read) => (read._tag === "Failure" ? [read.failure] : []));
    if (unreadable.length === 0) return { fqns, readable: true };
    if (unreadable.length === reads.length && unreadable.every(isUndecryptable))
      return { fqns, readable: false };
    return yield* failed(
      `${unreadable.length} of test-${slug}'s ${reads.length} Alchemy records could not be read, and not all as records written under the store's old key fail. Nothing was changed; retry later.`,
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.fail(
        Schema.is(TestStageFailed)(error)
          ? error
          : failed(`Could not read test-${slug}'s Alchemy records.`),
      ),
    ),
  );

/** Remove the stage's unreadable records, so nothing else tries to plan against them. */
const forgetState = (slug: string) =>
  Effect.gen(function* () {
    const shared = yield* sharedState;
    const target = { stack, stage: `${testStagePrefix}${slug}` };
    yield* shared.deleteStack(target);
    const left = yield* shared.list(target);
    if (left.length > 0)
      return yield* failed(`test-${slug} still has ${left.length} Alchemy record(s).`);
  }).pipe(
    Effect.catch((error) =>
      Effect.fail(
        Schema.is(TestStageFailed)(error)
          ? error
          : failed(`Could not remove test-${slug}'s Alchemy records.`),
      ),
    ),
  );

const escape = (value: string) => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** RFC 4648 base32 without padding, lowercase, as Alchemy writes physical names. */
const base32 = (bytes: Uint8Array) => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(buffer << (5 - bits)) & 31];
  return out;
};

/**
 * Whether `name` is the physical name Alchemy gives logical ID `id` of this stack in `stage`
 * (`PhysicalName.ts`): `<stack>-<id>-<stage>-` and 16 base32 characters of the instance ID,
 * lowercased. A longer name keeps the start of that prefix, then 8 base32 characters of the
 * SHA-256 of the full name, then the instance characters; the hash is recomputed here.
 */
export const isPhysicalName = (name: string, id: string, stage: string, maxLength: number) => {
  const suffix = name.slice(-16);
  if (!/^[a-z2-7]{16}$/u.test(suffix)) return false;
  const prefix = `${stack}-${id}-${stage}-`;
  const full = `${prefix}${suffix}`;
  if (full.length <= maxLength) return name === full.toLowerCase();
  const hash = base32(createHash("sha256").update(full).digest()).slice(0, 8);
  const tail = `${hash}${suffix}`.slice(0, maxLength);
  return name === `${prefix.slice(0, Math.max(0, maxLength - tail.length))}${tail}`.toLowerCase();
};

type Service = "cloudflare" | "neon" | "axiom";

/** Requests with a deadline, retries for 429 and 5xx, and errors that name no account or zone. */
const client = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const account = yield* Config.NonEmptyString("CLOUDFLARE_ACCOUNT_ID");
  const cloudflare = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
  const neon = yield* Config.Redacted("NEON_API_KEY");
  const axiom = yield* Config.Redacted("AXIOM_TOKEN");
  const axiomOrg = yield* Config.NonEmptyString("AXIOM_ORG_ID");
  // The origins can point at a recorded copy of these APIs (`test-stage-unreadable.spec.ts`).
  const origin = (name: string, real: string) => Config.String(name).pipe(Config.withDefault(real));
  const origins = {
    cloudflare: `${yield* origin("TEST_STAGE_CLOUDFLARE_API", "https://api.cloudflare.com")}/client/v4`,
    neon: `${yield* origin("TEST_STAGE_NEON_API", "https://console.neon.tech")}/api/v2`,
    axiom: `${yield* origin("TEST_STAGE_AXIOM_API", "https://api.axiom.co")}/v2`,
  };
  const request = (api: Service, path: string) => {
    const base = HttpClientRequest.make("GET")(`${origins[api]}${path}`);
    if (api === "cloudflare")
      return HttpClientRequest.bearerToken(Redacted.value(cloudflare))(base);
    if (api === "neon") return HttpClientRequest.bearerToken(Redacted.value(neon))(base);
    return HttpClientRequest.setHeader(
      "x-axiom-org-id",
      axiomOrg,
    )(HttpClientRequest.bearerToken(Redacted.value(axiom))(base));
  };
  /** Each attempt has 30 seconds; 429 waits for its `Retry-After`, 5xx backs off, five tries. */
  const send = (outgoing: HttpClientRequest.HttpClientRequest, what: string) =>
    Effect.gen(function* () {
      const backoff = yield* Config.Duration("TEST_STAGE_API_BACKOFF").pipe(
        Config.withDefault(Duration.seconds(2)),
      );
      for (let attempt = 1; ; attempt += 1) {
        const response = yield* http.execute(outgoing).pipe(
          Effect.timeout("30 seconds"),
          Effect.catch(() => Effect.fail(failed(`Could not reach the API to ${what}.`))),
        );
        if ((response.status !== 429 && response.status < 500) || attempt === 5) return response;
        const after = Number(response.headers["retry-after"]);
        yield* Effect.sleep(
          response.status === 429 && Number.isFinite(after) && after >= 0
            ? Duration.seconds(Math.min(after, 60))
            : Duration.times(backoff, attempt),
        );
      }
    });
  const get = <S extends Schema.Top>(api: Service, path: string, schema: S, what: string) =>
    Effect.gen(function* () {
      const response = yield* send(request(api, path), `list ${what}`);
      if (response.status !== 200)
        return yield* failed(`Listing ${what} returned HTTP ${response.status}.`);
      return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.catch(() => Effect.fail(failed(`Listing ${what} returned an unexpected answer.`))),
      );
    });
  const remove = (api: Service, path: string, what: string, body?: unknown) =>
    Effect.gen(function* () {
      let outgoing = HttpClientRequest.setMethod("DELETE")(request(api, path));
      if (body !== undefined)
        outgoing = yield* HttpClientRequest.bodyJson(body)(outgoing).pipe(
          Effect.catch(() =>
            Effect.fail(failed(`Could not encode the request to delete ${what}.`)),
          ),
        );
      const response = yield* send(outgoing, `delete ${what}`);
      if (response.status === 404 || (response.status >= 200 && response.status < 300)) return;
      return yield* failed(`Deleting ${what} returned HTTP ${response.status}.`);
    });
  return { account, get, remove };
});

const ResultInfo = Schema.optional(
  Schema.Struct({
    page: Schema.optional(Schema.Int),
    total_pages: Schema.optional(Schema.Int),
    cursor: Schema.optional(Schema.NullOr(Schema.String)),
    is_truncated: Schema.optional(Schema.Union([Schema.Boolean, Schema.String])),
  }),
);
type Info = typeof ResultInfo.Type;
const Envelope = <S extends Schema.Top>(result: S) =>
  Schema.Struct({ success: Schema.Literal(true), result, result_info: ResultInfo });
/** Whether a listing says more follows: another page, a cursor, or a truncated result. */
const hasMore = (info: Info) =>
  info !== undefined &&
  ((info.total_pages !== undefined && (info.page ?? 1) < info.total_pages) ||
    (info.cursor !== undefined && info.cursor !== null && info.cursor !== "") ||
    info.is_truncated === true ||
    info.is_truncated === "true");
/** A listing that must be complete in one answer. */
const whole = <A extends { readonly result_info?: Info }>(page: A, what: string) =>
  hasMore(page.result_info)
    ? Effect.fail(failed(`Listing ${what} returned only part of the list.`))
    : Effect.succeed(page);

const Worker = Schema.Struct({
  id: Schema.String,
  tags: Schema.NullOr(Schema.Array(Schema.String)),
});
const Zone = Schema.Struct({ id: Schema.String, name: Schema.String });
const Route = Schema.Struct({
  id: Schema.String,
  pattern: Schema.String,
  script: Schema.optional(Schema.String),
});
const Domain = Schema.Struct({
  id: Schema.String,
  hostname: Schema.String,
  service: Schema.String,
});
const Workflow = Schema.Struct({ name: Schema.String, script_name: Schema.String });
const Bucket = Schema.Struct({ name: Schema.String });
const Record = Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.String });
const Destination = Schema.Struct({ slug: Schema.String, name: Schema.String });
const Hyperdrive = Schema.Struct({ id: Schema.String, name: Schema.String });
const Certificate = Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) });
const NeonBranch = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  default: Schema.Boolean,
});
const Named = Schema.Struct({ id: Schema.String, name: Schema.String });

interface Located {
  readonly zone: string;
  readonly id: string;
  readonly name: string;
}
/** Everything the stage owns that removal by name deletes, and what stops removal. */
export interface StageInventory {
  readonly workers: ReadonlyArray<string>;
  readonly routes: ReadonlyArray<{
    readonly zone: string;
    readonly id: string;
    readonly pattern: string;
  }>;
  readonly domains: ReadonlyArray<{ readonly id: string; readonly hostname: string }>;
  readonly workflows: ReadonlyArray<string>;
  readonly buckets: ReadonlyArray<string>;
  readonly records: ReadonlyArray<Located>;
  readonly appRecords: ReadonlyArray<Located>;
  readonly destinations: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  readonly branches: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly monitors: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly tokens: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** The labels under the app zone that the stage's own AppPages routes serve. */
  readonly appBases: ReadonlyArray<string>;
  /** Reasons removal by name must not start; it removes nothing while any is present. */
  readonly blockers: ReadonlyArray<string>;
}
const removable = [
  "workers",
  "routes",
  "domains",
  "workflows",
  "buckets",
  "records",
  "appRecords",
  "destinations",
  "branches",
  "monitors",
  "tokens",
] as const;
/** How many resources of the stage are left to remove. */
export const inventoryCount = (inventory: StageInventory) =>
  removable.reduce((sum, kind) => sum + inventory[kind].length, 0);

/**
 * Read-only: what the selectors match for one stage. `knownAppBases` keeps the stage's app bases
 * once its routes are gone, for the checks during and after removal.
 */
export const stageInventory = (slug: string, knownAppBases: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const api = yield* client;
    const stage = `${testStagePrefix}${slug}`;
    const testZone = yield* Config.String("TEST_STAGE_DOMAIN").pipe(
      Config.withDefault("executor.engineering"),
    );
    const appZone = yield* Config.NonEmptyString("EXECUTOR_APP_DOMAIN_ZONE");
    const neonProject = yield* Config.NonEmptyString("TEST_STAGE_NEON_PROJECT_ID");
    const accountPath = `/accounts/${encodeURIComponent(api.account)}`;
    const blockers: string[] = [];
    const listWhole = <S extends Schema.Top>(path: string, result: S, what: string) =>
      api
        .get("cloudflare", path, Envelope(result), what)
        .pipe(Effect.flatMap((page) => whole(page, what)));

    const own = (yield* listWhole(
      `${accountPath}/workers/scripts`,
      Schema.Array(Worker),
      "Workers",
    )).result.filter(
      (worker) =>
        worker.tags?.includes(`alchemy:stack:${stack}`) === true &&
        worker.tags.includes(`alchemy:stage:${stage}`),
    );
    const workers = own.map((worker) => worker.id);
    const owned = new Set(workers);
    const ownsScript = (script: string | undefined) =>
      script !== undefined &&
      (owned.has(script) ||
        workerIds.some((id) => isPhysicalName(script, id, stage, workerNameLength)));
    const isAppPages = (script: string | undefined) =>
      script !== undefined && isPhysicalName(script, "AppPages", stage, workerNameLength);
    const servesApps = own.some((worker) => worker.tags?.includes("alchemy:id:AppPages") === true);

    const zones: Array<typeof Zone.Type> = [];
    for (let page = 1; ; page += 1) {
      const listed = yield* api.get(
        "cloudflare",
        `/zones?per_page=50&page=${page}&account.id=${encodeURIComponent(api.account)}`,
        Envelope(Schema.Array(Zone)),
        "zones",
      );
      zones.push(...listed.result);
      if (!hasMore(listed.result_info)) break;
    }
    const zoneNamed = (name: string) => {
      const matches = zones.filter((candidate) => candidate.name === name);
      return matches.length === 1
        ? Effect.succeed(matches[0]!)
        : Effect.fail(failed(`Expected exactly one zone named ${name}.`));
    };
    const test = yield* zoneNamed(testZone);
    const app = yield* zoneNamed(appZone);

    // A Worker's route may sit in any zone the account holds.
    const routes = (yield* Effect.forEach(zones, (candidate) =>
      listWhole(
        `/zones/${candidate.id}/workers/routes`,
        Schema.Array(Route),
        `routes in ${candidate.name}`,
      ).pipe(
        Effect.map((page) =>
          page.result
            .filter((route) => ownsScript(route.script))
            .map((route) => ({
              zone: candidate.id,
              id: route.id,
              pattern: route.pattern,
              appPages: isAppPages(route.script),
            })),
        ),
      ),
    )).flat();
    const appRoute = new RegExp(`^\\*\\.([a-z0-9-]+)\\.${escape(appZone)}/\\*$`, "u");
    const appBases = [
      ...new Set([
        ...routes
          .filter((route) => route.zone === app.id && route.appPages)
          .flatMap((route) => appRoute.exec(route.pattern)?.[1] ?? []),
        ...knownAppBases,
      ]),
    ];
    if (servesApps && appBases.length === 0)
      blockers.push(
        `test-${slug} serves apps but none of its routes names its app base, so its app-zone records cannot be found.`,
      );

    const domains = (yield* listWhole(
      `${accountPath}/workers/domains`,
      Schema.Array(Domain),
      "custom domains",
    )).result
      .filter((domain) => ownsScript(domain.service))
      .map(({ id, hostname }) => ({ id, hostname }));

    const workflows: string[] = [];
    for (let page = 1; ; page += 1) {
      const listed = yield* api.get(
        "cloudflare",
        `${accountPath}/workflows?per_page=100&page=${page}`,
        Envelope(Schema.Array(Workflow)),
        "Workflows",
      );
      workflows.push(
        ...listed.result.filter((flow) => ownsScript(flow.script_name)).map((flow) => flow.name),
      );
      if (!hasMore(listed.result_info)) break;
    }

    const buckets: string[] = [];
    for (let cursor = ""; ;) {
      const listed = yield* api.get(
        "cloudflare",
        `${accountPath}/r2/buckets?per_page=1000&name_contains=${encodeURIComponent(`${stack}-`)}${cursor === "" ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
        Envelope(Schema.Struct({ buckets: Schema.Array(Bucket) })),
        "buckets",
      );
      buckets.push(
        ...listed.result.buckets
          .map((bucket) => bucket.name)
          .filter(
            (name) =>
              isPhysicalName(name, "AppBuilds", stage, 63) ||
              isPhysicalName(name, "SiteAssets", stage, 63),
          ),
      );
      const next = listed.result_info?.cursor;
      if (next === undefined || next === null || next === "") break;
      cursor = next;
    }

    const testRecord = new RegExp(`^(?:[^.]+\\.)?${escape(slug)}\\.${escape(testZone)}$`, "u");
    const records = (yield* listWhole(
      `/zones/${test.id}/dns_records?per_page=5000&name.contains=${encodeURIComponent(`${slug}.`)}`,
      Schema.Array(Record),
      `DNS records in ${testZone}`,
    )).result
      .filter((record) => testRecord.test(record.name))
      .map(({ id, name }) => ({ zone: test.id, id, name }));
    const appRecords = (yield* Effect.forEach(appBases, (base) =>
      listWhole(
        `/zones/${app.id}/dns_records?per_page=5000&name.contains=${encodeURIComponent(`.${base}.${appZone}`)}`,
        Schema.Array(Record),
        `DNS records in ${appZone}`,
      ).pipe(
        Effect.map((page) =>
          page.result
            .filter(
              (record) =>
                record.name.endsWith(`.${base}.${appZone}`) &&
                // Production's record for a team named like the base.
                record.name !== `*.${base}.${appZone}`,
            )
            .map(({ id, name }) => ({ zone: app.id, id, name })),
        ),
      ),
    )).flat();

    const destinations = (yield* listWhole(
      `${accountPath}/workers/observability/destinations`,
      Schema.Array(Destination),
      "observability destinations",
    )).result.filter(
      (destination) => destination.name === `executor-next-${stage}-platform-traces`,
    );

    const hyperdrive = (yield* listWhole(
      `${accountPath}/hyperdrive/configs`,
      Schema.Array(Hyperdrive),
      "Hyperdrive configurations",
    )).result.filter((config) => isPhysicalName(config.name, "DatabaseConnection", stage, 64));
    if (hyperdrive.length > 0)
      blockers.push(
        `test-${slug} has a Hyperdrive connection, so it uses PlanetScale, which removal by name does not cover.`,
      );
    const certificates = (yield* listWhole(
      `${accountPath}/mtls_certificates`,
      Schema.Array(Certificate),
      "mTLS certificates",
    )).result.filter(
      (certificate) =>
        certificate.name !== null &&
        isPhysicalName(certificate.name, "DatabaseCertificateAuthority", stage, 64),
    );
    if (certificates.length > 0)
      blockers.push(
        `test-${slug} has a database certificate, which removal by name does not cover.`,
      );

    // An Artifacts namespace has no Alchemy record: the API Worker creates repositories at run time.
    const namespace = `executor-${stage}-apps`;
    const repositories = yield* listWhole(
      `${accountPath}/artifacts/namespaces/${encodeURIComponent(namespace)}/repos`,
      Schema.Array(Schema.Unknown),
      `Artifacts namespace ${namespace}`,
    ).pipe(
      Effect.map((page) => Option.some(page.result.length)),
      Effect.catch((error) => {
        blockers.push(`${error.message} Removal by name cannot confirm it holds no repositories.`);
        return Effect.succeed(Option.none<number>());
      }),
    );
    if (Option.isSome(repositories) && repositories.value > 0)
      blockers.push(
        `Artifacts namespace ${namespace} holds ${repositories.value} repositories, which removal by name does not delete.`,
      );

    const listedBranches = yield* api.get(
      "neon",
      `/projects/${encodeURIComponent(neonProject)}/branches?search=${encodeURIComponent(stage)}`,
      Schema.Struct({
        branches: Schema.Array(NeonBranch),
        pagination: Schema.optional(Schema.Struct({ next: Schema.optional(Schema.String) })),
      }),
      "Neon branches",
    );
    if (listedBranches.pagination?.next !== undefined && listedBranches.pagination.next !== "")
      return yield* failed("Listing Neon branches returned only part of the list.");
    const branches = listedBranches.branches
      .filter((branch) => branch.name === stage && !branch.default)
      .map(({ id, name }) => ({ id, name }));
    const monitors = (yield* api.get(
      "axiom",
      "/monitors",
      Schema.Array(Named),
      "Axiom monitors",
    )).filter((monitor) => monitor.name.startsWith(`Executor ${stage}: `));
    const tokens = (yield* api.get("axiom", "/tokens", Schema.Array(Named), "Axiom tokens")).filter(
      (token) => token.name === `executor-next-${stage}-ingest`,
    );
    return {
      workers,
      routes: routes.map(({ zone, id, pattern }) => ({ zone, id, pattern })),
      domains,
      workflows,
      buckets,
      records,
      appRecords,
      destinations,
      branches,
      monitors,
      tokens,
      appBases,
      blockers,
    } satisfies StageInventory;
  });

/** Why the stage's records forbid removal by name, decided before anything is read elsewhere. */
export const recordBlockers = (slug: string, fqns: ReadonlyArray<string>) => {
  const blockers: string[] = [];
  const planetscale = fqns.filter((fqn) => recordKinds[fqn] === "planetscale");
  if (planetscale.length > 0)
    blockers.push(
      `test-${slug}'s records name PlanetScale resources (${planetscale.join(", ")}), which removal by name does not cover.`,
    );
  const unknown = fqns.filter((fqn) => recordKinds[fqn] === undefined);
  if (unknown.length > 0)
    blockers.push(
      `test-${slug}'s records name resources removal by name does not know: ${unknown.join(", ")}.`,
    );
  return blockers;
};

/** Empty a bucket through the REST API, then delete it; a bulk delete that removes nothing stops. */
const removeBucket = (name: string) =>
  Effect.gen(function* () {
    const api = yield* client;
    const path = `/accounts/${encodeURIComponent(api.account)}/r2/buckets/${encodeURIComponent(name)}`;
    const settle = yield* Config.Duration("TEST_STAGE_REMOVAL_SETTLE").pipe(
      Config.withDefault(Duration.seconds(10)),
    );
    for (let attempt = 1; ; attempt += 1) {
      let previous = "";
      for (;;) {
        const page = yield* api.get(
          "cloudflare",
          `${path}/objects?per_page=1000`,
          Envelope(Schema.Array(Schema.Struct({ key: Schema.String }))),
          `objects in bucket ${name}`,
        );
        if (page.result.length === 0) break;
        const keys = page.result.map((object) => object.key).join("\n");
        if (keys === previous)
          return yield* failed(`Deleting objects in bucket ${name} removed none of them.`);
        previous = keys;
        yield* api.remove(
          "cloudflare",
          `${path}/objects`,
          `objects in bucket ${name}`,
          keys.split("\n"),
        );
      }
      const deleted = yield* api.remove("cloudflare", path, `bucket ${name}`).pipe(Effect.result);
      if (deleted._tag === "Success") return;
      // R2 can refuse to delete a bucket it has just reported empty; the listing stays the authority.
      if (attempt === 4) return yield* Effect.fail(deleted.failure);
      yield* Effect.sleep(settle);
    }
  });

/**
 * Remove everything the inventory lists, then the records. App-zone DNS goes first and is
 * confirmed gone while the AppPages route that names the app base still exists; the Workers go
 * next, and what is left is found by name. A run that stops at any point leaves nothing a rerun
 * cannot find. The records go only after a check finds nothing left.
 */
export const destroyUnreadableStage = (slug: string, fqns: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const blockedByRecords = recordBlockers(slug, fqns);
    if (blockedByRecords.length > 0)
      return yield* failed(`${blockedByRecords.join(" ")} Nothing was removed.`);
    const api = yield* client;
    const accountPath = `/accounts/${encodeURIComponent(api.account)}`;
    const neonProject = yield* Config.NonEmptyString("TEST_STAGE_NEON_PROJECT_ID");
    const settle = yield* Config.Duration("TEST_STAGE_REMOVAL_SETTLE").pipe(
      Config.withDefault(Duration.seconds(10)),
    );
    const found = yield* stageInventory(slug);
    if (found.blockers.length > 0)
      return yield* failed(`${found.blockers.join(" ")} Nothing was removed.`);
    yield* Console.log(
      `test-${slug}'s records predate the state store's current key; removing its ${inventoryCount(found)} resource(s) by name.`,
    );
    const each = <A>(
      items: ReadonlyArray<A>,
      target: (item: A) => readonly [Service, string, string],
    ) =>
      Effect.forEach(
        items,
        (item) => {
          const [service, path, what] = target(item);
          return api.remove(service, path, what);
        },
        { discard: true },
      );
    const recheck = () => stageInventory(slug, found.appBases);

    yield* each(found.appRecords, (record) => [
      "cloudflare",
      `/zones/${record.zone}/dns_records/${record.id}`,
      `DNS record ${record.name}`,
    ]);
    const appLeft = (yield* recheck()).appRecords;
    if (appLeft.length > 0)
      return yield* failed(
        `test-${slug} still has ${appLeft.length} app-zone DNS record(s); nothing else was removed.`,
      );
    // Writers go first. Their routes, domains and Workflows stay findable by script name.
    yield* each(found.workers, (name) => [
      "cloudflare",
      `${accountPath}/workers/scripts/${encodeURIComponent(name)}?force=true`,
      `Worker ${name}`,
    ]);
    yield* each(found.routes, (route) => [
      "cloudflare",
      `/zones/${route.zone}/workers/routes/${route.id}`,
      `route ${route.pattern}`,
    ]);
    yield* each(found.domains, (domain) => [
      "cloudflare",
      `${accountPath}/workers/domains/${domain.id}`,
      `custom domain ${domain.hostname}`,
    ]);
    yield* each(found.workflows, (name) => [
      "cloudflare",
      `${accountPath}/workflows/${encodeURIComponent(name)}`,
      `Workflow ${name}`,
    ]);
    yield* each(found.destinations, (destination) => [
      "cloudflare",
      `${accountPath}/workers/observability/destinations/${encodeURIComponent(destination.slug)}`,
      `observability destination ${destination.name}`,
    ]);
    yield* Effect.forEach(found.buckets, removeBucket, { discard: true });
    // Cloudflare removes a custom domain's own record with the domain, so read the records again.
    yield* each((yield* recheck()).records, (record) => [
      "cloudflare",
      `/zones/${record.zone}/dns_records/${record.id}`,
      `DNS record ${record.name}`,
    ]);
    yield* each(found.branches, (branch) => [
      "neon",
      `/projects/${encodeURIComponent(neonProject)}/branches/${branch.id}`,
      `Neon branch ${branch.name}`,
    ]);
    yield* each(found.monitors, (monitor) => [
      "axiom",
      `/monitors/${monitor.id}`,
      `Axiom monitor ${monitor.name}`,
    ]);
    yield* each(found.tokens, (token) => [
      "axiom",
      `/tokens/${token.id}`,
      `Axiom token ${token.name}`,
    ]);
    // Deletions can take a few seconds to leave the listings.
    let left = yield* recheck();
    for (let check = 0; check < 6 && inventoryCount(left) > 0; check += 1) {
      yield* Effect.sleep(settle);
      left = yield* recheck();
    }
    if (inventoryCount(left) > 0)
      return yield* failed(
        `test-${slug} still has ${inventoryCount(left)} resource(s): ${removable
          .filter((kind) => left[kind].length > 0)
          .map((kind) => `${left[kind].length} ${kind}`)
          .join(", ")}. Its records were kept, so a rerun finds it again.`,
      );
    yield* forgetState(slug);
    yield* Console.log(`Removed test-${slug} by name; no resource or record of it remains.`);
  });
