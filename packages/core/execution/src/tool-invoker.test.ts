import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";

import {
  ElicitationResponse,
  FormElicitation,
  createExecutor,
  definePlugin,
  makeTestConfig,
} from "@executor-js/sdk";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { createExecutionEngine } from "./engine";
import { describeTool, makeExecutorToolInvoker, searchTools } from "./tool-invoker";

const codeExecutor = makeQuickJsExecutor();

const RepoInputSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(Schema.Struct({ owner: Schema.String, repo: Schema.String })),
);

const ContactInputSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(Schema.Struct({ email: Schema.String })),
);

const EmptyInputSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(Schema.Struct({})),
);

const acceptAll = () => Effect.succeed(new ElicitationResponse({ action: "accept" }));

// ---------------------------------------------------------------------------
// Test plugins — each one declares a namespace as a static source with N
// tools. Handlers return static data; the suite only cares about discovery
// + elicitation flow, not real invocation semantics.
// ---------------------------------------------------------------------------

const githubPlugin = definePlugin(() => ({
  id: "github-test" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "github",
      kind: "in-memory",
      name: "GitHub",
      tools: [
        {
          name: "listRepositoryIssues",
          description: "List issues for a repository",
          inputSchema: RepoInputSchema,
          handler: () => Effect.succeed([]),
        },
        {
          name: "getRepositoryDetails",
          description: "Get repository details including the default branch",
          inputSchema: RepoInputSchema,
          handler: () => Effect.succeed({ defaultBranch: "main" }),
        },
        {
          name: "searchDocs",
          description: "Search GitHub API documentation",
          inputSchema: EmptyInputSchema,
          handler: () => Effect.succeed([]),
        },
      ],
    },
  ],
}));

const crmPlugin = definePlugin(() => ({
  id: "crm-test" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "crm",
      kind: "in-memory",
      name: "CRM",
      tools: [
        {
          name: "createContact",
          description: "Create a CRM contact record",
          inputSchema: ContactInputSchema,
          handler: () => Effect.succeed({ id: "contact_1" }),
        },
        {
          name: "listContacts",
          description: "List CRM contacts",
          inputSchema: EmptyInputSchema,
          handler: () => Effect.succeed([]),
        },
      ],
    },
  ],
}));

const errorPlugin = definePlugin(() => ({
  id: "error-test" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "records",
      kind: "in-memory",
      name: "Records",
      tools: [
        {
          name: "queryRows",
          description: "Query rows",
          inputSchema: EmptyInputSchema,
          handler: () =>
            Effect.succeed({
              data: null,
              error: {
                message: 'Field with name "DisplayName" does not exist',
                code: "invalid_query",
              },
            }),
        },
      ],
    },
  ],
}));

const makeSearchExecutor = () =>
  createExecutor(makeTestConfig({ plugins: [githubPlugin(), crmPlugin()] as const }));

describe("tool discovery", () => {
  it.effect("ranks matches using ids, namespaces, camelCase names, and descriptions", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();

      const githubMatches = yield* searchTools(executor, "github issues", 5);
      expect(githubMatches.items.map((match) => match.path)).toEqual([
        "github.listRepositoryIssues",
      ]);
      expect(githubMatches.items[0]?.score ?? 0).toBeGreaterThan(0);
      expect(githubMatches.hasMore).toBe(false);
      expect(githubMatches.nextOffset).toBeNull();

      const repoMatches = yield* searchTools(executor, "repo details", 5);
      expect(repoMatches.items[0]?.path).toBe("github.getRepositoryDetails");

      const crmMatches = yield* searchTools(executor, "crm create contact", 5);
      expect(crmMatches.items[0]?.path).toBe("crm.createContact");
      expect(crmMatches.items[0]?.score ?? 0).toBeGreaterThan(crmMatches.items[1]?.score ?? 0);
    }),
  );

  it.effect("returns no matches for empty queries instead of listing arbitrary tools", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();
      const matches = yield* searchTools(executor, "", 5);
      expect(matches.items).toEqual([]);
      expect(matches.total).toBe(0);
      expect(matches.hasMore).toBe(false);
      expect(matches.nextOffset).toBeNull();
    }),
  );

  it.effect("paginates ranked matches via limit + offset with hasMore + nextOffset", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();

      // "list" matches `listRepositoryIssues`, `searchDocs` (description has
      // "documentation" which tokenises adjacent), `listContacts`, etc.
      // The exact match set isn't important — the pagination invariants are.
      const all = yield* searchTools(executor, "list", 100);
      expect(all.items.length).toBeGreaterThan(1);
      expect(all.total).toBe(all.items.length);
      expect(all.hasMore).toBe(false);
      expect(all.nextOffset).toBeNull();

      // First page (limit 1) — matches truncate, hasMore + nextOffset surface.
      const firstPage = yield* searchTools(executor, "list", 1);
      expect(firstPage.items).toEqual([all.items[0]]);
      expect(firstPage.total).toBe(all.total);
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.nextOffset).toBe(1);

      // Second page using nextOffset — order matches the un-paginated rank.
      const secondPage = yield* searchTools(executor, "list", 1, {
        offset: firstPage.nextOffset!,
      });
      expect(secondPage.items).toEqual([all.items[1]]);
      expect(secondPage.total).toBe(all.total);
      // Whether hasMore is true depends on total; at minimum it's consistent.
      expect(secondPage.hasMore).toBe(all.total > 2);
      expect(secondPage.nextOffset).toBe(secondPage.hasMore ? 2 : null);

      // Offset past the end — empty page, no more.
      const past = yield* searchTools(executor, "list", 5, { offset: all.total + 10 });
      expect(past.items).toEqual([]);
      expect(past.total).toBe(all.total);
      expect(past.hasMore).toBe(false);
      expect(past.nextOffset).toBeNull();
    }),
  );

  it.effect("can narrow discovery to a namespace", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();

      const githubOnly = yield* searchTools(executor, "list", 5, {
        namespace: "github",
      });
      expect(githubOnly.items.map((match) => match.path)).toEqual(["github.listRepositoryIssues"]);

      const crmOnly = yield* searchTools(executor, "list", 5, {
        namespace: "crm",
      });
      expect(crmOnly.items.map((match) => match.path)).toEqual(["crm.listContacts"]);

      const sandboxResult = yield* createExecutionEngine({ executor, codeExecutor }).execute(
        'return await tools.search({ namespace: "crm", query: "create contact", limit: 5 });',
        { onElicitation: acceptAll },
      );
      expect(sandboxResult.error).toBeUndefined();
      expect(sandboxResult.result).toEqual(
        expect.objectContaining({
          items: [expect.objectContaining({ path: "crm.createContact" })],
          total: 1,
          hasMore: false,
          nextOffset: null,
        }),
      );
    }),
  );

  it.effect("supports executor-scoped source listing and tool search", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();

      const listed = yield* createExecutionEngine({ executor, codeExecutor }).execute(
        "return await tools.executor.sources.list();",
        { onElicitation: acceptAll },
      );
      expect(listed.error).toBeUndefined();
      expect(listed.result).toEqual(
        expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({ id: "github", toolCount: 3 }),
            expect.objectContaining({ id: "crm", toolCount: 2 }),
          ]),
          total: 2,
          hasMore: false,
          nextOffset: null,
        }),
      );

      const searched = yield* createExecutionEngine({ executor, codeExecutor }).execute(
        'return await tools.search({ query: "list contacts", namespace: "crm", limit: 5 });',
        { onElicitation: acceptAll },
      );
      expect(searched.error).toBeUndefined();
      expect(searched.result).toEqual(
        expect.objectContaining({
          items: [expect.objectContaining({ path: "crm.listContacts" })],
        }),
      );
    }),
  );

  it.effect("paginates source listings via limit + offset", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();
      const engine = createExecutionEngine({ executor, codeExecutor });

      // total = 2 (github, crm), sorted by name ("CRM" < "GitHub")
      const firstPage = yield* engine.execute(
        "return await tools.executor.sources.list({ limit: 1 });",
        { onElicitation: acceptAll },
      );
      expect(firstPage.error).toBeUndefined();
      expect(firstPage.result).toEqual(
        expect.objectContaining({
          items: [expect.objectContaining({ id: "crm" })],
          total: 2,
          hasMore: true,
          nextOffset: 1,
        }),
      );

      const secondPage = yield* engine.execute(
        "return await tools.executor.sources.list({ limit: 1, offset: 1 });",
        { onElicitation: acceptAll },
      );
      expect(secondPage.error).toBeUndefined();
      expect(secondPage.result).toEqual(
        expect.objectContaining({
          items: [expect.objectContaining({ id: "github" })],
          total: 2,
          hasMore: false,
          nextOffset: null,
        }),
      );
    }),
  );

  it.effect("rejects negative offsets via the engine validator", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();
      const engine = createExecutionEngine({ executor, codeExecutor });

      const badSearch = yield* engine.execute(
        [
          "try {",
          '  await tools.search({ query: "list", offset: -1 });',
          '  return "unexpected";',
          "} catch (error) {",
          "  return error instanceof Error ? error.message : String(error);",
          "}",
        ].join("\n"),
        { onElicitation: acceptAll },
      );
      expect(badSearch.error).toBeUndefined();
      expect(String(badSearch.result)).toContain(
        "tools.search offset must be a non-negative number when provided",
      );

      const badList = yield* engine.execute(
        [
          "try {",
          "  await tools.executor.sources.list({ offset: -5 });",
          '  return "unexpected";',
          "} catch (error) {",
          "  return error instanceof Error ? error.message : String(error);",
          "}",
        ].join("\n"),
        { onElicitation: acceptAll },
      );
      expect(badList.error).toBeUndefined();
      expect(String(badList.result)).toContain(
        "tools.executor.sources.list offset must be a non-negative number when provided",
      );
    }),
  );

  it.effect("describes tools with TypeScript previews", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();

      const described = yield* describeTool(executor, "github.listRepositoryIssues");
      expect(described.path).toBe("github.listRepositoryIssues");
      expect(described.name).toBe("listRepositoryIssues");
      expect(described.description).toBe("List issues for a repository");
      expect(described.inputTypeScript).toBe("{ owner: string; repo: string }");
      expect(described.outputTypeScript).toBeUndefined();
      expect(described.typeScriptDefinitions).toBeUndefined();
    }),
  );

  it.effect("rejects malformed discover calls inside the sandbox", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();
      const engine = createExecutionEngine({ executor, codeExecutor });

      const invalid = yield* engine.execute(
        [
          "try {",
          '  await tools.search("github issues");',
          '  return "unexpected";',
          "} catch (error) {",
          "  return error instanceof Error ? error.message : String(error);",
          "}",
        ].join("\n"),
        { onElicitation: acceptAll },
      );
      expect(invalid.error).toBeUndefined();
      expect(String(invalid.result)).toContain(
        "tools.search expects an object: { query?: string; namespace?: string; limit?: number; offset?: number }",
      );

      const emptyQuery = yield* engine.execute(
        'return await tools.search({ query: "", limit: 5 });',
        { onElicitation: acceptAll },
      );
      expect(emptyQuery.error).toBeUndefined();
      expect(emptyQuery.result).toEqual({
        items: [],
        total: 0,
        hasMore: false,
        nextOffset: null,
      });

      const invalidDescribe = yield* engine.execute(
        [
          "try {",
          '  await tools.describe.tool({ path: "github.listRepositoryIssues", includeSchemas: true });',
          '  return "unexpected";',
          "} catch (error) {",
          "  return error instanceof Error ? error.message : String(error);",
          "}",
        ].join("\n"),
        { onElicitation: acceptAll },
      );
      expect(invalidDescribe.error).toBeUndefined();
      expect(String(invalidDescribe.result)).toContain(
        "tools.describe.tool no longer accepts includeSchemas",
      );

      const invalidSearch = yield* engine.execute(
        'try { return await tools.search("crm"); } catch (error) { return error instanceof Error ? error.message : String(error); }',
        { onElicitation: acceptAll },
      );
      expect(invalidSearch.error).toBeUndefined();
      expect(String(invalidSearch.result)).toContain("tools.search expects an object");
    }),
  );

  it.effect("converts message-bearing tool error results into execution errors", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [errorPlugin()] as const }));
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const error = yield* Effect.flip(invoker.invoke({ path: "records.queryRows", args: {} }));

      expect(error).toEqual(
        expect.objectContaining({
          message: 'Field with name "DisplayName" does not exist',
        }),
      );
    }),
  );
});

// ---------------------------------------------------------------------------
// pause/resume — multiple elicitations in a single execution
// ---------------------------------------------------------------------------

const apiPlugin = definePlugin(() => ({
  id: "api-test" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "api",
      kind: "in-memory",
      name: "API",
      tools: [
        {
          name: "multiApproval",
          description: "A tool that elicits twice",
          inputSchema: EmptyInputSchema,
          handler: ({ elicit }) =>
            Effect.gen(function* () {
              const r1 = yield* elicit(
                new FormElicitation({
                  message: "First approval",
                  requestedSchema: {},
                }),
              );
              const r2 = yield* elicit(
                new FormElicitation({
                  message: "Second approval",
                  requestedSchema: {},
                }),
              );
              return { first: r1, second: r2 };
            }),
        },
        {
          name: "singleApproval",
          description:
            "A tool that elicits exactly once and then returns a value. Mirrors the shape of a typical `gmail.users.labels.create` style operation: one approval, one side effect, one success response.",
          inputSchema: EmptyInputSchema,
          handler: ({ elicit }) =>
            Effect.gen(function* () {
              const r = yield* elicit(
                new FormElicitation({
                  message: "Only approval",
                  requestedSchema: {},
                }),
              );
              return { ok: true, response: r };
            }),
        },
      ],
    },
  ],
}));

describe("pause/resume with multiple elicitations", () => {
  const makeElicitingExecutor = () =>
    createExecutor(makeTestConfig({ plugins: [apiPlugin()] as const }));

  it.effect(
    "resume does not hang when execution hits a second elicitation",
    () =>
      Effect.gen(function* () {
        const executor = yield* makeElicitingExecutor();
        const engine = createExecutionEngine({ executor, codeExecutor });

        const code = "return await tools.api.multiApproval({});";

        const outcome1 = yield* engine.executeWithPause(code);
        expect(outcome1.status).toBe("paused");
        const paused1 = outcome1 as Extract<typeof outcome1, { status: "paused" }>;
        expect(paused1.execution.elicitationContext.request.message).toBe("First approval");

        // Resume first pause — execution continues to second elicitation.
        // resume() must not hang; it should return (either a new paused
        // result or the completion).
        const outcome2 = yield* Effect.race(
          engine
            .resume(paused1.execution.id, { action: "accept" })
            .pipe(Effect.map((outcome) => ({ kind: "resumed" as const, outcome }))),
          Effect.sleep("5 seconds").pipe(Effect.as({ kind: "hung" as const })),
        );

        expect(outcome2.kind).toBe("resumed");
        if (outcome2.kind !== "resumed") return;
        expect(outcome2.outcome).not.toBeNull();
      }),
    { timeout: 10000 },
  );

  // Regression: use separate top-level runPromise calls to match HTTP/CLI
  // pause/resume, and a single-elicit tool so no later pause can mask a dead
  // sandbox fiber.
  it("resume returns across separate runPromise boundaries for a single-elicit tool (HTTP-like)", async () => {
    const executor = await Effect.runPromise(makeElicitingExecutor());
    const engine = createExecutionEngine({ executor, codeExecutor });

    const code = "return await tools.api.singleApproval({});";

    const outcome1 = await Effect.runPromise(engine.executeWithPause(code));
    expect(outcome1.status).toBe("paused");
    const paused1 = outcome1 as Extract<typeof outcome1, { status: "paused" }>;
    expect(paused1.execution.elicitationContext.request.message).toBe("Only approval");

    // `execution.fiber` is on `InternalPausedExecution`; the exported
    // `PausedExecution` type doesn't carry it. Cast to read.
    const pausedWithFiber = (
      value: unknown,
    ): {
      readonly fiber: Fiber.Fiber<unknown, unknown>;
    } => value as { readonly fiber: Fiber.Fiber<unknown, unknown> };
    const sandboxFiber = pausedWithFiber(paused1.execution).fiber;
    const exitProbe = await Effect.runPromise(
      Effect.race(
        Fiber.await(sandboxFiber),
        Effect.map(Effect.sleep("50 millis"), () => "still-running" as const),
      ),
    );
    expect(exitProbe).toBe("still-running");

    const outcome2 = await Effect.runPromise(
      Effect.race(
        engine
          .resume(paused1.execution.id, { action: "accept" })
          .pipe(Effect.map((outcome) => ({ kind: "resumed" as const, outcome }))),
        Effect.sleep("2 seconds").pipe(Effect.as({ kind: "hung" as const })),
      ),
    );

    expect(outcome2.kind).toBe("resumed");
    if (outcome2.kind !== "resumed") return;
    expect(outcome2.outcome).not.toBeNull();
    const resumed = outcome2.outcome as NonNullable<typeof outcome2.outcome>;
    expect(resumed.status).toBe("completed");
    if (resumed.status !== "completed") return;
    expect(resumed.result.error).toBeUndefined();
    expect(resumed.result.result).toMatchObject({ ok: true });
  }, 10000);
});
