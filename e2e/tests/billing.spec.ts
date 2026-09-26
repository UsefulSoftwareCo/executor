import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { BillingTarget } from "../support/billing.ts";

layer(BillingTarget.layer, { excludeTestServices: true })("Cloud billing sandbox", (it) => {
  it.effect(
    "isolates seat plans and runs tools and MCP without an execution balance",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const target = yield* BillingTarget;
          const prefix = `/api/organizations/${target.organization.id}`;
          const overview = yield* target.owner("GET", `${prefix}/billing`);
          expect(overview.status).toBe(200);
          const parsed = yield* target.json(
            Schema.Struct({ plans: Schema.Array(Schema.Struct({ id: Schema.String })) }),
            overview.text,
          );
          expect(parsed.plans.map((plan) => plan.id).sort()).toEqual(
            [
              `${target.namespace}-free`,
              `${target.namespace}-team`,
              `${target.namespace}-enterprise`,
            ].sort(),
          );
          expect((yield* target.anonymous("GET", `${prefix}/billing`)).status).toBe(401);
          expect((yield* target.member("GET", `${prefix}/billing`)).status).toBe(403);
          expect(
            (yield* target.owner("POST", `${prefix}/billing/checkout`, { plan: "team" })).status,
          ).toBe(400);
          expect(yield* target.executionBalance).toBeUndefined();
          const name = `Billing ${crypto.randomUUID().slice(0, 8)}`;
          const deployed = yield* target.owner("POST", `${prefix}/apps/deploy`, {
            name,
            files: [
              {
                path: "index.ts",
                content: `
      import { defineApp, mutation, object, string } from "apps";
      import { always } from "apps/operations/approval";
      export default defineApp({accounts:{}}, async () => ({ mutations:{
        echo: mutation({input:object({message:string()})},async(_,input)=>input),
        guarded: mutation({input:object({message:string()}),approval:always()},async(_,input)=>input)
      }}));`,
              },
            ],
          });
          expect(deployed.status).toBe(200);
          const app = yield* target.json(
            Schema.Struct({ id: Schema.String, slug: Schema.String }),
            deployed.text,
          );
          yield* Effect.addFinalizer(() =>
            target.owner("DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const call = () =>
            target.owner("POST", `${prefix}/apps/${app.id}/tools/call`, {
              tool: "mutations.echo",
              input: { message: "synthetic" },
            });
          expect(
            (yield* target.member("POST", `${prefix}/apps/${app.id}/tools/call`, {
              tool: "mutations.echo",
              input: { message: "denied" },
            })).status,
          ).toBe(403);
          expect((yield* call()).status).toBe(200);
          const mcp = yield* target.connectMcp;
          const code = `return await Promise.all([tools[${JSON.stringify(app.slug)}].mutations.echo({message:"one"}), tools[${JSON.stringify(app.slug)}].mutations.echo({message:"two"})]);`;
          const executed = yield* mcp.call("execute", { code });
          expect(executed.isError).not.toBe(true);
          const completed = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              status: Schema.Literal("completed"),
              execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
            }),
          )(executed.structuredContent);
          expect(completed.execution.value).toEqual([{ message: "one" }, { message: "two" }]);
          const pending = yield* mcp.call("execute", {
            code: `return await tools[${JSON.stringify(app.slug)}].mutations.guarded({message:"approved"});`,
          });
          const result = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              status: Schema.Literal("approval-required"),
              requestId: Schema.String,
            }),
          )(pending.structuredContent);
          const resumed = yield* mcp.call("resume", {
            requestId: result.requestId,
            response: { action: "accept" },
          });
          expect(resumed.isError).not.toBe(true);
          const approved = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              status: Schema.Literal("completed"),
              execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
            }),
          )(resumed.structuredContent);
          expect(approved.execution.value).toEqual({ message: "approved" });
          const concurrent = yield* Effect.all([call(), call()], { concurrency: 2 });
          expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
          const extra = yield* mcp.call("execute", { code: "return 1;" });
          expect(extra.isError).not.toBe(true);
          expect(yield* target.executionBalance).toBeUndefined();
          expect(
            (yield* target.owner("POST", `${prefix}/billing/checkout`, {
              plan: `${target.namespace}-free`,
            })).status,
          ).toBe(200);
          expect(yield* target.seats).toBe(3);
          const listed = yield* target.owner(
            "GET",
            `/api/auth/organization/list-members?organizationId=${target.organization.id}`,
          );
          const members = yield* target.json(
            Schema.Struct({
              members: Schema.Array(Schema.Struct({ id: Schema.String, role: Schema.String })),
            }),
            listed.text,
          );
          const member = members.members.find((value) => value.role === "member");
          if (!member) return yield* Effect.die("Missing synthetic member");
          yield* Effect.addFinalizer(() =>
            target.owner("POST", "/api/devtools/account", { role: "member" }).pipe(Effect.orDie),
          );
          const removed = yield* target.owner("POST", "/api/auth/organization/remove-member", {
            organizationId: target.organization.id,
            memberIdOrEmail: member.id,
          });
          expect(removed.status).toBe(200);
          expect(yield* target.seats).toBe(2);
        }),
      ),
    180000,
  );
});
