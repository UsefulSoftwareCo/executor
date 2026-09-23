/** Discover checked source through MCP, deploy it unchanged, and exercise its optimistic UI. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { waitForAppUrl } from "../support/app-pages.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { managementApp } from "../support/management-app.ts";
import { Evidence } from "../support/evidence.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { holdQuery } from "../support/query-transition.ts";

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});
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

layer(HostedLive, { excludeTestServices: true })("Framework authoring", (it) => {
  it.effect(scenarios.frameworkAuthoring.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        yield* browser.login(actors.owner);
        const { profile } = yield* managementApp(actors.owner);
        const grant = yield* oauth.authorize;
        yield* Effect.addFinalizer(() => oauth.revoke(grant).pipe(Effect.orDie));
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "framework-authoring",
        );
        const execute = (code: string) =>
          Effect.gen(function* () {
            const result = yield* client.use(
              "Read app and framework contracts through MCP",
              (client, signal) =>
                client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            );
            return (yield* Schema.decodeUnknownEffect(Completed)(result.structuredContent))
              .execution.value;
          });
        const discovered = yield* execute(
          'return await tools.search({query: "framework", limit: 20});',
        );
        yield* evidence.json("framework-tool-discovery.json", discovered);
        const queries = `tools.executor.profiles[${JSON.stringify(profile.id)}].queries`;
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
        const imported = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ items: Schema.Array(Schema.Struct({ signature: Schema.String })) }),
        )(yield* execute('return await tools.search({query: "context_get", limit: 1});'));
        expect(imported.items[0]?.signature).toContain("organization: string");
        expect(imported.items[0]?.signature).toContain("slug: string");
        const current = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ organization: Schema.String }),
        )(yield* execute(`return await ${queries}.context_get({});`));
        expect(current.organization).toBe(actors.organization.id);
        const found = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            reference: Reference,
            items: Schema.Array(Schema.Struct({ symbol: Schema.String })),
          }),
        )(
          yield* execute(
            `return await ${queries}.framework_search({query: "withOptimisticUpdate"});`,
          ),
        );
        expect(found.items.map((item) => item.symbol)).toContain(
          "AppMutation.withOptimisticUpdate",
        );
        const describe = (symbol: string) =>
          execute(
            `return await ${queries}.framework_describe(${JSON.stringify({ symbol, ...found.reference })});`,
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Description)));
        const hook = yield* describe("apps/react.useAppQuery");
        expect(hook.entry.signatures.join(" ")).toContain("data: A | undefined");
        expect(hook.entry.signatures.join(" ")).toContain("pending: boolean");
        const update = yield* describe("AppMutation.withOptimisticUpdate");
        expect(update.entry.signatures.join(" ")).toContain("OptimisticUpdate<Input>");
        const guide = yield* client.use("Read the small authoring router", (client, signal) =>
          client.callTool(
            { name: "skills", arguments: { app: "executor", name: "app-authoring" } },
            undefined,
            { signal },
          ),
        );
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
        const example = update.examples.find((example) => example.id === "live-inbox");
        if (example === undefined)
          return yield* Effect.die("Describe did not return its checked example");
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Framework example ${randomUUID().slice(0, 8)}`,
          files: example.files,
        });
        yield* evidence.json("example-deployment.json", deployed);
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const url = yield* waitForAppUrl(actors.owner, `${prefix}/${app.id}/ui`);
        yield* browser.use("Open the example returned by framework_describe", (page) =>
          page.goto(url),
        );
        yield* browser.use("Wait for the actual empty query result", (page) =>
          page.getByText("A clean slate.").waitFor(),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const write = yield* holdQuery(["/_executor/api/mutate"], "continue", {
              method: "POST",
            });
            const read = yield* holdQuery(["/_executor/api/query"], "continue", { method: "POST" });
            yield* browser.use("Create a message while the write is held", (page) =>
              page
                .getByLabel("New message")
                .fill("Optimistic message")
                .then(() => page.getByRole("button", { name: "Add message" }).click()),
            );
            yield* write.requested;
            yield* browser.use(
              "The optimistic row appears before the server receives the write",
              (page) =>
                page.getByRole("listitem").filter({ hasText: "Optimistic message" }).waitFor(),
            );
            expect(
              yield* browser.use("The draft remains while saving", (page) =>
                page.getByLabel("New message").inputValue(),
              ),
            ).toBe("Optimistic message");
            yield* write.release;
            yield* read.requested;
            yield* browser.use("A confirmed write clears the submitted draft", (page) =>
              page.waitForFunction(
                () => document.querySelector<HTMLInputElement>("#subject")?.value === "",
              ),
            );
            expect(
              yield* browser.use("The row stays visible while reconciliation is held", (page) =>
                page.getByRole("listitem").filter({ hasText: "Optimistic message" }).count(),
              ),
            ).toBe(1);
            yield* browser.use("Begin another draft during reconciliation", (page) =>
              page.getByLabel("New message").fill("Keep this draft"),
            );
            const resumed = yield* browser.use("Watch the next live subscription", (page) => {
              const request = page.waitForRequest(
                (request) => new URL(request.url()).pathname === "/_executor/api/subscribe",
              );
              return Promise.resolve({ request });
            });
            yield* read.release;
            yield* browser.use("Fresh reads resume the live stream", () => resumed.request);
            expect(
              yield* browser.use("Reconciliation keeps one row and the new draft", (page) =>
                Promise.all([
                  page.getByRole("listitem").filter({ hasText: "Optimistic message" }).count(),
                  page.getByLabel("New message").inputValue(),
                ]),
              ),
            ).toEqual([1, "Keep this draft"]);
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const failed = yield* holdQuery(["/_executor/api/mutate"], "fail", { method: "POST" });
            yield* browser.use("Submit a second optimistic row", (page) =>
              page.getByRole("button", { name: "Add message" }).click(),
            );
            yield* failed.requested;
            yield* browser.use("The pending row is visible", (page) =>
              page.getByRole("listitem").filter({ hasText: "Keep this draft" }).waitFor(),
            );
            yield* failed.release;
            yield* browser.use("Failed writes report an error", (page) =>
              page.getByRole("alert").filter({ hasText: "Could not save your message" }).waitFor(),
            );
            yield* browser.use("Only the failed row rolls back", (page) =>
              page
                .getByRole("listitem")
                .filter({ hasText: "Keep this draft" })
                .waitFor({ state: "detached" }),
            );
            expect(
              yield* browser.use("The earlier row and unsaved draft survive rollback", (page) =>
                Promise.all([
                  page.getByRole("listitem").filter({ hasText: "Optimistic message" }).count(),
                  page.getByLabel("New message").inputValue(),
                ]),
              ),
            ).toEqual([1, "Keep this draft"]);
          }),
        );
        yield* browser.use("Retry the draft explicitly", (page) =>
          page.getByRole("button", { name: "Add message" }).click(),
        );
        yield* browser.use("The retry is acknowledged", (page) =>
          page.waitForFunction(
            () => document.querySelector<HTMLInputElement>("#subject")?.value === "",
          ),
        );
        yield* browser.use("Reload authoritative state", (page) => page.reload());
        yield* browser.use("The server retained both successful messages", (page) =>
          page.getByRole("listitem").filter({ hasText: "Keep this draft" }).waitFor(),
        );
        expect(
          yield* browser.use("Only the two acknowledged rows persisted", (page) =>
            page.getByRole("listitem").count(),
          ),
        ).toBe(2);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
