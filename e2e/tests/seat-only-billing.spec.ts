import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { deployMcpApp } from "../support/mcp-app.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Seat-only billing", (it) => {
  it.effect(scenarios.seatOnlyBilling.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const overview = yield* api.request(actors.owner, "GET", `${prefix}/billing`);
        expect(overview.status).toBe(200);
        expect(overview.body).not.toHaveProperty("usage");
        const billing = yield* body(
          Schema.Struct({
            plans: Schema.Array(
              Schema.Struct({
                id: Schema.String,
                name: Schema.String,
                price: Schema.NullOr(
                  Schema.Struct({
                    amount: Schema.Number,
                    interval: Schema.String,
                    unit: Schema.NullOr(Schema.String),
                  }),
                ),
              }),
            ),
          }),
          overview,
        );
        expect(billing.plans.map((plan) => plan.name).sort()).toEqual([
          "Enterprise",
          "Free",
          "Team",
        ]);
        expect(billing.plans.find((plan) => plan.name === "Team")?.price).toEqual({
          amount: 15,
          interval: "month",
          unit: "member",
        });
        expect((yield* api.request(actors.member, "GET", `${prefix}/billing`)).status).toBe(403);
        const { app, receipt } = yield* deployMcpApp;
        const call = () =>
          api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/tools/call`, {
            tool: "mutations.echo",
            input: { message: "seat-only" },
          });
        // The seeded seat-only catalog has no execution feature at all. The previous
        // billing admission rejects these calls; both must now execute successfully.
        const calls = yield* Effect.all([call(), call()], { concurrency: 2 });
        expect(calls.map((result) => result.status)).toEqual([200, 200]);
        expect(
          (yield* api.request(actors.member, "POST", `${prefix}/apps/${app.id}/tools/call`, {
            tool: "mutations.echo",
            input: { message: "denied" },
          })).status,
        ).toBe(403);
        yield* browser.login(actors.owner);
        yield* browser.use("Open seat-only billing", (page) =>
          page.goto(`/org/${actors.organization.slug}/billing`),
        );
        yield* browser.use("Seat plans render", (page) =>
          page.getByRole("heading", { name: "Team", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Read billing copy", (page) => page.locator("body").innerText()),
        ).not.toMatch(/unlimited executions|executions used|execution allowance/i);
        yield* browser.checkpoint("seat-only-billing");
        const oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        const grant = yield* oauth.authorize;
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "seat-only",
        );
        const result = yield* client.use("Execute without an execution balance", (client, signal) =>
          client.callTool(
            {
              name: "execute",
              arguments: {
                code: `return await tools[${JSON.stringify(app.slug)}].mutations.echo({message:"seat-only"});`,
              },
            },
            undefined,
            { signal },
          ),
        );
        expect(result.isError).not.toBe(true);
        const completed = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            status: Schema.Literal("completed"),
            execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
          }),
        )(result.structuredContent);
        expect(completed.execution.value).toEqual({ message: "seat-only", receipt });
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
