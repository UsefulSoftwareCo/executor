import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  ElicitationResponse,
  FormElicitation,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  ToolName,
  ToolResult,
  createExecutor,
  definePlugin,
  type AnyPlugin,
  type CredentialProvider,
  type Elicit,
  type ToolDef,
} from "@executor-js/sdk";
import {
  makeTestConfig,
  memoryCredentialsPlugin,
  serveOAuthTestServer,
  typeCheckOutputTypeScript,
} from "@executor-js/sdk/testing";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { createExecutionEngine } from "./engine";
import {
  describeTool,
  makeExecutorToolInvoker,
  searchTools,
  type ToolDiscoveryProvider,
} from "./tool-invoker";

// ---------------------------------------------------------------------------
// v2 port. The v1 suite modelled namespaces as `staticSources` whose tools
// surfaced in `tools.list()` at 2-segment ids (`github.getRepositoryDetails`).
// In v2 tools are produced per-connection via `resolveTools` and addressed
// `tools.<integration>.<owner>.<connection>.<tool>`. Each test plugin below
// registers an integration + a memory credential provider, produces its tools
// through `resolveTools`, and dispatches them in `invokeTool`. The harness
// creates one `main` org connection per integration, so the sandbox-callable
// path is `<integration>.org.main.<tool>`.
// ---------------------------------------------------------------------------

const codeExecutor = makeQuickJsExecutor();

// Standard-schema validators — used by `invokeTool` to validate args and emit
// the `Missing key` issues that surface as `invalid_tool_arguments`.
type Validator = ReturnType<typeof Schema.toStandardSchemaV1>;

const RepoValidator: Validator = Schema.toStandardSchemaV1(
  Schema.Struct({ owner: Schema.String, repo: Schema.String }),
);
const ContactValidator: Validator = Schema.toStandardSchemaV1(
  Schema.Struct({ email: Schema.String }),
);
const EmptyValidator: Validator = Schema.toStandardSchemaV1(Schema.Struct({}));

// Plain JSON Schema objects — stored on the produced ToolDef and rendered by
// the describe TypeScript-preview path. (ToolDef schemas are opaque JSON to
// core, exactly like the openapi plugin's spec-derived schemas.)
const RepoInputJson = {
  type: "object",
  properties: { owner: { type: "string" }, repo: { type: "string" } },
  required: ["owner", "repo"],
} as const;
const RepoDetailsOutputJson = {
  type: "object",
  properties: { defaultBranch: { type: "string" } },
  required: ["defaultBranch"],
} as const;
const ContactInputJson = {
  type: "object",
  properties: { email: { type: "string" } },
  required: ["email"],
} as const;
const EmptyInputJson = { type: "object", properties: {} } as const;

const acceptAll = () => Effect.succeed(ElicitationResponse.make({ action: "accept" }));

const TEMPLATE = AuthTemplateSlug.make("apiKey");
const CONN = ConnectionName.make("main");
const OAUTH_TEMPLATE = AuthTemplateSlug.make("oauth");
const OAUTH_CLIENT = OAuthClientSlug.make("records-app");

type DescribedToolContract = {
  readonly outputTypeScript: string;
  readonly typeScriptDefinitions: Record<string, string>;
};

const typeCheckDescribedInvocation = (
  described: DescribedToolContract,
  runtimeResult: unknown,
  consumerSource: string,
): readonly string[] =>
  typeCheckOutputTypeScript(described, runtimeResult, {
    consumerSource,
    fileName: "described-tool-contract.ts",
    typeName: "ToolOutput",
    valueName: "invokedResult",
  });

// ---------------------------------------------------------------------------
// Test plugin builder — registers one integration, produces N tools via
// resolveTools, and dispatches them in invokeTool. Handlers receive the args
// already validated against the tool's standard input schema (so invalid args
// surface as a ToolInvocationError → invalid_tool_arguments value).
// ---------------------------------------------------------------------------

type ToolHandlerInput = {
  readonly args: unknown;
  readonly elicit: Elicit;
};

type TestToolSpec = {
  readonly name: string;
  readonly description: string;
  /** Plain JSON Schema stored on the produced ToolDef. */
  readonly inputJsonSchema?: unknown;
  readonly outputJsonSchema?: unknown;
  /** Standard-schema validator applied to args in `invokeTool`. */
  readonly validator?: Validator;
  readonly handler: (input: ToolHandlerInput) => Effect.Effect<unknown, unknown>;
};

const memoryProvider = (key: string): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make(key),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
    has: (id) => Effect.sync(() => store.has(String(id))),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((entryKey) => ({
          id: ProviderItemId.make(entryKey),
          name: entryKey,
        })),
      ),
  };
};

const validateArgs = (
  validator: Validator | undefined,
  args: unknown,
): Effect.Effect<unknown, unknown> => {
  if (validator == null) return Effect.succeed(args);
  return Effect.promise(() => Promise.resolve(validator["~standard"].validate(args))).pipe(
    Effect.flatMap((result) =>
      "value" in result ? Effect.succeed(result.value) : Effect.fail(result),
    ),
  );
};

const makeTestPlugin = (config: {
  readonly pluginId: string;
  readonly integration: string;
  readonly tools: readonly TestToolSpec[];
}) => {
  const slug = IntegrationSlug.make(config.integration);
  const byName = new Map(config.tools.map((spec) => [spec.name, spec] as const));
  return definePlugin(() => ({
    id: config.pluginId,
    credentialProviders: [memoryProvider(`${config.pluginId}-memory`)],
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({
        tools: config.tools.map(
          (spec): ToolDef => ({
            name: ToolName.make(spec.name),
            description: spec.description,
            inputSchema: spec.inputJsonSchema,
            outputSchema: spec.outputJsonSchema,
          }),
        ),
      }),
    invokeTool: ({ toolRow, args, elicit }) => {
      const spec = byName.get(toolRow.name);
      if (!spec) return Effect.succeed(undefined);
      return validateArgs(spec.validator, args).pipe(
        Effect.flatMap((decoded) => spec.handler({ args: decoded, elicit })),
      );
    },
    extension: (ctx) => ({
      seed: () =>
        ctx.core.integrations.register({
          slug,
          description: config.integration,
          config: {},
        }),
    }),
  }))();
};

const githubPlugin = makeTestPlugin({
  pluginId: "github-test",
  integration: "github",
  tools: [
    {
      name: "listRepositoryIssues",
      description: "List issues for a repository",
      inputJsonSchema: RepoInputJson,
      validator: RepoValidator,
      handler: () => Effect.succeed([]),
    },
    {
      name: "getRepositoryDetails",
      description: "Get repository details including the default branch",
      inputJsonSchema: RepoInputJson,
      validator: RepoValidator,
      outputJsonSchema: RepoDetailsOutputJson,
      handler: () => Effect.succeed({ defaultBranch: "main" }),
    },
    {
      name: "searchDocs",
      description: "Search GitHub API documentation",
      inputJsonSchema: EmptyInputJson,
      validator: EmptyValidator,
      handler: () => Effect.succeed([]),
    },
  ],
});

const crmPlugin = makeTestPlugin({
  pluginId: "crm-test",
  integration: "crm",
  tools: [
    {
      name: "createContact",
      description: "Create a CRM contact record",
      inputJsonSchema: ContactInputJson,
      validator: ContactValidator,
      handler: () => Effect.succeed({ id: "contact_1" }),
    },
    {
      name: "listContacts",
      description: "List CRM contacts",
      inputJsonSchema: EmptyInputJson,
      validator: EmptyValidator,
      handler: () => Effect.succeed([]),
    },
  ],
});

const errorPlugin = makeTestPlugin({
  pluginId: "error-test",
  integration: "records",
  tools: [
    {
      name: "queryRows",
      description: "Query rows",
      inputJsonSchema: EmptyInputJson,
      validator: EmptyValidator,
      handler: () =>
        Effect.succeed(
          ToolResult.fail({
            code: "invalid_query",
            message: 'Field with name "DisplayName" does not exist',
          }),
        ),
    },
  ],
});

const oauthErrorPlugin = definePlugin(() => ({
  id: "oauth-error-test" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({
      tools: [
        {
          name: ToolName.make("queryRows"),
          description: "Query rows",
          inputSchema: EmptyInputJson,
        },
      ],
    }),
  invokeTool: ({ credential }) => Effect.succeed({ token: credential.value }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: IntegrationSlug.make("oauth_records"),
        description: "OAuth records",
        config: {},
      }),
  }),
}))();

const validatedInputPlugin = makeTestPlugin({
  pluginId: "validated-input-test",
  integration: "validated",
  tools: [
    {
      name: "getRepositoryDetails",
      description: "Get repository details including the default branch",
      inputJsonSchema: RepoInputJson,
      validator: RepoValidator,
      outputJsonSchema: RepoDetailsOutputJson,
      handler: () => Effect.succeed({ defaultBranch: "main" }),
    },
  ],
});

const structuredFailurePlugin = makeTestPlugin({
  pluginId: "structured-failure-test",
  integration: "upstream",
  tools: [
    {
      name: "nestedErrorBody",
      description: "",
      inputJsonSchema: EmptyInputJson,
      validator: EmptyValidator,
      handler: () =>
        Effect.succeed(
          ToolResult.fail({
            code: "upstream_http_error",
            status: 400,
            message: 'The expression "foo" is not valid. Provide a valid expression.',
            details: {
              error: {
                code: "invalidRequest",
                message: 'The expression "foo" is not valid. Provide a valid expression.',
              },
            },
          }),
        ),
    },
    {
      name: "flatErrorBody",
      description: "",
      inputJsonSchema: EmptyInputJson,
      validator: EmptyValidator,
      handler: () =>
        Effect.succeed(
          ToolResult.fail({
            code: "upstream_http_error",
            status: 400,
            message: "Field 'XYZ' does not exist",
            details: {
              errorCode: 400,
              errorMessage: "Field 'XYZ' does not exist",
            },
          }),
        ),
    },
    {
      name: "errorsArrayBody",
      description: "",
      inputJsonSchema: EmptyInputJson,
      validator: EmptyValidator,
      handler: () =>
        Effect.succeed(
          ToolResult.fail({
            code: "upstream_http_error",
            status: 403,
            message: "Insufficient scope",
            details: {
              errors: [{ status: "403", title: "Forbidden", detail: "Insufficient scope" }],
            },
          }),
        ),
    },
  ],
});

// Provision: register each plugin's integration and create one org `main`
// connection so per-connection tools exist and are addressable.
const provision = (
  executor: {
    readonly connections: {
      readonly create: (input: {
        readonly owner: "org";
        readonly name: typeof CONN;
        readonly integration: ReturnType<typeof IntegrationSlug.make>;
        readonly template: typeof TEMPLATE;
        readonly value: string;
      }) => Effect.Effect<unknown, unknown>;
    };
  } & Record<string, { readonly seed: () => Effect.Effect<unknown, unknown> }>,
  specs: readonly { readonly pluginId: string; readonly integration: string }[],
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    for (const spec of specs) {
      yield* executor[spec.pluginId]!.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: IntegrationSlug.make(spec.integration),
        template: TEMPLATE,
        value: "token",
      });
    }
  });

const makeExecutorWith = <const TPlugins extends readonly AnyPlugin[]>(plugins: TPlugins) =>
  createExecutor(makeTestConfig({ plugins }));

const makeSearchExecutor = () =>
  Effect.gen(function* () {
    const executor = yield* makeExecutorWith([githubPlugin, crmPlugin] as const);
    yield* provision(executor as never, [
      { pluginId: "github-test", integration: "github" },
      { pluginId: "crm-test", integration: "crm" },
    ]);
    return executor;
  });

describe("tool discovery", () => {
  it.effect("ranks matches using ids, namespaces, camelCase names, and descriptions", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();

      const githubMatches = yield* searchTools(executor, "github issues", 5);
      expect(githubMatches.items.map((match) => match.path)).toEqual([
        "github.org.main.listRepositoryIssues",
      ]);
      expect(githubMatches.items[0]?.score ?? 0).toBeGreaterThan(0);
      expect(githubMatches.hasMore).toBe(false);
      expect(githubMatches.nextOffset).toBeNull();

      const repoMatches = yield* searchTools(executor, "repo details", 5);
      expect(repoMatches.items[0]?.path).toBe("github.org.main.getRepositoryDetails");

      const crmMatches = yield* searchTools(executor, "crm create contact", 5);
      expect(crmMatches.items[0]?.path).toBe("crm.org.main.createContact");
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
      expect(githubOnly.items.map((match) => match.path)).toEqual([
        "github.org.main.listRepositoryIssues",
      ]);

      const crmOnly = yield* searchTools(executor, "list", 5, {
        namespace: "crm",
      });
      expect(crmOnly.items.map((match) => match.path)).toEqual(["crm.org.main.listContacts"]);

      const sandboxResult = yield* createExecutionEngine({ executor, codeExecutor }).execute(
        'return await tools.search({ namespace: "crm", query: "create contact", limit: 5 });',
        { onElicitation: acceptAll },
      );
      expect(sandboxResult.error).toBeUndefined();
      expect(sandboxResult.result).toEqual(
        expect.objectContaining({
          items: [expect.objectContaining({ path: "crm.org.main.createContact" })],
          total: 1,
          hasMore: false,
          nextOffset: null,
        }),
      );
    }),
  );

  it.effect("lets execution hosts provide custom tool discovery", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();
      const calls: Array<{
        readonly query: string;
        readonly namespace?: string;
        readonly limit: number;
        readonly offset: number;
      }> = [];
      const provider: ToolDiscoveryProvider = {
        searchTools: ({ query, namespace, limit, offset }) =>
          Effect.sync(() => {
            calls.push({ query, namespace, limit, offset });
            return {
              items: [
                {
                  path: "custom.org.main.searchResult",
                  name: "searchResult",
                  description: "Provided by the host",
                  integration: "custom",
                  score: 999,
                },
              ],
              total: 1,
              hasMore: false,
              nextOffset: null,
            };
          }),
      };
      const engine = createExecutionEngine({
        executor,
        codeExecutor,
        toolDiscoveryProvider: provider,
      });

      const result = yield* engine.execute(
        [
          "return await tools.search({",
          '  query: "calendar events",',
          '  namespace: "calendar",',
          "  limit: 7,",
          "  offset: 2,",
          "});",
        ].join("\n"),
        { onElicitation: acceptAll },
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        items: [
          {
            path: "custom.org.main.searchResult",
            name: "searchResult",
            description: "Provided by the host",
            integration: "custom",
            score: 999,
          },
        ],
        total: 1,
        hasMore: false,
        nextOffset: null,
      });
      expect(calls).toEqual([
        {
          query: "calendar events",
          namespace: "calendar",
          limit: 7,
          offset: 2,
        },
      ]);
    }),
  );

  it.effect("supports executor-scoped integration listing and tool search", () =>
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
          items: [expect.objectContaining({ path: "crm.org.main.listContacts" })],
        }),
      );
    }),
  );

  it.effect("paginates integration listings via limit + offset", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();
      const engine = createExecutionEngine({ executor, codeExecutor });

      // total = 2 (github, crm), sorted by id ("crm" < "github")
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

      const described = yield* describeTool(executor, "github.org.main.listRepositoryIssues");
      expect(described.path).toBe("github.org.main.listRepositoryIssues");
      expect(described.name).toBe("listRepositoryIssues");
      expect(described.description).toBe("List issues for a repository");
      expect(described.inputTypeScript).toBe("{ owner: string; repo: string; }");
      expect(described.outputTypeScript).toBe(
        "{ ok: true; data: unknown; http?: ToolHttpMeta } | { ok: false; error: ToolError }",
      );
      expect(described.typeScriptDefinitions).toEqual({
        ToolError:
          "{ code: string; message: string; status?: number; details?: unknown; retryable?: boolean }",
        ToolFile:
          '{ _tag: "ToolFile"; name?: string; mimeType: string; encoding: "base64"; data: string; byteLength: number; }',
        ToolHttpMeta: "{ status: number; headers: { [k: string]: string; } }",
      });
    }),
  );

  it.effect("describes a return type that accepts the sandbox invocation result", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();
      const engine = createExecutionEngine({ executor, codeExecutor });

      const execution = yield* engine.execute(
        [
          'const details = await tools.describe.tool({ path: "github.org.main.getRepositoryDetails" });',
          "const result = await tools.github.org.main.getRepositoryDetails({ owner: 'executor', repo: 'executor' });",
          "return {",
          "  outputTypeScript: details.outputTypeScript,",
          "  typeScriptDefinitions: details.typeScriptDefinitions,",
          "  result,",
          "};",
        ].join("\n"),
        { onElicitation: acceptAll },
      );

      expect(execution.error).toBeUndefined();
      const observed = execution.result as DescribedToolContract & { readonly result: unknown };
      const diagnostics = typeCheckDescribedInvocation(
        observed,
        observed.result,
        [
          "function readDefaultBranch(result: ToolOutput): string {",
          "  if (!result.ok) return result.error.message;",
          "  return result.data.defaultBranch;",
          "}",
          "readDefaultBranch(invokedResult);",
        ].join("\n"),
      );
      expect(diagnostics).toEqual([]);
    }),
  );

  it.effect(
    "describes an error-as-value return type that accepts sandbox invocation failures",
    () =>
      Effect.gen(function* () {
        const executor = yield* makeExecutorWith([errorPlugin] as const);
        yield* provision(executor as never, [{ pluginId: "error-test", integration: "records" }]);
        const engine = createExecutionEngine({ executor, codeExecutor });

        const execution = yield* engine.execute(
          [
            'const details = await tools.describe.tool({ path: "records.org.main.queryRows" });',
            "const result = await tools.records.org.main.queryRows({});",
            "return {",
            "  outputTypeScript: details.outputTypeScript,",
            "  typeScriptDefinitions: details.typeScriptDefinitions,",
            "  result,",
            "};",
          ].join("\n"),
          { onElicitation: acceptAll },
        );

        expect(execution.error).toBeUndefined();
        const observed = execution.result as DescribedToolContract & { readonly result: unknown };
        const diagnostics = typeCheckDescribedInvocation(
          observed,
          observed.result,
          [
            "function readToolResult(result: ToolOutput): unknown {",
            "  if (!result.ok) return result.error.message;",
            "  return result.data;",
            "}",
            "readToolResult(invokedResult);",
          ].join("\n"),
        );
        expect(diagnostics).toEqual([]);
      }),
  );

  it.effect("describes the ToolResult wrapper through the direct describe helper", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();
      const described = yield* describeTool(executor, "github.org.main.getRepositoryDetails");

      expect(described.outputTypeScript).toBe(
        "{ ok: true; data: { defaultBranch: string; }; http?: ToolHttpMeta } | { ok: false; error: ToolError }",
      );
      expect(described.typeScriptDefinitions).toEqual({
        ToolError:
          "{ code: string; message: string; status?: number; details?: unknown; retryable?: boolean }",
        ToolFile:
          '{ _tag: "ToolFile"; name?: string; mimeType: string; encoding: "base64"; data: string; byteLength: number; }',
        ToolHttpMeta: "{ status: number; headers: { [k: string]: string; } }",
      });
    }),
  );

  it.effect("describe on an unknown path returns tool_not_found with suggestions", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();

      // Wrong leaf under a real connection — the namespace-scoped search
      // should surface the actual tool as a suggestion.
      const described = yield* describeTool(executor, "github.org.main.getRepoDetails");
      expect(described.path).toBe("github.org.main.getRepoDetails");
      expect(described.name).toBe("github.org.main.getRepoDetails");
      expect(described.inputTypeScript).toBeUndefined();
      expect(described.error?.code).toBe("tool_not_found");
      expect(described.error?.message).toBe("Tool not found: github.org.main.getRepoDetails");
      expect(described.error?.suggestions).toContain("github.org.main.getRepositoryDetails");

      // Unknown namespace — falls back to a global search for the leaf.
      const elsewhere = yield* describeTool(executor, "nosuch.org.main.getRepositoryDetails");
      expect(elsewhere.error?.code).toBe("tool_not_found");
      expect(elsewhere.error?.suggestions).toContain("github.org.main.getRepositoryDetails");
    }),
  );

  it.effect("describes built-in discovery tool shapes that accept their runtime output", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();
      const engine = createExecutionEngine({ executor, codeExecutor });

      const execution = yield* engine.execute(
        [
          "const searchDetails = await tools.describe.tool({ path: 'search' });",
          "const sourceDetails = await tools.describe.tool({ path: 'executor.sources.list' });",
          "const describeDetails = await tools.describe.tool({ path: 'describe.tool' });",
          "return {",
          "  searchDetails,",
          "  searchResult: await tools.search({ query: 'repo details', limit: 2 }),",
          "  sourceDetails,",
          "  sourceResult: await tools.executor.sources.list({ limit: 2 }),",
          "  describeDetails,",
          "  describeResult: await tools.describe.tool({ path: 'github.org.main.getRepositoryDetails' }),",
          "};",
        ].join("\n"),
        { onElicitation: acceptAll },
      );

      expect(execution.error).toBeUndefined();
      const observed = execution.result as {
        readonly searchDetails: DescribedToolContract;
        readonly searchResult: unknown;
        readonly sourceDetails: DescribedToolContract;
        readonly sourceResult: unknown;
        readonly describeDetails: DescribedToolContract;
        readonly describeResult: unknown;
      };

      expect(
        typeCheckDescribedInvocation(observed.searchDetails, observed.searchResult, ""),
      ).toEqual([]);
      expect(
        typeCheckDescribedInvocation(observed.sourceDetails, observed.sourceResult, ""),
      ).toEqual([]);
      expect(
        typeCheckDescribedInvocation(observed.describeDetails, observed.describeResult, ""),
      ).toEqual([]);
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
          '  await tools.describe.tool({ path: "github.org.main.listRepositoryIssues", includeSchemas: true });',
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

  it.effect("passes ToolResult.fail through to the sandbox as a value (no throw)", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutorWith([errorPlugin] as const);
      yield* provision(executor as never, [{ pluginId: "error-test", integration: "records" }]);
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const result = yield* invoker.invoke({ path: "records.org.main.queryRows", args: {} });
      expect(result).toEqual({
        ok: false,
        error: {
          code: "invalid_query",
          message: 'Field with name "DisplayName" does not exist',
        },
      });
    }),
  );

  it.effect("returns OAuth reauth failures as ToolResult.fail instead of throwing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const config = makeTestConfig({
          plugins: [memoryCredentialsPlugin(), oauthErrorPlugin] as const,
        });
        const executor = yield* createExecutor(config);
        yield* executor["oauth-error-test"].seed();

        yield* executor.oauth.createClient({
          owner: "org",
          slug: OAUTH_CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: OAUTH_CLIENT,
          clientOwner: "org",
          name: CONN,
          integration: IntegrationSlug.make("oauth_records"),
          template: OAUTH_TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        yield* executor.oauth.complete({ state: started.state, code: callback.code });

        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) =>
              b.and(b("integration", "=", "oauth_records"), b("name", "=", String(CONN))),
            set: {
              expires_at: Date.now() - 60_000,
              refresh_item_id: "missing-refresh-token",
            },
          }),
        );

        const invoker = makeExecutorToolInvoker(executor, {
          invokeOptions: { onElicitation: acceptAll },
        });
        const result = yield* invoker.invoke({
          path: "oauth_records.org.main.queryRows",
          args: {},
        });

        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "oauth_reauth_required",
            message:
              'OAuth connection "oauth_records.org.main" requires reauthorization: Stored refresh token could not be resolved.',
            details: {
              category: "authentication",
              credential: {
                kind: "oauth",
                label: "oauth_records.org.main",
              },
            },
            retryable: false,
          },
        });
      }),
    ),
  );

  it.effect("returns missing tool dispatches as ToolResult.fail", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutorWith([] as const);
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const result = yield* invoker.invoke({ path: "missing.org.main.sourceTool", args: {} });

      expect(result).toEqual({
        ok: false,
        error: {
          code: "tool_not_found",
          message: "Tool not found: missing.org.main.sourceTool",
          details: { path: "missing.org.main.sourceTool", suggestions: [] },
        },
      });
    }),
  );

  it.effect("returns invalid tool arguments as ToolResult.fail", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutorWith([validatedInputPlugin] as const);
      yield* provision(executor as never, [
        { pluginId: "validated-input-test", integration: "validated" },
      ]);
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const result = yield* invoker.invoke({
        path: "validated.org.main.getRepositoryDetails",
        args: { url: "https://example.com/repo" },
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_tool_arguments",
          message: "Tool arguments did not match the input schema.",
          details: {
            issues: expect.arrayContaining([
              expect.objectContaining({ path: ["owner"], message: "Missing key" }),
              expect.objectContaining({ path: ["repo"], message: "Missing key" }),
            ]),
          },
        },
      });
    }),
  );

  it.effect("preserves nested upstream error bodies through ToolResult.fail", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutorWith([structuredFailurePlugin] as const);
      yield* provision(executor as never, [
        { pluginId: "structured-failure-test", integration: "upstream" },
      ]);
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const result = yield* invoker.invoke({ path: "upstream.org.main.nestedErrorBody", args: {} });
      expect(result).toEqual({
        ok: false,
        error: {
          code: "upstream_http_error",
          status: 400,
          message: 'The expression "foo" is not valid. Provide a valid expression.',
          details: {
            error: {
              code: "invalidRequest",
              message: 'The expression "foo" is not valid. Provide a valid expression.',
            },
          },
        },
      });
    }),
  );

  it.effect("preserves flat upstream error bodies through ToolResult.fail", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutorWith([structuredFailurePlugin] as const);
      yield* provision(executor as never, [
        { pluginId: "structured-failure-test", integration: "upstream" },
      ]);
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const result = yield* invoker.invoke({ path: "upstream.org.main.flatErrorBody", args: {} });
      expect(result).toEqual({
        ok: false,
        error: {
          code: "upstream_http_error",
          status: 400,
          message: "Field 'XYZ' does not exist",
          details: {
            errorCode: 400,
            errorMessage: "Field 'XYZ' does not exist",
          },
        },
      });
    }),
  );

  it.effect("preserves upstream errors arrays through ToolResult.fail", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutorWith([structuredFailurePlugin] as const);
      yield* provision(executor as never, [
        { pluginId: "structured-failure-test", integration: "upstream" },
      ]);
      const invoker = makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: acceptAll },
      });

      const result = yield* invoker.invoke({ path: "upstream.org.main.errorsArrayBody", args: {} });
      expect(result).toEqual({
        ok: false,
        error: {
          code: "upstream_http_error",
          status: 403,
          message: "Insufficient scope",
          details: {
            errors: [{ status: "403", title: "Forbidden", detail: "Insufficient scope" }],
          },
        },
      });
    }),
  );
});

// ---------------------------------------------------------------------------
// pause/resume — multiple elicitations in a single execution
// ---------------------------------------------------------------------------

const apiPlugin = makeTestPlugin({
  pluginId: "api-test",
  integration: "api",
  tools: [
    {
      name: "multiApproval",
      description: "A tool that elicits twice",
      inputJsonSchema: EmptyInputJson,
      validator: EmptyValidator,
      handler: ({ elicit }) =>
        Effect.gen(function* () {
          const r1 = yield* elicit(
            FormElicitation.make({
              message: "First approval",
              requestedSchema: {},
            }),
          );
          const r2 = yield* elicit(
            FormElicitation.make({
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
      inputJsonSchema: EmptyInputJson,
      validator: EmptyValidator,
      handler: ({ elicit }) =>
        Effect.gen(function* () {
          const r = yield* elicit(
            FormElicitation.make({
              message: "Only approval",
              requestedSchema: {},
            }),
          );
          return { ok: true, response: r };
        }),
    },
  ],
});

describe("pause/resume with multiple elicitations", () => {
  const makeElicitingExecutor = () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutorWith([apiPlugin] as const);
      yield* provision(executor as never, [{ pluginId: "api-test", integration: "api" }]);
      return executor;
    });

  it.effect(
    "resume does not hang when execution hits a second elicitation",
    () =>
      Effect.gen(function* () {
        const executor = yield* makeElicitingExecutor();
        const engine = createExecutionEngine({ executor, codeExecutor });

        const code = "return await tools.api.org.main.multiApproval({});";

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

  it.effect(
    "resume drains concurrent elicitations that were queued before the first approval",
    () =>
      Effect.gen(function* () {
        const executor = yield* makeElicitingExecutor();
        const engine = createExecutionEngine({ executor, codeExecutor });

        const code = `
          return await Promise.all([
            tools.api.org.main.singleApproval({}),
            tools.api.org.main.singleApproval({}),
            tools.api.org.main.singleApproval({})
          ]);
        `;

        const outcome1 = yield* engine.executeWithPause(code);
        expect(outcome1.status).toBe("paused");
        const paused1 = outcome1 as Extract<typeof outcome1, { status: "paused" }>;

        const outcome2 = yield* Effect.race(
          engine
            .resume(paused1.execution.id, { action: "accept" })
            .pipe(Effect.map((outcome) => ({ kind: "resumed" as const, outcome }))),
          Effect.sleep("2 seconds").pipe(Effect.as({ kind: "hung" as const })),
        );

        expect(outcome2.kind).toBe("resumed");
        if (outcome2.kind !== "resumed") return;
        expect(outcome2.outcome?.status).toBe("paused");
        const paused2 = outcome2.outcome as Extract<
          NonNullable<typeof outcome2.outcome>,
          { status: "paused" }
        >;

        const outcome3 = yield* engine.resume(paused2.execution.id, { action: "accept" });
        expect(outcome3?.status).toBe("paused");
        const paused3 = outcome3 as Extract<NonNullable<typeof outcome3>, { status: "paused" }>;

        const outcome4 = yield* engine.resume(paused3.execution.id, { action: "accept" });
        expect(outcome4?.status).toBe("completed");
        const completed = outcome4 as Extract<
          NonNullable<typeof outcome4>,
          { status: "completed" }
        >;
        expect(completed.result.error).toBeUndefined();
        expect(completed.result.result).toHaveLength(3);
      }),
    { timeout: 10000 },
  );

  it.effect(
    "execution ids are unique across engine instances (no counter reuse)",
    () =>
      Effect.gen(function* () {
        const executor = yield* makeElicitingExecutor();
        const engineA = createExecutionEngine({ executor, codeExecutor });
        const engineB = createExecutionEngine({ executor, codeExecutor });
        const code = "return await tools.api.org.main.singleApproval({});";

        const pausedA = yield* engineA.executeWithPause(code);
        const pausedB = yield* engineB.executeWithPause(code);
        expect(pausedA.status).toBe("paused");
        expect(pausedB.status).toBe("paused");
        if (pausedA.status !== "paused" || pausedB.status !== "paused") return;

        // A rebuilt engine (host restart) must never re-mint an id a client
        // may still hold — a stale resume would bind to the wrong pause.
        expect(pausedA.execution.id).not.toBe(pausedB.execution.id);

        yield* engineA.resume(pausedA.execution.id, { action: "accept" });
        yield* engineB.resume(pausedB.execution.id, { action: "accept" });
      }),
    { timeout: 10000 },
  );

  it.effect(
    "a duplicate resume replays the delivered outcome instead of reporting a missing pause",
    () =>
      Effect.gen(function* () {
        const executor = yield* makeElicitingExecutor();
        const engine = createExecutionEngine({ executor, codeExecutor });
        const code = "return await tools.api.org.main.singleApproval({});";

        const outcome1 = yield* engine.executeWithPause(code);
        expect(outcome1.status).toBe("paused");
        if (outcome1.status !== "paused") return;
        const executionId = outcome1.execution.id;

        const first = yield* engine.resume(executionId, { action: "accept" });
        expect(first?.status).toBe("completed");

        // The MCP client retries resume when the response is lost in
        // transit; the retry must return the same completed outcome.
        const retry = yield* engine.resume(executionId, { action: "accept" });
        expect(retry?.status).toBe("completed");
        const completed = retry as Extract<NonNullable<typeof retry>, { status: "completed" }>;
        expect(completed.result.error).toBeUndefined();
        expect(completed.result.result).toMatchObject({ ok: true });
      }),
    { timeout: 10000 },
  );

  it.effect(
    "autoApprove runs an eliciting tool to completion instead of pausing",
    () =>
      Effect.gen(function* () {
        const executor = yield* makeElicitingExecutor();
        const engine = createExecutionEngine({ executor, codeExecutor });
        const code = "return await tools.api.org.main.singleApproval({});";

        // Same tool that pauses without autoApprove (see the tests above) runs
        // straight through when the caller is the approver: no pause, no
        // executionId to resume, just the side effect's result.
        const outcome = yield* engine.executeWithPause(code, { autoApprove: true });
        expect(outcome.status, "autoApprove never pauses").toBe("completed");
        if (outcome.status !== "completed") return;
        expect(outcome.result.error).toBeUndefined();
        expect(outcome.result.result).toMatchObject({ ok: true });
      }),
    { timeout: 10000 },
  );

  // live clock: the sandbox timeout is a real timer, so the test must
  // actually wait for it rather than suspend on the virtual TestClock.
  it.live(
    "a pause abandoned by a failing sandbox is dropped and its resume replays the failure outcome",
    () =>
      Effect.gen(function* () {
        const executor = yield* makeElicitingExecutor();
        // Sandbox times out while suspended on the elicitation, so the fiber
        // settles without a resume ever arriving.
        const engine = createExecutionEngine({
          executor,
          codeExecutor: makeQuickJsExecutor({ timeoutMs: 250 }),
        });
        const code = "return await tools.api.org.main.singleApproval({});";

        const outcome1 = yield* engine.executeWithPause(code);
        expect(outcome1.status).toBe("paused");
        if (outcome1.status !== "paused") return;
        const executionId = outcome1.execution.id;

        // Wait for the sandbox timeout to settle the detached fiber.
        yield* Effect.sleep("600 millis");

        // The dead pause must no longer be reported as live...
        const stillPaused = yield* engine.getPausedExecution(executionId);
        expect(stillPaused).toBeNull();

        // ...and a late resume surfaces the terminal outcome, not a miss.
        const late = yield* engine.resume(executionId, { action: "accept" });
        expect(late?.status).toBe("completed");
        const completed = late as Extract<NonNullable<typeof late>, { status: "completed" }>;
        expect(completed.result.error).toContain("timed out");
      }),
    { timeout: 10000 },
  );

  // Regression: use separate top-level runPromise calls to match HTTP/CLI
  // pause/resume, and a single-elicit tool so no later pause can mask a dead
  // sandbox fiber.
  it("resume returns across separate runPromise boundaries for a single-elicit tool (HTTP-like)", async () => {
    const executor = await Effect.runPromise(
      Effect.gen(function* () {
        const ex = yield* makeExecutorWith([apiPlugin] as const);
        yield* provision(ex as never, [{ pluginId: "api-test", integration: "api" }]);
        return ex;
      }),
    );
    const engine = createExecutionEngine({ executor, codeExecutor });

    const code = "return await tools.api.org.main.singleApproval({});";

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
