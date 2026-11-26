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
const seeded = 100_000;
const lookupCost = 100;
const appAccountIndex = "executor_webhook_sources_app_account";

interface PlanNode {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly "Index Name"?: string;
  readonly "Total Cost": number;
  readonly "Plan Rows": number;
  readonly Plans?: ReadonlyArray<PlanNode>;
}
const PlanNode: Schema.Codec<PlanNode> = Schema.Struct({
  "Node Type": Schema.String,
  "Relation Name": Schema.optionalKey(Schema.String),
  "Index Name": Schema.optionalKey(Schema.String),
  "Total Cost": Schema.Number,
  "Plan Rows": Schema.Number,
  Plans: Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<PlanNode> => PlanNode))),
});
const Explained = Schema.Tuple([
  Schema.Struct({ "QUERY PLAN": Schema.Tuple([Schema.Struct({ Plan: PlanNode })]) }),
]);
const Owner = Schema.Tuple([Schema.Struct({ id: Schema.String })]);
const nodesOf = (node: PlanNode): ReadonlyArray<PlanNode> => [
  node,
  ...(node.Plans ?? []).flatMap(nodesOf),
];
const plannable = /^\s*(select|insert|update|delete|with)\b/i;
const control = /^\s*(begin|commit|rollback|savepoint|release|set)\b/i;
const sources = "executor_webhook_sources";
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
        const [owner] = yield* locks
          .run({
            sql: `select "userId" as id from member where "organizationId" = $1 and role = 'owner'`,
            params: [actors.organization.id],
          })
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Owner)), Effect.orDie);
        const tag = randomBytes(6).toString("hex"),
          rows = String(seeded);
        const account = `'acc_lookup_' || $1 || '_' || g`;
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            [
              {
                sql: `delete from executor_webhook_sources where app = $1
                    and id like 'src_lookup_' || $2 || '_%'`,
                params: [app.id, tag],
              },
              {
                sql: `delete from executor_accounts where id like 'acc_lookup_' || $1 || '_%'`,
                params: [tag],
              },
            ],
            (statement) => locks.run(statement),
            { discard: true },
          ),
        );
        yield* Effect.forEach(
          [
            {
              sql: `insert into executor_accounts (id, owner, provider, method, label,
                    encrypted_credentials, created_at)
                  select ${account}, a.owner, p.id, 'key', 'Lookup ' || g,
                    '\\x00'::bytea, now()
                  from executor_apps a
                  cross join (select id from executor_providers
                    where definition::text like '%"Lookup service"%' limit 1) p
                  cross join generate_series(1, $2::int) g where a.id = $3`,
              params: [tag, rows, app.id],
            },
            {
              sql: `insert into hosted_account_access (account_id, organization_id, creator_id,
                    kind, personal_user_id)
                  select ${account}, $3, $4, 'personal', $4 from generate_series(1, $2::int) g`,
              params: [tag, rows, actors.organization.id, owner.id],
            },
            {
              sql: `insert into hosted_app_account_links (app, requirement, subject, account,
                    linked_by)
                  select $3, 'service', $4, ${account}, $4 from generate_series(1, $2::int) g`,
              params: [tag, rows, app.id, owner.id],
            },
            {
              sql: `insert into executor_webhook_sources (id, app, owner, account, actor, accounts,
                    config, revision, status, failure, reconciled_deployment, lease, lease_until,
                    created_at)
                  select 'src_lookup_' || $1 || '_' || g, a.id, a.owner, ${account}, $4, '{}', '{}',
                    1, 'ready', null, null, null, now() + interval '1 day', now()
                  from executor_apps a cross join generate_series(1, $2::int) g where a.id = $3`,
              params: [tag, rows, app.id, owner.id],
            },
          ],
          (statement) => locks.run(statement),
          { discard: true },
        );
        for (const table of [
          "executor_accounts",
          "hosted_account_access",
          "hosted_app_account_links",
          "executor_webhook_sources",
        ])
          yield* locks.run({ sql: `analyze ${table}` });

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

        const traced = yield* Effect.forEach([connect, submit], (trace) =>
          telemetry.settled(trace, (found) =>
            found.some((span) => span.operationName.startsWith("http.server")),
          ),
        );
        const ran = [
          ...new Set(
            traced
              .flat()
              .filter((span: DeliveredSpan) => span.operationName === "sql.execute")
              .map((span) => span.tags["db.query.text"] ?? ""),
          ),
        ];
        expect(
          ran.filter((statement) => !plannable.test(statement) && !control.test(statement)),
          "statements a save ran that are neither planned nor transaction control",
        ).toEqual([]);
        const statements = ran.filter((statement) => plannable.test(statement));
        expect(statements.some((statement) => statement.includes("executor_webhook_sources"))).toBe(
          true,
        );
        const plans = yield* Effect.forEach(statements, (statement) =>
          locks.run({ sql: `explain (generic_plan, format json) ${statement}` }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Explained)),
            Effect.orDie,
            Effect.map(([row]) => ({ statement, plan: row["QUERY PLAN"][0].Plan })),
          ),
        );
        yield* evidence.json("save-plans.json", { seeded, lookupCost, plans });
        for (const { statement, plan } of plans) {
          const reads = nodesOf(plan)
            .filter((node) => node["Relation Name"] !== undefined)
            .map((node) => ({
              table: node["Relation Name"],
              type: node["Node Type"],
              cost: node["Total Cost"],
            }));
          expect(
            reads.filter((read) => read.cost > lookupCost),
            `a save reads no table at more than a lookup's cost: ${statement}`,
          ).toEqual([]);
          for (const scan of nodesOf(plan).filter(
            (node) => node["Relation Name"] === sources && node["Node Type"].endsWith("Scan"),
          ))
            expect(
              { type: scan["Node Type"], rows: scan["Plan Rows"] },
              `a save reads ${sources} through an index, for at most one row: ${statement}`,
            ).toEqual({
              type: expect.stringMatching(/^Index (Only )?Scan$/),
              rows: expect.toSatisfy((rows: number) => rows <= 1),
            });
        }
        expect(
          plans.some(({ plan }) =>
            nodesOf(plan).some((node) => node["Index Name"] === appAccountIndex),
          ),
        ).toBe(true);
        expect(saved.status).toBe(200);
      }),
    ),
  );
});
