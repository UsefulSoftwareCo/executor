/** Discover live framework contracts and follow the pinned authoring topics through MCP. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { frameworkSession } from "../support/framework.ts";
import { appsPackageExports } from "../support/apps-package.ts";
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
const Lookup = Schema.Struct({
  entry: Schema.optional(Schema.Struct({ symbol: Schema.String })),
  matches: Schema.Array(Schema.Struct({ symbol: Schema.String })),
});
const Document = Schema.Struct({ content: Schema.String, deployment: Schema.String });
const Rejected = Schema.Struct({
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      response: Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        recovery: Schema.Struct({ action: Schema.String }),
      }),
    }),
  }),
});
const Listing = Schema.Struct({ reference: Reference, symbols: Schema.Array(Schema.String) });
const Described = Schema.Struct({
  entry: Schema.optional(
    Schema.Struct({
      symbol: Schema.String,
      kind: Schema.String,
      summary: Schema.String,
      signatures: Schema.Array(Schema.String),
      definition: Schema.optional(Schema.String),
      docs: Schema.String,
      related: Schema.Array(Schema.String),
      examples: Schema.Array(Schema.String),
    }),
  ),
  types: Schema.Array(
    Schema.Struct({
      symbol: Schema.String,
      source: Schema.String,
      definition: Schema.optional(Schema.String),
    }),
  ),
  examples: Schema.Array(Schema.Struct({ id: Schema.String })),
  matches: Schema.Array(Schema.Struct({ symbol: Schema.String })),
});
/** Symbols an agent reported as describing without content. */
const reported = [
  "apps/mcp.mcpRouter",
  "apps.accountRouter",
  "apps.defineProvider",
  "apps.secrets",
];

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
        const [discovered, imported, current, found, entry, guide] = yield* Effect.all(
          [
            execute(`const found = await tools.search({query: "framework", limit: 20});
return { found, described: await tools.search.describe({ paths: found.items.map((item) => item.path) }) };`),
            execute(
              `return await tools.search.describe({ paths: [${JSON.stringify(`${queries}.context.get`)}] });`,
            ).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Struct({
                    items: Schema.Array(Schema.Struct({ signature: Schema.String })),
                  }),
                ),
              ),
            ),
            execute(`return await ${queries}.context.get({});`).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.Struct({ organization: Schema.String })),
              ),
            ),
            execute(
              `return await ${queries}.framework.search({query: {text: "withOptimisticUpdate"}});`,
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
            client.use("Read the short entry skill", (client, signal) =>
              client.callTool(
                { name: "skills", arguments: { app: "executor", name: "executor" } },
                undefined,
                { signal },
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
          { concurrency: 6 },
        );
        yield* evidence.json("framework-tool-discovery.json", discovered);
        // Search lists the framework tools concisely; describe returns their output types.
        const tools = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            found: Schema.Struct({
              items: Schema.Array(Schema.Struct({ path: Schema.String, input: Schema.String })),
            }),
            described: Schema.Struct({
              items: Schema.Array(Schema.Struct({ path: Schema.String, signature: Schema.String })),
            }),
          }),
        )(discovered);
        expect(
          tools.found.items.some(
            (item) => item.path.endsWith(".framework.describe") && item.path.includes(profile.id),
          ),
        ).toBe(true);
        const search = tools.described.items.find(
          (item) => item.path.endsWith(".framework.search") && item.path.includes(profile.id),
        );
        expect(search?.signature).toContain("remaining: number");
        expect(search?.signature).toContain("digest: string");
        expect(imported.items[0]?.signature).toContain("organization: string");
        expect(imported.items[0]?.signature).toContain("slug: string");
        expect(current.organization).toBe(actors.organization.id);
        expect(found.items.map((item) => item.symbol)).toContain(
          "AppMutation.withOptimisticUpdate",
        );
        // Misshaped input names the failing path, the unexpected key and the keys it accepts there,
        // the way agents misread these signatures. A tool without inputs still accepts {}.
        const rejected = (label: string, code: string) =>
          client
            .use(label, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Rejected)(result.structuredContent),
              ),
              Effect.map((rejected) => rejected.execution.error.response),
            );
        const misshaped = yield* Effect.all(
          [
            rejected(
              "Search with the query text in place of the query object",
              `return await ${queries}.framework.search({query: "apps/client.createAppClient"});`,
            ),
            rejected(
              "Search with the query text under an undeclared key",
              `return await ${queries}.framework.search({query: {query: "createAppClient"}});`,
            ),
            rejected(
              "Read the context with an organization it does not take",
              `return await ${queries}.context.get({path: {organization: ${JSON.stringify(actors.organization.id)}}});`,
            ),
          ],
          { concurrency: 3 },
        );
        yield* evidence.json("framework-input-problems.json", misshaped);
        expect(misshaped.map(({ code, message }) => ({ code, message }))).toEqual([
          {
            code: "InputInvalid",
            message:
              "Input failed validation: input.query: Expected object {text?, offset?, version?, digest?}",
          },
          {
            code: "InputInvalid",
            message:
              'Input failed validation: input.query: Unexpected key "query". Expected object {text?, offset?, version?, digest?}',
          },
          {
            code: "InputInvalid",
            message:
              'Input failed validation: input: Unexpected key "path". Expected object {} with no keys',
          },
        ]);
        expect(misshaped[0]?.recovery.action).toBe(
          "Change the input to the shape each problem expects, then call the tool again.",
        );
        const describe = (symbol: string) =>
          execute(
            `return await ${queries}.framework.describe(${JSON.stringify({ query: { symbol, ...found.reference } })});`,
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Description)));
        const [hook, update] = yield* Effect.all(
          [describe("apps/react.useAppQuery"), describe("AppMutation.withOptimisticUpdate")],
          { concurrency: 2 },
        );
        // Agents often pass an unqualified name; a unique suffix resolves, otherwise the
        // result names the closest symbols instead of failing without guidance.
        const lookup = (symbol: string) =>
          execute(
            `return await ${queries}.framework.describe(${JSON.stringify({ query: { symbol, ...found.reference } })});`,
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Lookup)));
        const [unqualified, unknown, partial] = yield* Effect.all(
          [lookup("defineApp"), lookup("defineApplication"), lookup("withOptimistic")],
          { concurrency: 3 },
        );
        yield* evidence.json("framework-describe-lookups.json", {
          unqualified,
          unknown,
          partial,
        });
        expect(unqualified.entry?.symbol).toBe("apps.defineApp");
        expect(unqualified.matches).toEqual([]);
        expect(unknown.entry).toBeUndefined();
        expect(unknown.matches.map((match) => match.symbol)).toContain("apps.defineApp");
        expect(partial.entry).toBeUndefined();
        expect(partial.matches[0]?.symbol).toBe("AppMutation.withOptimisticUpdate");
        expect(hook.entry.signatures.join(" ")).toContain("data: A | undefined");
        expect(hook.entry.signatures.join(" ")).toContain("pending: boolean");
        expect(update.entry.signatures.join(" ")).toContain("OptimisticUpdate<Input>");
        // Agents start at the short entry skill, which names the deeper skills to read.
        const intro = yield* Schema.decodeUnknownEffect(Document)(entry.structuredContent);
        expect(intro.content).toContain("`code-mode`");
        expect(intro.content).toContain("`app-authoring`");
        expect(intro.content.split("\n").length).toBeLessThan(50);
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

  it.effect(scenarios.frameworkReferenceCoverage.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const { client, execute, queries } = yield* frameworkSession;
        // An empty search pages through the whole reference, as an agent browsing it would.
        const listing = yield* execute(`
          const symbols = [];
          let page = await ${queries}.framework.search({ query: {} });
          symbols.push(...page.items.map((item) => item.symbol));
          while (page.remaining > 0) {
            page = await ${queries}.framework.search({ query: { offset: String(symbols.length) } });
            symbols.push(...page.items.map((item) => item.symbol));
          }
          return { reference: page.reference, symbols };
        `).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Listing)));
        // The reported call, made as the agent made it: the symbol goes inside query.
        const answered = yield* execute(`
          const reference = ${JSON.stringify(listing.reference)};
          return await Promise.all(${JSON.stringify(reported)}.map((symbol) =>
            ${queries}.framework.describe({ query: { symbol, ...reference } })));
        `).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Described))));
        // Every symbol through the endpoint that MCP tool forwards to; one MCP call each would
        // spend most of the scenario's deadline on tool dispatch.
        const described = yield* Effect.forEach(
          listing.symbols,
          (symbol) =>
            api
              .request(
                actors.owner,
                "GET",
                `/api/organizations/${actors.organization.id}/framework/describe?${new URLSearchParams({ symbol, ...listing.reference })}`,
              )
              .pipe(
                Effect.flatMap((response) => body(Described, response)),
                Effect.map((found) => ({ symbol, ...found })),
              ),
          { concurrency: 8 },
        );
        const exported = yield* appsPackageExports;
        // Every linked skill document opens through the same skills tool an agent uses.
        const documents = [
          ...new Set(described.flatMap(({ entry }) => (entry === undefined ? [] : [entry.docs]))),
        ];
        const opened = yield* Effect.forEach(
          documents,
          (file) =>
            client
              .use("Open a linked framework skill document", (client, signal) =>
                client.callTool(
                  { name: "skills", arguments: { app: "executor", name: "app-authoring", file } },
                  undefined,
                  { signal },
                ),
              )
              .pipe(
                Effect.flatMap((result) =>
                  Schema.decodeUnknownEffect(Document)(result.structuredContent),
                ),
              ),
          { concurrency: 4 },
        );
        yield* evidence.json("framework-reference-coverage.json", {
          reference: listing.reference,
          answered,
          described,
          documents,
          exported: Object.fromEntries(exported),
        });
        expect(new Set(listing.symbols).size).toBe(listing.symbols.length);
        expect(described.map((item) => item.symbol)).toEqual(listing.symbols);
        const same = (left: readonly string[], right: readonly string[]) =>
          left.toSorted().join("\n") === right.toSorted().join("\n");
        const problems = described.flatMap(({ symbol, entry, types, examples, matches }) => {
          if (entry === undefined)
            return [
              `${symbol}: no entry; matches ${matches.map((match) => match.symbol).join(", ")}`,
            ];
          const callable = entry.kind === "function" || entry.kind === "method";
          return [
            ...(entry.symbol === symbol ? [] : [`${symbol}: described ${entry.symbol}`]),
            ...((callable ? entry.signatures.length > 0 : entry.definition !== undefined)
              ? []
              : [`${symbol}: no ${callable ? "signature" : "definition"}`]),
            // Module exports carry JSDoc; some methods reached through context do not.
            ...(/^apps[./]/.test(symbol) && entry.summary === "" ? [`${symbol}: no summary`] : []),
            ...(same(
              types.map((type) => type.symbol),
              entry.related,
            )
              ? []
              : [`${symbol}: related types do not resolve`]),
            ...(same(
              examples.map((example) => example.id),
              entry.examples,
            )
              ? []
              : [`${symbol}: examples do not resolve`]),
            ...(matches.length === 0 ? [] : [`${symbol}: matches beside its entry`]),
          ];
        });
        expect(problems).toEqual([]);
        expect(opened.map(({ content }) => content.length > 0)).toEqual(documents.map(() => true));
        // The reference covers every export of each module it documents, as the package declares them.
        const modules = new Map<string, string[]>();
        for (const symbol of listing.symbols.filter((symbol) => /^apps[./]/.test(symbol))) {
          const module = symbol.slice(0, symbol.lastIndexOf("."));
          modules.set(module, [...(modules.get(module) ?? []), symbol.slice(module.length + 1)]);
        }
        for (const [module, names] of modules)
          expect({ module, names: names.toSorted() }).toEqual({
            module,
            names: exported.get(module)?.toSorted(),
          });
        expect(
          answered.map(({ entry, types }) => ({
            symbol: entry?.symbol,
            signed: entry !== undefined && entry.signatures.length > 0,
            types: types.map((type) => type.symbol),
          })),
        ).toEqual(
          reported.map((symbol) => ({
            symbol,
            signed: true,
            types: described.find((item) => item.symbol === symbol)?.entry?.related,
          })),
        );
        expect(answered[0]?.types.map((type) => type.symbol)).toContain(
          "apps/mcp.McpCatalogOptions",
        );
        // A schema an options type names is described even though its module does not export it.
        expect(
          described
            .find((item) => item.symbol === "apps/openapi.OpenapiToolsOptions")
            ?.types.map((type) => type.symbol),
        ).toContain("OpenapiParameterDefaults");
        // AppOperation names the native Approval, which returns an Effect. The public apps.Approval
        // shares its spelling but returns a value or a Promise, so each links to its own declaration.
        const operationApprovals = described
          .find((item) => item.symbol === "AppOperation")
          ?.types.filter((type) => /(^|\.)Approval(@|$)/.test(type.symbol));
        expect(
          operationApprovals?.map(({ symbol, source, definition }) => ({
            symbol,
            source,
            effect: definition?.includes("=> Effect.Effect<ApprovalDecision"),
          })),
        ).toEqual([
          {
            symbol: "Approval@apps/src/contracts/approval.ts",
            source: "apps/src/contracts/approval.ts",
            effect: true,
          },
        ]);
        expect(
          described
            .find((item) => item.symbol === "apps.Approval")
            ?.types.map((type) => type.symbol),
        ).toContain("Approval@apps/src/contracts/approval.ts");
        // A callable's links come from the signature TypeScript prints, not from source text.
        expect(
          described.find((item) => item.symbol === "apps.query")?.types.map((type) => type.symbol),
        ).toContain("apps.QueryContext");
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
