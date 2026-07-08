import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest } from "effect/unstable/http";
import { Effect } from "effect";
import { generateOpenApiSpec, ToolAddress, ToolNotFoundError, type Tool } from "@executor-js/sdk";
import { formatExecuteResult } from "@executor-js/execution";

import { ExecutorApi } from "../api";
import { ExecutionEngineService, ExecutorService } from "../services";
import { capture, captureEngineError } from "@executor-js/api";

const toMetadata = (t: Tool) => ({
  address: t.address,
  owner: t.owner,
  integration: t.integration,
  connection: t.connection,
  name: t.name,
  pluginId: t.pluginId,
  description: t.description,
  mayElicit: t.annotations?.mayElicit,
  requiresApproval: t.annotations?.requiresApproval,
  approvalDescription: t.annotations?.approvalDescription,
  static: t.static,
});

export const ToolsHandlers = HttpApiBuilder.group(ExecutorApi, "tools", (handlers) =>
  handlers
    .handle("list", ({ query }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const tools = yield* executor.tools.list({
            integration: query.integration,
            owner: query.owner,
            connection: query.connection,
            query: query.query,
            includeAnnotations: query.includeAnnotations === "true",
            includeBlocked: query.includeBlocked !== "false",
          });
          return tools.map(toMetadata);
        }),
      ),
    )
    .handle("schema", ({ query }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const schema = yield* executor.tools.schema(query.address);
          if (schema === null) {
            return yield* new ToolNotFoundError({ address: query.address });
          }
          return schema;
        }),
      ),
    )
    .handle("export", ({ query }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return yield* executor.tools.export({
            integration: query.integration,
            owner: query.owner,
            connection: query.connection,
            query: query.query,
            includeAnnotations: query.includeAnnotations === "true",
            includeBlocked: query.includeBlocked === "true",
          });
        }),
      ),
    )
    .handle("openapi", ({ query }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const request = yield* HttpServerRequest.HttpServerRequest;
          const catalog = yield* executor.tools.export({
            integration: query.integration,
            owner: query.owner,
            connection: query.connection,
            query: query.query,
            includeAnnotations: query.includeAnnotations === "true",
            includeBlocked: query.includeBlocked === "true",
          });
          const serverUrl = serverUrlFromRequest(request);
          return generateOpenApiSpec(catalog, {
            ...(serverUrl !== undefined ? { serverUrl } : {}),
          }).document;
        }),
      ),
    )
    .handle("invoke", ({ params, query, payload }) =>
      capture(
        Effect.gen(function* () {
          const path = params.path;
          const address = ToolAddress.make(path.startsWith("tools.") ? path : `tools.${path}`);
          if (!TOOL_PATH_PATTERN.test(path)) {
            return yield* new ToolNotFoundError({ address });
          }
          if (payload !== undefined && !isJsonObject(payload)) {
            return failureOutcome({
              code: "invalid_input",
              message: "Tool input must be a JSON object.",
            });
          }

          // Run through the execution engine (not executor.execute directly)
          // so approval-gated calls pause with a resumable executionId, same
          // as every other host surface.
          const engine = yield* ExecutionEngineService;
          const outcome = yield* captureEngineError(
            engine.executeWithPause(buildInvokeCode(path, payload ?? {}), {
              autoApprove: query.autoApprove === "true",
            }),
          );

          if (outcome.status === "paused") {
            return failureOutcome({
              code: "execution_paused",
              message: "This call requires approval. Resume the paused execution to complete it.",
              executionId: outcome.execution.id,
              resumePath: `/executions/${encodeURIComponent(outcome.execution.id)}/resume`,
            });
          }

          const formatted = formatExecuteResult(outcome.result);
          const result = isJsonObject(formatted.structured)
            ? formatted.structured.result
            : undefined;
          if (isToolNotFoundSentinel(result) || isToolNotFoundOutcome(result)) {
            return yield* new ToolNotFoundError({ address });
          }
          if (formatted.isError) {
            return failureOutcome({
              code: "execution_failed",
              message: formatted.text,
            });
          }
          // Dynamic tools already return the ok/error envelope; static tools
          // may return raw values, wrapped here so the wire shape is uniform.
          if (isJsonObject(result) && result.ok === true) {
            return {
              ok: true as const,
              ...("data" in result ? { data: result.data } : {}),
              ...("http" in result ? { http: result.http } : {}),
            };
          }
          if (isJsonObject(result) && result.ok === false) {
            return failureOutcome(
              isJsonObject(result.error) ? result.error : { value: result.error },
            );
          }
          return { ok: true as const, data: result };
        }),
      ),
    ),
);

// ---------------------------------------------------------------------------
// tools.invoke plumbing
// ---------------------------------------------------------------------------

type InvokeOutcomeShape =
  | { readonly ok: true; readonly data?: unknown; readonly http?: unknown }
  | { readonly ok: false; readonly error: unknown };

// Dotted tool path: letters/digits/._- segments (mirrors the CLI's
// tool-path validation; blocks anything that could escape the code string).
const TOOL_PATH_PATTERN = /^[A-Za-z0-9._-]+$/;

const TOOL_NOT_FOUND_SENTINEL = "__executor_tool_not_found__";

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const failureOutcome = (error: Record<string, unknown>): InvokeOutcomeShape => ({
  ok: false,
  error,
});

const isToolNotFoundSentinel = (value: unknown): boolean =>
  isJsonObject(value) && value[TOOL_NOT_FOUND_SENTINEL] === true;

/** The sandbox `tools` proxy makes every path callable and reports a missing
 *  tool as an `ok: false` outcome with `code: "tool_not_found"`; surface that
 *  as HTTP 404 (the sentinel above only fires when the proxy is bypassed). */
const isToolNotFoundOutcome = (value: unknown): boolean =>
  isJsonObject(value) &&
  value.ok === false &&
  isJsonObject(value.error) &&
  value.error.code === "tool_not_found";

/** Same invocation shape the CLI's `executor call` generates: resolve the
 *  path off the sandbox `tools` proxy and call it. A missing tool returns a
 *  sentinel (not a throw) so the handler can answer 404 instead of burying
 *  "not found" inside an execution error string. */
const buildInvokeCode = (toolPath: string, args: unknown): string => {
  const access = toolPath
    .split(".")
    .map((segment) => `[${JSON.stringify(segment)}]`)
    .join("");
  return [
    `const __args = ${JSON.stringify(args)};`,
    `const __target = tools${access};`,
    `if (typeof __target !== "function") {`,
    `  return { ${JSON.stringify(TOOL_NOT_FOUND_SENTINEL)}: true };`,
    `}`,
    `return await __target(__args);`,
  ].join("\n");
};

/** Derive the spec's `servers[0].url` from the incoming request: the API
 *  base is everything before the `/tools/export/openapi` suffix.
 *  `request.url` may be path-only depending on the host adapter; rebuild the
 *  origin from Forwarded/Host headers when it is. */
const serverUrlFromRequest = (request: HttpServerRequest.HttpServerRequest): string | undefined => {
  const marker = "/tools/export/openapi";
  // originalUrl keeps a router-level mount prefix (self-host's
  // `router.prefixed("/api")`); hosts whose outer shell strips `/api` before
  // dispatch (local) leave an empty prefix here. Either way the public API
  // base is `origin + /api` (what the CLI's apiBaseUrl dials), so an empty
  // prefix falls back to `/api`.
  const url = request.originalUrl;
  const index = url.indexOf(marker);
  if (index < 0) return undefined;
  const rawPrefix = url.slice(0, index);
  if (/^https?:\/\//.test(rawPrefix)) {
    // Absolute URL: split origin from any path prefix; an empty path means
    // the shell stripped `/api` before dispatch.
    const slash = rawPrefix.indexOf("/", rawPrefix.indexOf("//") + 2);
    const origin = slash < 0 ? rawPrefix : rawPrefix.slice(0, slash);
    const pathPrefix = slash < 0 ? "" : rawPrefix.slice(slash);
    return `${origin}${pathPrefix.length > 0 ? pathPrefix : "/api"}`;
  }
  const prefix = rawPrefix.length > 0 ? rawPrefix : "/api";
  const host = request.headers["x-forwarded-host"] ?? request.headers.host;
  if (typeof host !== "string" || host.length === 0) return undefined;
  const proto = request.headers["x-forwarded-proto"];
  const scheme = typeof proto === "string" && proto.length > 0 ? proto : "http";
  return `${scheme}://${host}${prefix}`;
};
