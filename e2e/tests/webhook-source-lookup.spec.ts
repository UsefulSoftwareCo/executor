/**
 * Saving an account links it to the app, which reads the account's webhook source on that app. The
 * read must stay one row however many accounts the app has: the inventory scenario in
 * hosted.spec.ts checks the statements of a save's traces, but only on its first saves, and a
 * statement with the same text can still read more rows as the app grows. Here the app has 100,000
 * sources, and every statement a save runs on the source table is planned by the database: each
 * reads the table through an index, for at most one row.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomBytes } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { cloudLocks } from "../support/cloud-locks.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence, Telemetry, type DeliveredSpan } from "../support/evidence.ts";
import { scenarios } from "../test-plan.ts";

const files = [
  {
    path: "index.ts",
    content: `
import { mutation, defineApp, defineProvider, secrets, object, string, router } from "apps";
const service=defineProvider({name:"Lookup service",auth:{key:secrets({label:"API key",fields:object({token:string()})})}});
export default defineApp({user: { accounts:{service:service.many()} }},async()=>({tools: router({
  echo:mutation({description:"Return input",input:object({message:string()})},async(_,input)=>({message:input.message})),
})}));
`,
  },
  appsManifest,
];
/** Sources the app has before the save, all ready, so the reconciler leaves them alone. */
const seeded = 100_000;
const table = "executor_webhook_sources";
/** The unique `(app, account)` index a lookup of one account's source uses. */
const appAccountIndex = "executor_webhook_sources_app_account";

/** One node of a JSON query plan, as `explain (format json)` returns it. */
interface PlanNode {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly "Index Name"?: string;
  readonly "Plan Rows": number;
  readonly Plans?: ReadonlyArray<PlanNode>;
}
const PlanNode: Schema.Codec<PlanNode> = Schema.Struct({
  "Node Type": Schema.String,
  "Relation Name": Schema.optionalKey(Schema.String),
  "Index Name": Schema.optionalKey(Schema.String),
  "Plan Rows": Schema.Number,
  Plans: Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<PlanNode> => PlanNode))),
});
const Explained = Schema.Tuple([
  Schema.Struct({ "QUERY PLAN": Schema.Tuple([Schema.Struct({ Plan: PlanNode })]) }),
]);
const nodesOf = (node: PlanNode): ReadonlyArray<PlanNode> => [
  node,
  ...(node.Plans ?? []).flatMap(nodesOf),
];
const traceparent = (traceId: string) => `00-${traceId}-${randomBytes(8).toString("hex")}-01`;

layer(HostedLive, { excludeTestServices: true })("Webhook source lookup", (it) => {
  it.effect(scenarios.webhookSourceLookup.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          locks = yield* cloudLocks;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Source lookup checks",
          files,
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        // The Cloud database is shared by every scenario of the run: the seeded rows name this app
        // and a tag of their own, and are removed when the scenario ends.
        const tag = randomBytes(6).toString("hex");
        yield* Effect.acquireRelease(
          locks.run({
            sql: `insert into ${table} (id, app, owner, account, actor, accounts, config, revision,
                status, failure, reconciled_deployment, lease, lease_until, created_at)
              select 'src_lookup_' || $2 || '_' || g, a.id, a.owner, 'acc_lookup_' || $2 || '_' || g,
                null, '{}', '{}', 1, 'ready', null, null, null, now() + interval '1 day', now()
              from executor_apps a cross join generate_series(1, $3::int) g where a.id = $1`,
            params: [app.id, tag, String(seeded)],
          }),
          () =>
            locks.run({
              sql: `delete from ${table} where app = $1 and id like 'src_lookup_' || $2 || '_%'`,
              params: [app.id, tag],
            }),
        );
        yield* locks.run({ sql: `analyze ${table}` });

        // One save of a new account, each request in a trace of its own.
        const connect = randomBytes(16).toString("hex"),
          submit = randomBytes(16).toString("hex");
        const connection = yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
          {},
          { traceparent: traceparent(connect) },
        );
        expect(connection.status).toBe(200);
        const { id } = yield* body(Resource, connection);
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${id}/submit`,
          { method: "key", label: "Lookup account", fields: { token: "synthetic-lookup" } },
          { traceparent: traceparent(submit) },
        );

        // The request's own span ends after every statement it ran, so once it is in, they are.
        const traced = yield* Effect.forEach([connect, submit], (trace) =>
          telemetry.settled(trace, (found) =>
            found.some((span) => span.operationName.startsWith("http.server")),
          ),
        );
        const statements = [
          ...new Set(
            traced
              .flat()
              .filter(
                (span: DeliveredSpan) =>
                  span.operationName === "sql.execute" &&
                  (span.tags["db.query.text"] ?? "").includes(table),
              )
              .map((span) => span.tags["db.query.text"] ?? ""),
          ),
        ];
        // The link reads the account's source and creates it.
        expect(statements.some((statement) => /^\s*select/i.test(statement))).toBe(true);
        const plans = yield* Effect.forEach(statements, (statement) =>
          locks.run({ sql: `explain (generic_plan, format json) ${statement}` }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Explained)),
            Effect.orDie,
            Effect.map(([row]) => ({ statement, plan: row["QUERY PLAN"][0].Plan })),
          ),
        );
        yield* evidence.json("webhook-source-plans.json", { seeded, plans });
        for (const { statement, plan } of plans) {
          const scans = nodesOf(plan).filter(
            (node) => node["Relation Name"] === table && node["Node Type"].endsWith("Scan"),
          );
          for (const scan of scans) {
            expect(
              { type: scan["Node Type"], rows: scan["Plan Rows"] },
              `a save reads ${table} through an index, for at most one row: ${statement}`,
            ).toEqual({
              type: expect.stringMatching(/^Index (Only )?Scan$/),
              rows: expect.toSatisfy((rows: number) => rows <= 1),
            });
          }
        }
        // The account's own source is found by the app and account together.
        expect(
          plans.some(({ plan }) =>
            nodesOf(plan).some((node) => node["Index Name"] === appAccountIndex),
          ),
        ).toBe(true);
        // Checked last, so a read that fails on the seeded rows is still judged by its plan.
        expect(saved.status).toBe(200);
      }),
    ),
  );
});
