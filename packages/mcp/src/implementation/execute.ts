/** Build a live catalog and execute code against configured apps. */
import { CodeMode, Tool, toolError } from "@opencode-ai/codemode";
import {
  Json,
  AppSlug,
  JsonObject,
  ToolApprovalRequired,
  type AppId,
  type Cursor,
  type DeploymentId,
  type Tool as AppTool,
} from "@executor-js/sdk/core";
import { Clock, Effect, Schema, Semaphore } from "effect";
import { diagnostic, executionDiagnostic } from "./diagnostics.ts";
import type { McpTarget } from "../contracts/targets.ts";
import type { McpBackend } from "../contracts/backend.ts";
import {
  defaultMcpRuntimeLimits,
  SearchInput,
  SearchResult,
  type McpLimits,
  type UnavailableApp,
} from "../contracts/execute.ts";

type Catalog = Record<string, Record<string, Tool.Tool>>;

// Equivalent JSON Schema normalization: the upstream signature renderer only
// renders index signatures when additionalProperties is a schema, rather than true.
function renderableSchema(input: Tool.JsonSchema): Tool.JsonSchema {
  return {
    ...input,
    ...(input.type === "object" && input.additionalProperties !== false
      ? {
          additionalProperties:
            typeof input.additionalProperties === "object"
              ? renderableSchema(input.additionalProperties)
              : {},
        }
      : {}),
    ...(input.properties === undefined
      ? {}
      : {
          properties: Object.fromEntries(
            Object.entries(input.properties).map(([name, schema]) => [
              name,
              renderableSchema(schema),
            ]),
          ),
        }),
    ...(input.items === undefined ? {} : { items: renderableSchema(input.items) }),
    ...(input.anyOf === undefined ? {} : { anyOf: input.anyOf.map(renderableSchema) }),
    ...(input.oneOf === undefined ? {} : { oneOf: input.oneOf.map(renderableSchema) }),
    ...(input.allOf === undefined ? {} : { allOf: input.allOf.map(renderableSchema) }),
    ...(input.$defs === undefined
      ? {}
      : {
          $defs: Object.fromEntries(
            Object.entries(input.$defs).map(([name, schema]) => [name, renderableSchema(schema)]),
          ),
        }),
  };
}

// Codemode treats dots as namespace separators. Leave ordinary names readable;
// only escape characters needed to distinguish inaccessible/reserved segments.
function toolPath(name: string): string {
  return name
    .split(".")
    .map((segment) => {
      if (segment === "") return "%00";
      if (["__proto__", "prototype", "constructor"].includes(segment)) return `%${segment}`;
      return segment.replaceAll("%", "%25");
    })
    .join(".");
}

function listTools<E extends Error>(backend: McpBackend<E>, app: AppId, target: McpTarget) {
  return Effect.gen(function* () {
    const tools: AppTool[] = [];
    let cursor: Cursor | undefined;
    let deployment: DeploymentId | undefined;
    const selection =
      target.kind === "app" ? {} : { profile: target.id, expectedProfileRevision: target.revision };
    do {
      const page = yield* backend.listTools({
        app,
        ...selection,
        deployment,
        cursor,
        limit: 2_000,
      });
      deployment = page.deployment;
      tools.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return { tools, deployment, selection };
  });
}

function catalog(backend: McpBackend<Error>) {
  return Effect.gen(function* () {
    const concurrency = defaultMcpRuntimeLimits.discoveryConcurrency;
    const slots = yield* Semaphore.make(concurrency);
    const discover = <A, E, R>(name: string, work: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const queued = yield* Clock.currentTimeMillis;
        return yield* slots.withPermits(1)(
          Effect.gen(function* () {
            yield* Effect.annotateCurrentSpan(
              "executor.discovery.wait_ms",
              (yield* Clock.currentTimeMillis) - queued,
            );
            return yield* work;
          }),
        );
      }).pipe(Effect.withSpan(name));
    const apps = yield* backend.listApps().pipe(Effect.withSpan("mcp.discovery.apps"));
    yield* Effect.annotateCurrentSpan({
      "executor.discovery.apps": apps.length,
      "executor.discovery.concurrency": concurrency,
    });
    const counts = new Map<string, number>();
    for (const app of apps) counts.set(app.slug, (counts.get(app.slug) ?? 0) + 1);
    const discovered = yield* Effect.forEach(
      apps,
      (app) =>
        Effect.gen(function* () {
          if (!Schema.is(AppSlug)(app.slug) || counts.get(app.slug) !== 1)
            return {
              app,
              targets: [],
              error: !Schema.is(AppSlug)(app.slug) ? "AppSlugInvalid" : "AppSlugAmbiguous",
            };
          return yield* discover(
            "mcp.discovery.targets",
            backend.listTargets({ app: app.id }),
          ).pipe(
            Effect.flatMap((targets) =>
              Effect.forEach(
                targets,
                (target) =>
                  discover("mcp.discovery.tools", listTools(backend, app.id, target)).pipe(
                    Effect.map((catalog) => ({ target, catalog, error: undefined })),
                    Effect.catch((error) =>
                      Effect.succeed({ target, catalog: undefined, error: diagnostic(error) }),
                    ),
                  ),
                { concurrency: "unbounded" },
              ),
            ),
            Effect.map((targets) => ({ app, targets, error: undefined })),
            Effect.catch((error) => Effect.succeed({ app, targets: [], error: diagnostic(error) })),
          );
        }),
      { concurrency: "unbounded" },
    );
    const tools: Catalog = Object.create(null);
    const unavailableApps: Array<typeof UnavailableApp.Type> = [];
    for (const { app, targets, error } of discovered) {
      if (error !== undefined) {
        unavailableApps.push({ app: app.id, name: app.name, reason: error });
        continue;
      }
      const entries: Array<readonly [string, Tool.Tool]> = [];
      for (const { target, catalog, error } of targets) {
        if (catalog === undefined) {
          unavailableApps.push({
            app: app.id,
            name: app.name,
            ...(target.kind === "profile" ? { profile: target.id } : {}),
            reason: error,
          });
          continue;
        }
        const projected = yield* Effect.forEach(catalog.tools, (tool) =>
          Schema.decodeUnknownEffect(JsonObject)(tool.inputSchema).pipe(
            Effect.map(
              (input) =>
                [
                  target.kind === "app"
                    ? toolPath(tool.name)
                    : `profiles.${toolPath(target.id)}.${toolPath(tool.name)}`,
                  Tool.make({
                    description: `${app.name}${target.kind === "profile" ? ` (${target.label})` : ""}: ${tool.description}`,
                    input: renderableSchema(input),
                    output:
                      tool.outputSchema === undefined
                        ? Schema.Json
                        : renderableSchema(tool.outputSchema),
                    execute: (input) =>
                      Schema.decodeUnknownEffect(Json)(input).pipe(
                        Effect.mapError(() => toolError("Tool arguments must be JSON")),
                        Effect.flatMap((input) =>
                          backend
                            .callTool({
                              app: app.id,
                              deployment: catalog.deployment,
                              ...catalog.selection,
                              tool: tool.name,
                              input,
                            })
                            .pipe(
                              Effect.flatMap((result) =>
                                result.status === "completed"
                                  ? Effect.succeed(result.value)
                                  : Effect.fail(
                                      new ToolApprovalRequired({
                                        app: result.invocation.app,
                                        deployment: result.invocation.deployment,
                                        tool: result.invocation.tool,
                                      }),
                                    ),
                              ),
                              Effect.mapError((error) => toolError(diagnostic(error))),
                            ),
                        ),
                      ),
                  }),
                ] as const,
            ),
          ),
        );
        entries.push(...projected);
      }
      tools[app.slug] = Object.fromEntries(entries);
    }
    yield* Effect.annotateCurrentSpan({
      "executor.discovery.targets": discovered.reduce((sum, app) => sum + app.targets.length, 0),
      "executor.discovery.tools": Object.values(tools).reduce(
        (sum, entries) => sum + Object.keys(entries).length,
        0,
      ),
      "executor.discovery.unavailable": unavailableApps.length,
    });
    return { tools, unavailableApps };
  });
}

/** Bound catalog discovery and execution together; retain admitted calls if either times out. */
export function execute(backend: McpBackend<Error>, limits: McpLimits, code: string) {
  return executeProgram(
    {
      ...backend,
      callTool: (input, options) =>
        backend.callTool(input, options).pipe(
          Effect.withSpan("mcp.tool.call", {
            attributes: { "executor.app.id": input.app, "executor.tool.name": input.tool },
          }),
        ),
    },
    limits,
    code,
  );
}

/** Internal interpreter entry. The continuation driver owns active-time budgets when timeoutMs is absent. */
export function executeProgram(
  backend: McpBackend<Error>,
  limits: Omit<McpLimits, "timeoutMs"> & { readonly timeoutMs?: number },
  code: string,
  observe: (call: CodeMode.ToolCall) => void = () => {},
) {
  return Effect.suspend(() => {
    const toolCalls: Array<CodeMode.ToolCall> = [];
    let unavailableApps: ReadonlyArray<typeof UnavailableApp.Type> = [];
    const failure = (kind: CodeMode.DiagnosticKind, message: string) => ({
      execution: { ok: false as const, error: { kind, message }, toolCalls: [...toolCalls] },
      unavailableApps,
    });
    const program = Effect.gen(function* () {
      const prepared = yield* catalog(backend).pipe(Effect.withSpan("mcp.catalog"));
      unavailableApps = prepared.unavailableApps;
      const entries = CodeMode.make({ tools: prepared.tools }).catalog();
      const search = Tool.make({
        description: "Find available app tools and their callable signatures.",
        input: SearchInput,
        output: SearchResult,
        execute: ({ query = "", namespace, limit = 10, offset = 0 }) =>
          Effect.sync(() => {
            const terms = query
              .replace(/([a-z])([A-Z])/g, "$1 $2")
              .toLowerCase()
              .split(/[^a-z0-9]+/)
              .filter(Boolean);
            const visible = entries.filter(
              (entry) =>
                namespace === undefined ||
                entry.path === namespace ||
                entry.path.startsWith(`${namespace}.`) ||
                CodeMode.toolExpression(entry.path).startsWith(`${namespace}.`),
            );
            const exact = visible.find(
              (entry) => query === entry.path || query === CodeMode.toolExpression(entry.path),
            );
            const matches =
              exact === undefined
                ? visible
                    .map((entry) => ({
                      entry,
                      score: terms.reduce(
                        (sum, term) =>
                          sum +
                          (entry.path.toLowerCase().includes(term) ? 3 : 0) +
                          (entry.description.toLowerCase().includes(term) ? 1 : 0),
                        0,
                      ),
                    }))
                    .filter(({ score }) => terms.length === 0 || score > 0)
                    .sort((a, b) => b.score - a.score)
                    .map(({ entry }) => entry)
                : [exact];
            const items = matches.slice(offset, offset + limit).map((entry) => ({
              ...entry,
              path: CodeMode.toolExpression(entry.path),
            }));
            const remaining = Math.max(0, matches.length - offset - items.length);
            return {
              items,
              remaining,
              next: remaining > 0 ? { offset: offset + items.length } : null,
            };
          }),
      });
      const execution = yield* CodeMode.execute({
        code,
        tools: { ...prepared.tools, search },
        limits,
        onToolCallStart: ({ name }) =>
          Effect.sync(() => {
            toolCalls.push({ name });
            observe({ name });
          }),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CodeMode.Result)),
        Effect.map(executionDiagnostic),
      );
      yield* Effect.annotateCurrentSpan("executor.outcome", execution.ok ? "completed" : "failed");
      return { execution, unavailableApps };
    }).pipe(
      Effect.catch((error) => Effect.succeed(failure("ExecutionFailure", diagnostic(error)))),
    );
    return limits.timeoutMs === undefined
      ? program
      : program.pipe(
          Effect.timeoutOrElse({
            duration: limits.timeoutMs,
            orElse: () =>
              Effect.succeed(
                failure(
                  "TimeoutExceeded",
                  "Execution timed out; earlier tool calls may have completed",
                ),
              ),
          }),
        );
  });
}
