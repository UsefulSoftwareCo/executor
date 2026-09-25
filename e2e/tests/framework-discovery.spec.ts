/** Discover live framework contracts and follow the pinned authoring topics through MCP. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { frameworkSession } from "../support/framework.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";

const Reference = Schema.Struct({ version: Schema.String, digest: Schema.String });
const Description = Schema.Struct({
  reference: Reference,
  entry: Schema.Struct({
    symbol: Schema.String,
    signatures: Schema.Array(Schema.String),
    docs: Schema.String,
  }),
  examples: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
    }),
  ),
});
const Document = Schema.Struct({ content: Schema.String, deployment: Schema.String });

layer(HostedLive, { excludeTestServices: true })("Framework discovery", (it) => {
  it.effect(scenarios.frameworkDiscovery.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          evidence = yield* Evidence;
        const { client, execute, queries, profile } = yield* frameworkSession;
        // These public reads share no results. Start them together while keeping
        // each real MCP request and its live catalog evaluation.
        const [discovered, imported, current, found, guide] = yield* Effect.all(
          [
            execute('return await tools.search({query: "framework", limit: 20});'),
            execute('return await tools.search({query: "context_get", limit: 1});').pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Struct({
                    items: Schema.Array(Schema.Struct({ signature: Schema.String })),
                  }),
                ),
              ),
            ),
            execute(`return await ${queries}.context_get({});`).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.Struct({ organization: Schema.String })),
              ),
            ),
            execute(
              `return await ${queries}.framework_search({query: "withOptimisticUpdate"});`,
            ).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Struct({
                    reference: Reference,
                    items: Schema.Array(Schema.Struct({ symbol: Schema.String })),
                  }),
                ),
              ),
            ),
            client.use("Read the small authoring router", (client, signal) =>
              client.callTool(
                { name: "skills", arguments: { app: "executor", name: "app-authoring" } },
                undefined,
                { signal },
              ),
            ),
          ],
          { concurrency: 5 },
        );
        yield* evidence.json("framework-tool-discovery.json", discovered);
        const tools = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            items: Schema.Array(Schema.Struct({ path: Schema.String, signature: Schema.String })),
          }),
        )(discovered);
        const search = tools.items.find(
          (item) =>
            item.path.endsWith(".queries.framework_search") && item.path.includes(profile.id),
        );
        expect(search?.signature).toContain("remaining: number");
        expect(search?.signature).toContain("digest: string");
        expect(
          tools.items.some(
            (item) =>
              item.path.endsWith(".queries.framework_describe") && item.path.includes(profile.id),
          ),
        ).toBe(true);
        expect(imported.items[0]?.signature).toContain("organization: string");
        expect(imported.items[0]?.signature).toContain("slug: string");
        expect(current.organization).toBe(actors.organization.id);
        expect(found.items.map((item) => item.symbol)).toContain(
          "AppMutation.withOptimisticUpdate",
        );
        const describe = (symbol: string) =>
          execute(
            `return await ${queries}.framework_describe(${JSON.stringify({ symbol, ...found.reference })});`,
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Description)));
        const [hook, update] = yield* Effect.all(
          [describe("apps/react.useAppQuery"), describe("AppMutation.withOptimisticUpdate")],
          { concurrency: 2 },
        );
        expect(hook.entry.signatures.join(" ")).toContain("data: A | undefined");
        expect(hook.entry.signatures.join(" ")).toContain("pending: boolean");
        expect(update.entry.signatures.join(" ")).toContain("OptimisticUpdate<Input>");
        const router = yield* Schema.decodeUnknownEffect(Document)(guide.structuredContent);
        expect(router.content).toContain("[ui.md](ui.md)");
        expect(router.content.split("\n").length).toBeLessThan(90);
        const topic = yield* client.use("Follow the pinned UI topic", (client, signal) =>
          client.callTool(
            {
              name: "skills",
              arguments: {
                app: "executor",
                name: "app-authoring",
                file: hook.entry.docs,
                deployment: router.deployment,
              },
            },
            undefined,
            { signal },
          ),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Document)(topic.structuredContent)).content,
        ).toContain("withOptimisticUpdate");
        yield* evidence.json("framework-reference.json", {
          reference: found.reference,
          hook: hook.entry,
          update: update.entry,
          tools,
        });
        expect(update.examples.some((example) => example.id === "live-inbox")).toBe(true);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
