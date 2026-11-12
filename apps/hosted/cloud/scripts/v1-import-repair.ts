/**
 * One-off repair of the v1 organizations moved before the importer took v1's approval stamps
 * (`notes/v1-import.md`, "Repair of moved organizations"): MCP tools v1 asked before only from its
 * stamp, which v2 asks before only while the server still marks them destructive. It also lists
 * each app deployed again since the import, whose users may have changed its rules.
 *
 *   (default)  Dry run. Reads v1 and v2 directly, every statement in a read-only transaction over
 *              TLS on sessions that default to read-only, and writes nothing. Prints, per moved
 *              organization, each MCP app and the tools that would get `always`, with the
 *              importer's own code (`repair.ts`). Needs V1_URL and V2_URL; --orgs-out writes the
 *              organizations with a change, one per line, for --plan and --apply.
 *   --plan     Asks the deployment to plan each organization's repair, without writing:
 *              the same changes, and for each app whether its deployed files are still the
 *              importer's output, which the dry run cannot read.
 *   --apply    Asks the deployment to repair each organization: it deploys each app's new version
 *              through the importer's deploy call.
 *
 *   --restore <file>
 *              Runs an earlier version of each listed imported app again, while the app still runs
 *              the version expected: a JSON array of `{ organization, app, version, expected }`
 *              (`restoreApp` in `repair.ts`). It gives an app whose users changed its approvals in
 *              v2 back the version a repair replaced.
 *
 * --plan and --apply call `/api/internal/v1-import/orgs/:org/repair` on --origin with
 * V1_IMPORT_OPERATOR_TOKEN, for the organizations named with --org or listed in --orgs-file;
 * --restore calls `/api/internal/v1-import/orgs/:org/restore` on --origin for each listed app.
 *
 *   agent-vault run \
 *     --env 'V1_URL=op://Agents/Production Planetscale Url/credential' \
 *     --env 'V2_URL=op://Agents/6jic7icrdjy3ksckhtg2wnygli/database_url' \
 *     -- node apps/hosted/cloud/scripts/v1-import-repair.ts [--org <v1 org id>]... [--orgs-out <file>]
 *
 * The output names organizations, apps and accounts: keep it private, out of PRs, issues and logs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { PgClient } from "@effect/sql-pg";
import { Config, Console, Context, Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { SqlClient } from "effect/sql";
import { importedMembers, planStampedApps } from "../src/implementation/v1-import/repair.ts";
import {
  allSnapshotTables,
  readSnapshot,
  readOpenApiOperations,
  readTools,
} from "../src/implementation/v1-import/source.ts";
import { makeImportStore } from "../src/implementation/v1-import/store.ts";
import { V1ImportUnavailable } from "../src/contracts/v1-import.ts";

const usage =
  "Usage: node apps/hosted/cloud/scripts/v1-import-repair.ts [--plan | --apply --origin <https://...>] [--org <v1 org id>]... [--orgs-file <file>] [--orgs-out <file>] | --restore <file> --origin <https://...>";

const Moved = Schema.Struct({ org_id: Schema.String });
/** One app to restore: its v1 organization, and the version to run while it still runs `expected`. */
const Restores = Schema.Array(
  Schema.Struct({
    organization: Schema.String,
    app: Schema.String,
    version: Schema.String,
    expected: Schema.String,
  }),
);
const AppRow = Schema.Struct({ active: Schema.NullOr(Schema.String) });

/** How many organizations the dry run reads at once, each on its own connection. */
const concurrency = 8;

/** A database client whose sessions default to read-only. */
const readOnlyClient = (url: Redacted.Redacted) =>
  Layer.build(
    PgClient.layer({
      url,
      ssl: { rejectUnauthorized: true },
      maxConnections: concurrency,
      prepare: false,
      startupParameters: { default_transaction_read_only: "on" },
    }),
  ).pipe(Effect.map(Context.get(SqlClient.SqlClient)));

/**
 * Run a read in its own read-only transaction on this client, as the importer reads v1. Reads on
 * the two clients never nest.
 */
const reading =
  (sql: SqlClient.SqlClient) =>
  <A, E, R>(work: Effect.Effect<A, E, R>) =>
    sql.withTransaction(sql`set transaction read only`.pipe(Effect.andThen(work))).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchTag("SqlError", () => Effect.fail(new V1ImportUnavailable())),
    );

const dryRun = (only: readonly string[], orgsOut: string | undefined) =>
  Effect.gen(function* () {
    const v1 = yield* readOnlyClient(yield* Config.Redacted("V1_URL"));
    const v2 = yield* readOnlyClient(yield* Config.Redacted("V2_URL"));
    const v1Read = reading(v1);
    const v2Read = reading(v2);
    const store = makeImportStore(v2);
    const find: typeof store.find = (kind, id) => v2Read(store.find(kind, id));
    const deployedSince: typeof store.deployedSince = (organization) =>
      v2Read(store.deployedSince(organization));
    const moved = (yield* v1Read(
      v1`select org_id from org_moved_to_v2 where state = 'moved' order by org_id`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Moved))),
      ),
    )).map((row) => row.org_id);
    const organizations = only.length === 0 ? moved : moved.filter((id) => only.includes(id));
    yield* Console.log(`${organizations.length} moved organizations\n`);
    const totals = {
      appOrgs: 0,
      apps: 0,
      tools: 0,
      missingApps: 0,
    };
    const changed: string[] = [];
    // A few organizations at a time; each one's lines print together, in organization order.
    const planned = yield* Effect.forEach(
      organizations,
      (organization) =>
        Effect.gen(function* () {
          const out: string[] = [];
          const recorded = yield* find("organization", organization);
          const target =
            recorded?.status === "imported" && recorded.v2_id !== null
              ? yield* v2Read(store.target(recorded.v2_id))
              : undefined;
          if (target === undefined) {
            out.push(`${organization}: not imported into a live v2 organization; skipped\n`);
            return out;
          }
          const members = yield* v2Read(importedMembers(v2, target.id));
          const [first, ...rest] = members.map((member) => member.v1);
          if (first === undefined) {
            out.push(`${organization}: no imported members; skipped\n`);
            return out;
          }
          const subjects = [first, ...rest] as const;
          const snapshot = yield* v1Read(
            readSnapshot(organization, subjects, subjects.length > 1, allSnapshotTables),
          );
          const source = {
            tools: (tenant: string, members: readonly [string, ...string[]], integration: string) =>
              v1Read(readTools(tenant, members, integration)),
            openApiOperations: (tenant: string, integration: string) =>
              v1Read(readOpenApiOperations(tenant, integration)),
          };
          const apps = yield* planStampedApps(snapshot, source, { find, deployedSince });
          if (apps.length === 0) return out;
          out.push(`${organization} -> v2 ${target.id} (${target.slug})`);
          let live = 0;
          for (const app of apps) {
            const [row] = yield* v2Read(
              v2`select active_deployment as active from executor_apps where id = ${app.app}`.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AppRow))),
              ),
            );
            const state =
              row === undefined ? " (app removed)" : row.active === null ? " (not deployed)" : "";
            if (row === undefined || row.active === null) totals.missingApps++;
            else {
              live++;
              totals.apps++;
              totals.tools += app.always.length;
            }
            const unlisted =
              app.unlisted === null
                ? ""
                : `; tools v1 did not list: left out ${app.unlisted.omitted.join(", ") || "none"}, always ${app.unlisted.always.join(", ") || "none"}${app.unlisted.otherwise === null ? "" : `, any other ${app.unlisted.otherwise === "always" ? "asks always" : "left out"}`}`;
            const since = app.deployedSince ? " (deployed since the import)" : "";
            out.push(
              `  app ${app.app} (${app.integration.name ?? app.integration.slug})${state}${since}: always ${app.always.join(", ") || "none"}${unlisted}`,
            );
          }
          if (live > 0) {
            totals.appOrgs++;
            changed.push(organization);
          }
          out.push("");
          return out;
        }),
      { concurrency },
    );
    for (const out of planned) for (const line of out) yield* Console.log(line);
    yield* Console.log(
      [
        "Summary",
        `  apps to deploy: ${totals.apps}, ${totals.tools} stamped tools always, in ${totals.appOrgs} organizations`,
        `  apps removed or not deployed (skipped): ${totals.missingApps}`,
        `  organizations with a change: ${changed.length}`,
      ].join("\n"),
    );
    if (orgsOut !== undefined)
      writeFileSync(
        orgsOut,
        changed
          .toSorted()
          .map((id) => `${id}\n`)
          .join(""),
        {
          mode: 0o600,
        },
      );
  }).pipe(Effect.scoped);

/** An HTTP client for the operator routes on `origin`, with the operator token. */
const operatorClient = (origin: string) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("V1_IMPORT_OPERATOR_TOKEN");
    return (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.prependUrl(origin),
          HttpClientRequest.bearerToken(Redacted.value(token)),
        ),
      ),
    );
  });

const restore = (origin: string, file: string) =>
  Effect.gen(function* () {
    const apps = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Restores))(
      readFileSync(file, "utf8"),
    );
    const http = yield* operatorClient(origin);
    for (const { organization, ...app } of apps) {
      const response = yield* HttpClientRequest.post(
        `/api/internal/v1-import/orgs/${encodeURIComponent(organization)}/restore`,
      ).pipe(HttpClientRequest.bodyJsonUnsafe(app), http.execute);
      const body = yield* response.json;
      yield* Console.log(JSON.stringify({ status: response.status, body }));
    }
  }).pipe(Effect.provide(FetchHttpClient.layer));

const remote = (origin: string, organizations: readonly string[], apply: boolean) =>
  Effect.gen(function* () {
    if (organizations.length === 0) return yield* Effect.die(usage);
    const http = yield* operatorClient(origin);
    for (const organization of organizations) {
      const response = yield* HttpClientRequest.post(
        `/api/internal/v1-import/orgs/${encodeURIComponent(organization)}/repair`,
      ).pipe(HttpClientRequest.bodyJsonUnsafe({ apply }), http.execute);
      const body = yield* response.json;
      yield* Console.log(JSON.stringify({ status: response.status, body }));
    }
  }).pipe(Effect.provide(FetchHttpClient.layer));

const program = Effect.gen(function* () {
  const { values } = parseArgs({
    options: {
      plan: { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      origin: { type: "string" },
      org: { type: "string", multiple: true },
      "orgs-file": { type: "string" },
      "orgs-out": { type: "string" },
      restore: { type: "string" },
    },
  });
  if (values.restore !== undefined) {
    if (values.origin === undefined || values.plan || values.apply) return yield* Effect.die(usage);
    return yield* restore(values.origin, values.restore);
  }
  const listed = [
    ...(values.org ?? []),
    ...(values["orgs-file"] === undefined
      ? []
      : readFileSync(values["orgs-file"], "utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "")),
  ];
  if (values.plan || values.apply) {
    if (values.origin === undefined || (values.plan && values.apply))
      return yield* Effect.die(usage);
    return yield* remote(values.origin, listed, values.apply);
  }
  return yield* dryRun(listed, values["orgs-out"]);
});

NodeRuntime.runMain(program);
