/** Execute discovers every app a program can reach, whatever form its access to `tools` takes. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { appsManifest } from "../support/apps-release.ts";

const echoAppSource = (
  name: string,
) => `import { defineApp, query, object, string, router } from "apps";
export default defineApp({}, async () => ({ tools: router({
  echo: query({ input: object({ text: string() }), description: "Echo text from the ${name} fixture" },
    async (_ctx, { text }) => ({ app: ${JSON.stringify(name)}, text })),
}) }));`;

// Discovery of this app always fails, so `unavailableApps` shows whether an execution touched it.
const brokenAppSource = `import { defineApp } from "apps";
export default defineApp({}, async () => {
  throw new Error("Synthetic evaluation failure");
});`;

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ kind: Schema.String, message: Schema.String })),
  }),
  unavailableApps: Schema.Array(Schema.Struct({ app: Schema.String, reason: Schema.String })),
});

layer(HostedLive, { excludeTestServices: true })("MCP execute reach", (it) => {
  it.effect(scenarios.mcpExecuteReach.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const key = yield* body(
          Schema.Struct({
            id: Schema.String,
            key: Schema.RedactedFromValue(Schema.String),
          }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Execute reach",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", {
              keyId: key.id,
            })
            .pipe(Effect.orDie),
        );
        const run = randomUUID().slice(0, 8);
        const deploy = (name: string, content: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} ${run}`,
              files: [{ path: "index.ts", content }, appsManifest],
            });
            expect(response.status).toBe(200);
            return yield* body(App, response);
          });
        const alpha = yield* deploy("Reach alpha", echoAppSource("alpha"));
        const beta = yield* deploy("Reach beta", echoAppSource("beta"));
        const broken = yield* deploy("Reach broken", brokenAppSource);
        const client = yield* mcp.connect(key.key, "execute-reach", {
          organization: actors.organization.id,
        });
        const execute = (label: string, code: string) =>
          Effect.gen(function* () {
            const result = yield* client.use(label, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            );
            yield* evidence.json(
              `${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.json`,
              result.structuredContent,
            );
            const completed = yield* Schema.decodeUnknownEffect(Completed)(
              result.structuredContent,
            );
            return {
              execution: completed.execution,
              touchedBroken: completed.unavailableApps.some((entry) => entry.app === broken.id),
            };
          });
        const echoed = (app: string, text: string) => ({
          ok: true,
          value: { app, text },
        });
        const a = JSON.stringify(alpha.slug);

        // Static member access reaches only the named app.
        const direct = yield* execute(
          "Static member access",
          `return await tools[${a}].echo({ text: "static" });`,
        );
        expect(direct.execution).toMatchObject(echoed("alpha", "static"));
        expect(direct.touchedBroken).toBe(false);

        // Every other use of `tools` can name any app at run time. An app is discovered when the
        // program reaches it, so none of these touch the broken app.
        const dynamic = [
          {
            label: "Computed member access",
            code: `const name = [${a}][0];
return await tools[name].echo({ text: "computed" });`,
            expected: echoed("alpha", "computed"),
          },
          {
            label: "Enumerate tools",
            code: `const slugs = Object.keys(tools);
return slugs.includes(${a}) && slugs.includes(${JSON.stringify(beta.slug)});`,
            expected: { ok: true, value: true },
          },
          {
            label: "Pass tools to a function",
            code: `const call = (all, text) => all[${a}].echo({ text });
return await call(tools, "passed");`,
            expected: echoed("alpha", "passed"),
          },
          {
            label: "Alias tools",
            code: `const all = tools;
return await all[${a}].echo({ text: "aliased" });`,
            expected: echoed("alpha", "aliased"),
          },
          {
            label: "Destructure tools",
            code: `const { [${a}]: app } = tools;
return await app.echo({ text: "destructured" });`,
            // CodeMode rejects destructuring the namespace itself.
            expected: { ok: false, error: { kind: "InvalidDataValue" } },
          },
        ];
        for (const { label, code, expected } of dynamic) {
          const result = yield* execute(label, code);
          expect(result.execution, label).toMatchObject(expected);
          expect(result.touchedBroken, label).toBe(false);
        }

        // A computed access that reaches the broken app discovers it, and reports why it failed.
        const reached = yield* execute(
          "Computed access to the broken app",
          `const name = [${JSON.stringify(broken.slug)}][0];
return await tools[name].echo({ text: "broken" });`,
        );
        expect(reached.execution.ok).toBe(false);
        expect(reached.touchedBroken).toBe(true);

        // The global `search` ranks every app's tools with Executor's search, which reports the
        // broken app it could not list.
        const globalSearch = yield* execute(
          "Global search",
          `return search({ query: "Echo text from the beta fixture" });`,
        );
        expect(globalSearch.execution.ok).toBe(true);
        expect(JSON.stringify(globalSearch.execution.value)).toContain(beta.slug);
        expect(globalSearch.touchedBroken).toBe(true);

        // Source that does not parse still reports CodeMode's parse error.
        const unparsed = yield* execute(
          "Unparsed source",
          `return tools[${JSON.stringify(broken.slug)}][;`,
        );
        expect(unparsed.execution.ok).toBe(false);
        expect(unparsed.touchedBroken).toBe(false);

        // A namespaced search discovers the named app mid-program and nothing else.
        const namespaced = yield* execute(
          "Namespaced search",
          `const found = await tools.search({ namespace: ${JSON.stringify(beta.slug)}, query: "echo" });
const called = await tools[${a}].echo({ text: "static" });
return { paths: found.items.map((item) => item.path), called };`,
        );
        expect(namespaced.execution).toMatchObject({
          ok: true,
          value: {
            paths: [`tools[${JSON.stringify(beta.slug)}].echo`],
            called: { app: "alpha", text: "static" },
          },
        });
        expect(namespaced.touchedBroken).toBe(false);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
