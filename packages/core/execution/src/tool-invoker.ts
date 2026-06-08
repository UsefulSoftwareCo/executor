import { Effect, Predicate } from "effect";
import * as Cause from "effect/Cause";
import type {
  Executor,
  InvokeOptions,
  Integration,
  ToolError,
  Tool,
  ToolSchemaView,
} from "@executor-js/sdk/core";
import {
  authToolFailure,
  isToolResult,
  ToolResult,
  ToolAddress,
  parseToolAddress,
} from "@executor-js/sdk/core";
import type { SandboxToolInvoker } from "@executor-js/codemode-core";
import { ExecutionToolError } from "./errors";

const OPAQUE_DEFECT_MESSAGE = "Internal tool error";
const TOOL_ERROR_TYPESCRIPT =
  "{ code: string; message: string; status?: number; details?: unknown; retryable?: boolean }";

const wrapOutputTypeScript = (outputTypeScript?: string): string =>
  `{ ok: true; data: ${outputTypeScript ?? "unknown"} } | { ok: false; error: ToolError }`;

const withToolResultDefinitions = (
  definitions?: Record<string, string>,
): Record<string, string> => ({
  ...(definitions ?? {}),
  ToolError: TOOL_ERROR_TYPESCRIPT,
});

const ADDRESS_PREFIX = "tools.";

/**
 * Map a sandbox tool path to the executor's `execute` address.
 *
 * v2 dynamic tools are addressed `tools.<integration>.<owner>.<connection>.<tool>`.
 * The sandbox proxy strips the leading `tools.` (the proxy root), so a model
 * writing `tools.github.org.main.getRepo(args)` produces the path
 * `github.org.main.getRepo`. Re-prefix it so it parses as a 5-segment address.
 *
 * Plugin-contributed static tools (core-tools under `executor`, plugin executor
 * namespaces) are addressed by their fqid with no prefix; the executor resolves
 * those from its static map directly, so leave them untouched.
 */
const pathToAddress = (path: string): ToolAddress => {
  if (path.startsWith(ADDRESS_PREFIX)) return ToolAddress.make(path);
  if (parseToolAddress(`${ADDRESS_PREFIX}${path}`)) {
    return ToolAddress.make(`${ADDRESS_PREFIX}${path}`);
  }
  return ToolAddress.make(path);
};

/** Strip the proxy-root `tools.` prefix from a full address so it becomes the
 *  sandbox-callable path the model writes after `tools.`. */
const addressToPath = (address: string): string =>
  address.startsWith(ADDRESS_PREFIX) ? address.slice(ADDRESS_PREFIX.length) : address;

type DescribedTool = {
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  readonly inputTypeScript?: string;
  readonly outputTypeScript?: string;
  readonly typeScriptDefinitions?: Record<string, string>;
};

const BUILTIN_TOOL_DESCRIPTIONS: ReadonlyMap<string, DescribedTool> = new Map<
  string,
  DescribedTool
>([
  [
    "search",
    {
      path: "search",
      name: "search",
      description: "Search available Executor tools.",
      inputTypeScript: "{ query: string; namespace?: string; limit?: number; offset?: number; }",
      outputTypeScript:
        "{ items: ToolDiscoveryResult[]; total: number; hasMore: boolean; nextOffset: number | null; }",
      typeScriptDefinitions: {
        ToolDiscoveryResult:
          "{ path: string; name: string; description?: string; integration: string; score: number; }",
      },
    },
  ],
  [
    "executor.sources.list",
    {
      path: "executor.sources.list",
      name: "executor.sources.list",
      description: "List configured Executor integrations.",
      inputTypeScript: "{ query?: string; limit?: number; offset?: number; }",
      outputTypeScript:
        "{ items: ExecutorSourceListItem[]; total: number; hasMore: boolean; nextOffset: number | null; }",
      typeScriptDefinitions: {
        ExecutorSourceListItem:
          "{ id: string; name: string; kind: string; canRemove?: boolean; canRefresh?: boolean; toolCount: number; }",
      },
    },
  ],
  [
    "describe.tool",
    {
      path: "describe.tool",
      name: "describe.tool",
      description: "Describe a tool's compact TypeScript input and output shapes.",
      inputTypeScript: "{ path: string; }",
      outputTypeScript: "DescribedTool",
      typeScriptDefinitions: {
        DescribedTool:
          "{ path: string; name: string; description?: string; inputTypeScript?: string; outputTypeScript?: string; typeScriptDefinitions?: { [k: string]: string; }; }",
      },
    },
  ],
]);

const newCorrelationId = (): string => {
  // 8-hex-char correlation id; enough entropy to disambiguate within a
  // single deployment without leaking host process info.
  return Math.floor(Math.random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, "0");
};

const validationIssues = (value: unknown): readonly unknown[] | null => {
  if (typeof value !== "object" || value === null) return null;
  const issues = (value as { readonly issues?: unknown }).issues;
  return Array.isArray(issues) ? issues : null;
};

const credentialResolutionToolFailure = (input: {
  readonly label: string;
  readonly message: string;
  readonly reauthRequired?: boolean;
}) =>
  authToolFailure({
    code: input.reauthRequired === true ? "oauth_reauth_required" : "oauth_connection_failed",
    message:
      input.reauthRequired === true
        ? `OAuth connection "${input.label}" requires reauthorization: ${input.message}`
        : `OAuth connection "${input.label}" could not be resolved: ${input.message}`,
    credential: {
      kind: "oauth",
      label: input.label,
    },
  });

const expectedToolFailure = (value: unknown): ToolError | null => {
  if (Predicate.isTagged(value, "ToolNotFoundError") && "address" in value) {
    const suggestions =
      "suggestions" in value && Array.isArray(value.suggestions)
        ? value.suggestions.map((suggestion) => addressToPath(String(suggestion)))
        : undefined;
    const address = addressToPath(String(value.address));
    return {
      code: "tool_not_found",
      message: `Tool not found: ${address}`,
      details: { path: address, ...(suggestions ? { suggestions } : {}) },
    };
  }
  if (Predicate.isTagged(value, "ToolBlockedError") && "address" in value) {
    return {
      code: "tool_blocked",
      message: `Tool blocked by policy: ${addressToPath(String(value.address))}`,
      details: value,
    };
  }
  if (Predicate.isTagged(value, "ToolInvocationError")) {
    const issues = validationIssues((value as { readonly cause?: unknown }).cause);
    if (issues) {
      return {
        code: "invalid_tool_arguments",
        message: "Tool arguments did not match the input schema.",
        details: { issues },
      };
    }
  }
  return null;
};

/**
 * Extract the integration namespace from a tool path. v2 addresses look like
 * `<integration>.<owner>.<connection>.<tool>`; static fqids look like
 * `<source>.<op>`. We take the first segment as a cheap, non-lookup namespace
 * for the span attribute so it's always populated without a catalog read.
 */
const extractNamespace = (path: string): string => {
  const normalized = addressToPath(path);
  const idx = normalized.indexOf(".");
  return idx === -1 ? normalized : normalized.slice(0, idx);
};

/**
 * Bridges QuickJS `tools.<integration>.<owner>.<connection>.<tool>(args)` calls
 * into `executor.execute(address, args)`.
 *
 * Wrapped in `Effect.fn("mcp.tool.dispatch")` so every tool call becomes a
 * span in the Effect tracer. Attributes:
 *   - `mcp.tool.name`         — full tool path (e.g. "github.org.main.getRepo")
 *   - `mcp.tool.integration`  — first segment of the path (namespace)
 *
 * `mcp.tool.kind` (openapi | mcp | graphql | code) is NOT annotated here
 * because it would require an `integrations.list()` lookup on every invocation.
 * Callers that already know the integration kind can annotate at their own span.
 */
export const makeExecutorToolInvoker = (
  executor: Executor,
  options: { readonly invokeOptions: InvokeOptions },
): SandboxToolInvoker => ({
  invoke: Effect.fn("mcp.tool.dispatch")(function* ({ path, args }) {
    yield* Effect.annotateCurrentSpan({
      "mcp.tool.name": path,
      "mcp.tool.integration": extractNamespace(path),
    });

    const address = pathToAddress(path);
    const result = yield* executor.execute(address, args, options.invokeOptions).pipe(
      Effect.catchTag("CredentialResolutionError", (err) =>
        Effect.succeed(
          credentialResolutionToolFailure({
            label: `${err.integration}.${err.owner}.${err.name}`,
            message: err.message,
            reauthRequired: err.reauthRequired,
          }),
        ),
      ),
      Effect.catchCause((cause) => {
        const err = cause.reasons.find(Cause.isFailReason)?.error;
        const expected = expectedToolFailure(err);
        if (expected) {
          return Effect.succeed(ToolResult.fail(expected));
        }
        if (isElicitationDeclinedError(err)) {
          return Effect.fail(
            new ExecutionToolError({
              message: `Tool "${addressToPath(String(err.address))}" requires approval but the request was ${err.action === "cancel" ? "cancelled" : "declined"} by the user.`,
              cause: err,
            }),
          );
        }
        // Any other failure here is an infra/plugin defect. Emit an
        // opaque generic with a correlation id so internal context (URLs
        // with tokens, DB connection strings, file paths in stacks)
        // can't leak through Error.message into the sandbox. The full
        // cause is logged with the same correlation id so operators can
        // still trace the failure.
        const correlationId = newCorrelationId();
        return Effect.logError("tool dispatch failed", cause).pipe(
          Effect.annotateLogs({
            "executor.correlation_id": correlationId,
            "mcp.tool.name": path,
          }),
          Effect.flatMap(() =>
            Effect.fail(
              new ExecutionToolError({
                message: `${OPAQUE_DEFECT_MESSAGE} [${correlationId}]`,
                cause: err ?? cause,
              }),
            ),
          ),
        );
      }),
    );

    // Strict: plugins emit ToolResult<T>. Anything else is treated as a
    // raw success value and wrapped — keeps the sandbox-facing contract
    // uniform without forcing every tiny test plugin to import
    // `ToolResult.ok`.
    if (isToolResult(result)) {
      return result;
    }
    return { ok: true, data: result };
  }),
});

const isElicitationDeclinedError = (
  value: unknown,
): value is {
  readonly _tag: "ElicitationDeclinedError";
  readonly address: string;
  readonly action: "cancel" | "decline";
} =>
  Predicate.isTagged(value, "ElicitationDeclinedError") &&
  value !== null &&
  typeof value === "object" &&
  "address" in value &&
  typeof value.address === "string" &&
  "action" in value &&
  (value.action === "cancel" || value.action === "decline");

export type ToolDiscoveryResult = {
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  readonly integration: string;
  readonly score: number;
};

export type ExecutorSourceListItem = {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly canRemove?: boolean;
  readonly canRefresh?: boolean;
  readonly toolCount: number;
};

export type ToolDiscoveryInput = {
  readonly executor: Executor;
  readonly query: string;
  readonly namespace?: string;
  readonly limit: number;
  readonly offset: number;
};

export interface ToolDiscoveryProvider {
  readonly searchTools: (
    input: ToolDiscoveryInput,
  ) => Effect.Effect<PagedResult<ToolDiscoveryResult>, ExecutionToolError>;
}

/**
 * Page of results from a list-style discovery tool. Shared by
 * `tools.search` and `tools.executor.sources.list` so the model sees one
 * consistent shape:
 *
 *   - `items`      — the page (slice).
 *   - `total`      — count after filtering, before pagination. The model
 *                    can use this to detect truncation.
 *   - `hasMore`    — convenience flag for `(offset + items.length) < total`.
 *   - `nextOffset` — concrete offset for the next page when `hasMore`,
 *                    `null` otherwise. Pre-computing it removes a class of
 *                    off-by-one mistakes when the model paginates.
 */
export type PagedResult<T> = {
  readonly items: readonly T[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
};

const paginate = <T>(all: readonly T[], offset: number, limit: number): PagedResult<T> => {
  const total = all.length;
  const start = Math.min(Math.max(offset, 0), total);
  const items = all.slice(start, start + limit);
  const consumed = start + items.length;
  const hasMore = consumed < total;
  return {
    items,
    total,
    hasMore,
    nextOffset: hasMore ? consumed : null,
  };
};

/** What `searchTools` ranks over — the sandbox-callable path plus the v2
 *  identity fields a query can match against. */
type SearchableTool = {
  readonly path: string;
  readonly integration: string;
  readonly name: string;
  readonly description?: string;
};

const toSearchableTool = (tool: Tool): SearchableTool => ({
  path: addressToPath(String(tool.address)),
  integration: String(tool.integration),
  name: String(tool.name),
  description: tool.description,
});

type PreparedField = {
  readonly raw: string;
  readonly tokens: readonly string[];
};

const SEARCH_FIELD_WEIGHTS = {
  path: 12,
  integration: 8,
  name: 10,
  description: 5,
} as const;

const normalizeSearchText = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .toLowerCase()
    .trim();

const tokenizeSearchText = (value: string): string[] =>
  normalizeSearchText(value)
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);

const prepareField = (value?: string): PreparedField => ({
  raw: normalizeSearchText(value ?? ""),
  tokens: tokenizeSearchText(value ?? ""),
});

const scorePreparedField = (
  query: string,
  queryTokens: readonly string[],
  field: PreparedField,
  weight: number,
): {
  readonly score: number;
  readonly matchedTokens: ReadonlySet<string>;
  readonly exactPhraseMatch: boolean;
} => {
  if (field.raw.length === 0) {
    return {
      score: 0,
      matchedTokens: new Set<string>(),
      exactPhraseMatch: false,
    };
  }

  let score = 0;
  const matchedTokens = new Set<string>();
  const exactPhraseMatch = query.length > 0 && field.raw.includes(query);

  if (query.length > 0) {
    if (field.raw === query) {
      score += weight * 14;
    } else if (field.raw.startsWith(query)) {
      score += weight * 9;
    } else if (exactPhraseMatch) {
      score += weight * 6;
    }
  }

  for (const token of queryTokens) {
    if (field.tokens.includes(token)) {
      score += weight * 4;
      matchedTokens.add(token);
      continue;
    }

    if (
      field.tokens.some((candidate) => candidate.startsWith(token) || token.startsWith(candidate))
    ) {
      score += weight * 2;
      matchedTokens.add(token);
      continue;
    }

    if (field.raw.includes(token)) {
      score += weight;
      matchedTokens.add(token);
    }
  }

  return {
    score,
    matchedTokens,
    exactPhraseMatch,
  };
};

const matchesNamespace = (tool: SearchableTool, namespace?: string): boolean => {
  if (!namespace || normalizeSearchText(namespace).length === 0) {
    return true;
  }

  const namespaceTokens = tokenizeSearchText(namespace);
  if (namespaceTokens.length === 0) {
    return true;
  }

  const integrationTokens = tokenizeSearchText(tool.integration);
  const pathTokens = tokenizeSearchText(tool.path);

  const isPrefixMatch = (tokens: readonly string[]): boolean =>
    namespaceTokens.every((token, index) => tokens[index] === token);

  return isPrefixMatch(integrationTokens) || isPrefixMatch(pathTokens);
};

const scoreToolMatch = (tool: SearchableTool, query: string): ToolDiscoveryResult | null => {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenizeSearchText(query);

  if (normalizedQuery.length === 0 || queryTokens.length === 0) {
    return null;
  }

  const path = prepareField(tool.path);
  const integration = prepareField(tool.integration);
  const name = prepareField(tool.name);
  const description = prepareField(tool.description);

  const fieldScores = [
    scorePreparedField(normalizedQuery, queryTokens, path, SEARCH_FIELD_WEIGHTS.path),
    scorePreparedField(normalizedQuery, queryTokens, integration, SEARCH_FIELD_WEIGHTS.integration),
    scorePreparedField(normalizedQuery, queryTokens, name, SEARCH_FIELD_WEIGHTS.name),
    scorePreparedField(normalizedQuery, queryTokens, description, SEARCH_FIELD_WEIGHTS.description),
  ];

  const matchedTokens = new Set<string>();
  let score = 0;
  let exactPhraseMatch = false;

  for (const fieldScore of fieldScores) {
    score += fieldScore.score;
    exactPhraseMatch ||= fieldScore.exactPhraseMatch;
    for (const token of fieldScore.matchedTokens) {
      matchedTokens.add(token);
    }
  }

  if (matchedTokens.size === 0) {
    return null;
  }

  const coverage = matchedTokens.size / queryTokens.length;
  const minimumCoverage = queryTokens.length <= 2 ? 1 : 0.6;

  if (coverage < minimumCoverage && !exactPhraseMatch) {
    return null;
  }

  if (coverage === 1) {
    score += 25;
  } else {
    score += Math.round(coverage * 10);
  }

  if (path.tokens[0] === queryTokens[0] || name.tokens[0] === queryTokens[0]) {
    score += 8;
  }

  if (
    normalizeSearchText(tool.path) === normalizedQuery ||
    normalizeSearchText(tool.name) === normalizedQuery
  ) {
    score += 20;
  }

  return {
    path: tool.path,
    name: tool.name,
    description: tool.description,
    integration: tool.integration,
    score,
  };
};

/** What `tools.search()` calls inside the sandbox. */
export const searchTools = Effect.fn("executor.tools.search")(function* (
  executor: Executor,
  query: string,
  limit = 12,
  options?: { readonly namespace?: string; readonly offset?: number },
) {
  const offset = options?.offset ?? 0;
  yield* Effect.annotateCurrentSpan({
    "executor.search.query_length": query.length,
    "executor.search.limit": limit,
    "executor.search.offset": offset,
    ...(options?.namespace ? { "executor.search.namespace": options.namespace } : {}),
  });

  const empty: PagedResult<ToolDiscoveryResult> = {
    items: [],
    total: 0,
    hasMore: false,
    nextOffset: null,
  };

  if (normalizeSearchText(query).length === 0) {
    return empty;
  }

  const all = yield* executor.tools.list({ includeAnnotations: false }).pipe(
    Effect.mapError(
      (cause) =>
        new ExecutionToolError({
          message: "Failed to list tools for search",
          cause,
        }),
    ),
  );
  const searchable = all.map(toSearchableTool);
  const ranked = searchable
    .filter((tool: SearchableTool) => matchesNamespace(tool, options?.namespace))
    .map((tool: SearchableTool) => scoreToolMatch(tool, query))
    .filter(Predicate.isNotNull)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  const page = paginate(ranked, offset, limit);

  yield* Effect.annotateCurrentSpan({
    "executor.search.candidate_count": all.length,
    "executor.search.match_count": ranked.length,
    "executor.search.result_count": page.items.length,
    "executor.search.has_more": page.hasMore,
  });
  return page;
});

export const defaultToolDiscoveryProvider: ToolDiscoveryProvider = {
  searchTools: ({ executor, query, namespace, limit, offset }) =>
    searchTools(executor, query, limit, { namespace, offset }),
};

/** What `tools.executor.sources.list()` calls inside the sandbox. v2: the
 *  "sources" are the integration catalog; tool counts come from the
 *  per-connection tool list. */
export const listExecutorSources = Effect.fn("executor.sources.list")(function* (
  executor: Executor,
  options?: {
    readonly query?: string;
    readonly limit?: number;
    readonly offset?: number;
  },
) {
  const normalizedQuery = normalizeSearchText(options?.query ?? "");
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const integrations = yield* executor.integrations.list().pipe(
    Effect.mapError(
      (cause) =>
        new ExecutionToolError({
          message: "Failed to list executor integrations",
          cause,
        }),
    ),
  );

  const filtered =
    normalizedQuery.length === 0
      ? integrations
      : integrations.filter((integration: Integration) => {
          const haystack = normalizeSearchText(
            [String(integration.slug), integration.description, integration.kind].join(" "),
          );
          return tokenizeSearchText(normalizedQuery).every((token) => haystack.includes(token));
        });

  // Single query for all tools, then count per integration in memory.
  const allTools = yield* executor.tools.list({ includeAnnotations: false }).pipe(
    Effect.mapError(
      (cause) =>
        new ExecutionToolError({
          message: "Failed to list tools for integration counts",
          cause,
        }),
    ),
  );
  const toolCountByIntegration = new Map<string, number>();
  for (const tool of allTools) {
    const key = String(tool.integration);
    toolCountByIntegration.set(key, (toolCountByIntegration.get(key) ?? 0) + 1);
  }

  const sortedWithCounts = filtered
    .map(
      (integration: Integration) =>
        ({
          id: String(integration.slug),
          name: String(integration.slug),
          kind: integration.kind,
          canRemove: integration.canRemove,
          canRefresh: integration.canRefresh,
          toolCount: toolCountByIntegration.get(String(integration.slug)) ?? 0,
        }) satisfies ExecutorSourceListItem,
    )
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

  const page = paginate(sortedWithCounts, offset, limit);

  yield* Effect.annotateCurrentSpan({
    "executor.sources.candidate_count": integrations.length,
    "executor.sources.match_count": sortedWithCounts.length,
    "executor.sources.result_count": page.items.length,
    "executor.sources.has_more": page.hasMore,
  });
  return page;
});

/** What `tools.describe.tool()` calls inside the sandbox. */
export const describeTool = Effect.fn("executor.tools.describe")(function* (
  executor: Executor,
  path: string,
) {
  yield* Effect.annotateCurrentSpan({ "mcp.tool.name": path });

  const builtin = BUILTIN_TOOL_DESCRIPTIONS.get(path);
  if (builtin) return builtin;

  const address = pathToAddress(path);

  // Single tools.schema() call — it already fetches the tool row
  // internally. No need to also call tools.list() just for name/description.
  const schema: ToolSchemaView | null = yield* executor.tools.schema(address);

  // tools.schema() returns null if the tool doesn't exist. Fall back to
  // a minimal stub so callers can still render something.
  if (schema === null) {
    return { path, name: path };
  }

  // The schema's address is the tool address; name/description come from the
  // tool row which tools.schema() already loaded.
  return {
    path,
    name: schema.name ?? path,
    description: schema.description,
    inputTypeScript: schema.inputTypeScript,
    outputTypeScript: wrapOutputTypeScript(schema.outputTypeScript),
    typeScriptDefinitions: withToolResultDefinitions(schema.typeScriptDefinitions),
  };
});
