/** Approval-resumed workflow controls stay inside the runs of the caller who started them. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { McpClient } from "../support/mcp-client.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";

const source = `import { defineApp, mutation, query, workflow, object, string, router } from "apps";
import { always } from "apps/operations/approval";
const record = workflow({ input: object({ label: string() }) }, async (_ctx, input) => input.label);
const launch = mutation({ input: object({ label: string() }), approval: always() }, async (ctx, input) => {
  const before = await ctx.workflows.list({ limit: 50 });
  const run = await ctx.workflows.start({ workflow: "record", input, key: input.label });
  return { run: run.id, visible: before.items.map((item) => item.id) };
});
const runs = query({ input: object({}) }, async (ctx) =>
  (await ctx.workflows.list({ limit: 50 })).items.map((item) => item.id));
const peek = query({ input: object({ run: string() }) }, async (ctx, input) => {
  try { return (await ctx.workflows.get({ run: input.run })).id; } catch { return null; }
});
export default defineApp({}, { tools: router({
   runs, peek,
   launch,
 }), workflows: { record } });`;

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Access = Schema.Struct({ revision: Schema.String });
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});
const Launched = Schema.Struct({ run: Schema.String, visible: Schema.Array(Schema.String) });
const Run = Schema.Struct({ id: Schema.String });

layer(HostedLive, { excludeTestServices: true })("Workflow actors", (it) => {
  it.effect(scenarios.workflowActors.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        const organization = actors.organization.id,
          prefix = `/api/organizations/${organization}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Workflow actors ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed),
          path = `${prefix}/apps/${app.id}`;
        const keys: { actor: Session; id: string }[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const key of keys)
              yield* api.request(key.actor, "POST", "/api/auth/api-key/delete", { keyId: key.id });
            yield* api.request(actors.owner, "DELETE", path);
          }).pipe(Effect.orDie),
        );
        const access = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        // Two end users, each with a personal MCP key.
        const user = (actor: Session, label: string) =>
          Effect.gen(function* () {
            const issued = yield* api.request(actor, "POST", "/api/auth/api-key/create", {
              name: `Workflow actors ${label}`,
            });
            expect(issued.status).toBe(200);
            const key = yield* body(Token, issued);
            keys.push({ actor, id: key.id });
            const client = yield* mcp.connect(key.key, `workflow-actors-${label}`, {
              organization,
            });
            const tool = (name: string, input: Schema.Json) =>
              `return await tools[${JSON.stringify(app.slug)}].${name}(${JSON.stringify(input)});`;
            const execute = (step: string, name: string, input: Schema.Json) =>
              client
                .use(step, (client, signal) =>
                  client.callTool(
                    { name: "execute", arguments: { code: tool(name, input) } },
                    undefined,
                    { signal },
                  ),
                )
                .pipe(
                  Effect.flatMap((result) =>
                    Schema.decodeUnknownEffect(Completed)(result.structuredContent),
                  ),
                  Effect.map((result) => result.execution.value),
                );
            // The mutation pauses for approval; its body, including workflow controls, runs on resume.
            const launch = (label: string) =>
              Effect.gen(function* () {
                const paused = yield* client.use(`${label}: request approval`, (client, signal) =>
                  client.callTool(
                    {
                      name: "execute",
                      arguments: { code: tool("launch", { label }) },
                    },
                    undefined,
                    { signal },
                  ),
                );
                const pending = yield* Schema.decodeUnknownEffect(Pending)(
                  paused.structuredContent,
                );
                const resumed = yield* client.use(
                  `${label}: approve and resume`,
                  (client, signal) =>
                    client.callTool(
                      {
                        name: "resume",
                        arguments: { requestId: pending.requestId, response: { action: "accept" } },
                      },
                      undefined,
                      { signal },
                    ),
                );
                const completed = yield* Schema.decodeUnknownEffect(Completed)(
                  resumed.structuredContent,
                );
                return yield* Schema.decodeUnknownEffect(Launched)(completed.execution.value);
              });
            return { actor, execute, launch };
          });
        const alice = yield* user(actors.member, "alice"),
          bob = yield* user(actors.admin, "bob");
        const runOf = (actor: Session, id: string) =>
          api.request(actor, "GET", `${path}/workflow-runs/${id}`);

        const first = yield* alice.launch(`alice-${randomUUID().slice(0, 8)}`);
        const second = yield* bob.launch(`bob-${randomUUID().slice(0, 8)}`);
        // Bob's approved mutation listed runs before starting its own; Alice's run must be absent.
        expect(second.visible).not.toContain(first.run);
        // Each run belongs to the actor whose approved call started it.
        expect((yield* body(Run, yield* runOf(alice.actor, first.run))).id).toBe(first.run);
        expect((yield* body(Run, yield* runOf(bob.actor, second.run))).id).toBe(second.run);
        expect((yield* runOf(alice.actor, second.run)).status).toBe(403);
        expect((yield* runOf(bob.actor, first.run)).status).toBe(403);

        // Non-approval queries read through the same actor boundary.
        expect(yield* bob.execute("Bob lists runs", "runs", {})).toEqual([second.run]);
        expect(yield* bob.execute("Bob reads Alice's run", "peek", { run: first.run })).toBe(null);
        expect(yield* alice.execute("Alice lists runs", "runs", {})).toEqual([first.run]);
        expect(yield* alice.execute("Alice reads her run", "peek", { run: first.run })).toBe(
          first.run,
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
