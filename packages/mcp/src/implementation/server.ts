/** One execution manager with model, native and browser delivery adapters. */
import {
  Array as Arr,
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Layer,
  Match,
  Schema,
  Tracer,
  type Scope,
} from "effect";
import { McpServer } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ElicitationMode } from "../contracts/elicitation.ts";
import {
  McpToolkit,
  NativeMcpToolkit,
  BrowserMcpToolkit,
  type McpOptions,
} from "../contracts/tools.ts";
import type { BrowserExecutionResult } from "../contracts/browser-tools.ts";
import type { BrowserApprovals, BrowserDelivery } from "../contracts/browser.ts";
import type { McpExecutionResult } from "../contracts/execute.ts";
import { makeExecutions } from "./executions.ts";
import { executeNative } from "./native-elicitation.ts";
import { skills } from "./skills.ts";

// Observe the final protocol value after timeout, admission and resume handling.
const observeExecution =
  (name: "mcp.execute" | "mcp.resume") =>
  <A extends McpExecutionResult, E, R>(work: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      yield* Effect.annotateCurrentSpan("executor.attempt.id", crypto.randomUUID());
      return yield* work.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            yield* Effect.annotateCurrentSpan(
              "executor.duration_ms",
              Math.max(0, (yield* Clock.currentTimeMillis) - started),
            );
            if (Exit.isFailure(exit)) {
              yield* Effect.annotateCurrentSpan(
                "executor.outcome",
                Cause.hasInterruptsOnly(exit.cause) ? "cancelled" : "failed",
              );
              return;
            }
            const result: McpExecutionResult = exit.value;
            yield* Match.value(result).pipe(
              Match.when({ status: "completed" }, ({ execution }) =>
                Effect.annotateCurrentSpan({
                  "executor.outcome": execution.ok ? "completed" : "failed",
                  "executor.tool_call.count": execution.toolCalls.length,
                  ...(execution.ok ? {} : { "error.type": execution.error.kind }),
                }),
              ),
              Match.when({ status: "approval-required" }, () =>
                Effect.annotateCurrentSpan("executor.outcome", "pending"),
              ),
              Match.when({ status: "input-required" }, () =>
                Effect.annotateCurrentSpan("executor.outcome", "pending"),
              ),
              Match.when({ status: "capacity-exceeded" }, () =>
                Effect.annotateCurrentSpan({
                  "executor.outcome": "failed",
                  "error.type": "CapacityExceeded",
                }),
              ),
              Match.when({ status: "unavailable" }, () =>
                Effect.annotateCurrentSpan({
                  "executor.outcome": "failed",
                  "error.type": "ContinuationUnavailable",
                }),
              ),
              Match.when({ status: "busy" }, () =>
                Effect.annotateCurrentSpan("executor.outcome", "busy"),
              ),
              Match.exhaustive,
            );
          }),
        ),
      );
    }).pipe(Effect.withSpan(name));

const query = Schema.Struct({ elicitation_mode: Schema.optionalKey(ElicitationMode) });
const identity = (product: string, mode: ElicitationMode, session: string) =>
  JSON.stringify([product, mode, session]);
const withLink = (
  result: McpExecutionResult,
  sessionId: string,
  delivery: BrowserDelivery,
): Effect.Effect<BrowserExecutionResult> =>
  result.status === "approval-required" || result.status === "input-required"
    ? delivery
        .url({ sessionId, requestId: result.requestId })
        .pipe(Effect.map((approvalUrl) => ({ ...result, approvalUrl })))
    : Effect.succeed(result);

/** Build protocol state and its browser accessors together. Hosts authorize browser calls separately from MCP. */
export const makeMcp = (options: McpOptions) =>
  Effect.gen(function* () {
    const executions = yield* makeExecutions(options.limits, options.beforeExecute);
    const handler = (mode: ElicitationMode) =>
      Effect.gen(function* () {
        const delivery = options.browser;
        if (mode === "browser" && delivery === undefined)
          return Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { error: "Browser approval is unavailable on this host." },
              { status: 400 },
            ),
          );
        const protocols =
          mode === "native"
            ? options.protocols.filter(
                (protocol) =>
                  protocol.protocolVersion === "2025-06-18" ||
                  protocol.protocolVersion === "2025-11-25",
              )
            : options.protocols;
        if (!Arr.isReadonlyArrayNonEmpty(protocols))
          return Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { error: "Native approval requires a host protocol with form elicitation support." },
              { status: 400 },
            ),
          );
        const caller = Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const product = options.caller === undefined ? "" : yield* options.caller;
          const sessionId = request.headers["mcp-session-id"] ?? "stateless";
          return { id: identity(product, mode, sessionId), sessionId };
        });
        const skill = (input: Parameters<typeof skills>[0]) =>
          skills(input, options.backend).pipe(Effect.withSpan("mcp.skills"));
        const toolkit =
          mode === "native"
            ? McpServer.toolkit(NativeMcpToolkit).pipe(
                Layer.provide(
                  NativeMcpToolkit.toLayer({
                    execute: ({ code }) =>
                      caller.pipe(
                        Effect.flatMap(({ id }) =>
                          executeNative(executions, id, options.backend, code),
                        ),
                        observeExecution("mcp.execute"),
                      ),
                    skills: skill,
                  }),
                ),
              )
            : mode === "browser" && delivery !== undefined
              ? McpServer.toolkit(BrowserMcpToolkit).pipe(
                  Layer.provide(
                    BrowserMcpToolkit.toLayer({
                      execute: ({ code }) =>
                        caller.pipe(
                          Effect.flatMap(({ id, sessionId }) =>
                            executions
                              .execute(id, options.backend, code)
                              .pipe(
                                Effect.flatMap((result) => withLink(result, sessionId, delivery)),
                              ),
                          ),
                          observeExecution("mcp.execute"),
                        ),
                      resume: ({ requestId }) =>
                        caller.pipe(
                          Effect.flatMap(({ id, sessionId }) =>
                            Effect.gen(function* () {
                              const response = yield* executions.browserAnswer(
                                id,
                                requestId,
                                delivery.pollMs ?? 25_000,
                              );
                              if (response !== undefined)
                                return yield* executions
                                  .resume(id, options.backend, { requestId, response })
                                  .pipe(
                                    Effect.flatMap((result) =>
                                      withLink(result, sessionId, delivery),
                                    ),
                                  );
                              const pending = yield* executions.pendingInteraction(id, requestId);
                              return yield* pending === undefined
                                ? Effect.succeed({ status: "unavailable" as const, requestId })
                                : withLink(pending, sessionId, delivery);
                            }),
                          ),
                          observeExecution("mcp.resume"),
                        ),
                      skills: skill,
                    }),
                  ),
                )
              : McpServer.toolkit(McpToolkit).pipe(
                  Layer.provide(
                    McpToolkit.toLayer({
                      execute: ({ code }) =>
                        caller.pipe(
                          Effect.flatMap(({ id }) => executions.execute(id, options.backend, code)),
                          observeExecution("mcp.execute"),
                        ),
                      resume: (input) =>
                        caller.pipe(
                          Effect.flatMap(({ id }) => executions.resume(id, options.backend, input)),
                          observeExecution("mcp.resume"),
                        ),
                      skills: skill,
                    }),
                  ),
                );
        return yield* toolkit.pipe(
          Layer.provide(
            McpServer.layerHttp({ name: "Executor", version: "0.1.0", path: "/mcp", protocols }),
          ),
          HttpRouter.toHttpEffect,
          Effect.provideService(Layer.CurrentMemoMap, yield* Layer.makeMemoMap),
          Effect.orDie,
        );
      }).pipe(
        Effect.updateContext((context: Context.Context<Scope.Scope>) =>
          Context.omit(Tracer.ParentSpan)(context),
        ),
      );
    const model = yield* handler("model"),
      native = yield* handler("native"),
      browser = yield* handler("browser");
    const http = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Schema.decodeUnknownEffect(query)(
        HttpServerRequest.searchParamsFromURL(new URL(request.url, "http://mcp.internal")),
      ),
    ).pipe(
      Effect.matchEffect({
        onFailure: () =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { error: "Unsupported elicitation_mode. Use model, native or browser." },
              { status: 400 },
            ),
          ),
        onSuccess: ({ elicitation_mode }) =>
          Match.value(elicitation_mode ?? "model").pipe(
            Match.when("model", () => model),
            Match.when("native", () => native),
            Match.when("browser", () => browser),
            Match.exhaustive,
          ),
      }),
    );
    const approvals: BrowserApprovals = {
      get: (product, address) =>
        executions.browserView(identity(product, "browser", address.sessionId), address.requestId),
      answer: (product, address, response) =>
        executions.answerInBrowser(
          identity(product, "browser", address.sessionId),
          address.requestId,
          response,
        ),
    };
    return { http, approvals };
  });

/** Mount MCP alone when a host does not need direct browser accessors. */
export const mcp = (options: McpOptions) =>
  Layer.unwrap(makeMcp(options).pipe(Effect.map(({ http }) => HttpRouter.add("*", "/mcp", http))));
