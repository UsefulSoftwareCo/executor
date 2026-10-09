/** One execution manager with model, native and browser delivery adapters. */
import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Layer,
  Match,
  Schema,
  Stream,
  Tracer,
  type Scope,
} from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpBody, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
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
import { eventsHandler } from "./events.ts";

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
                  "executor.tool_call.succeeded": execution.toolCalls.filter(
                    ({ outcome }) => outcome === "success",
                  ).length,
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

/**
 * MCP revisions every product serves, newest first. An initialize offering an unlisted revision
 * negotiates the newest initialize-based one; a session without an MCP-Protocol-Version header
 * keeps the revision it negotiated.
 */
const protocols = [
  McpProtocol.v2026_07_28,
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
] as const;
/** Native approval needs form elicitation, which 2025-06-18 introduced. */
const nativeProtocols = [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18] as const;

const query = Schema.Struct({ elicitation_mode: Schema.optionalKey(ElicitationMode) });
// Model and native programs belong to the authenticated caller, so a client may resume from
// any of its MCP sessions. Browser approval links address one protocol session.
const callerIdentity = (product: string, mode: "model" | "native") =>
  JSON.stringify([product, mode]);
const browserIdentity = (product: string, session: string) =>
  JSON.stringify([product, "browser", session]);

const withSseHeartbeat = (response: HttpServerResponse.HttpServerResponse) => {
  const body = response.body;
  const contentType = response.headers["content-type"];
  if (
    !(body instanceof HttpBody.Stream) ||
    contentType?.split(";")[0]?.trim() !== "text/event-stream"
  )
    return response;
  // A quiet SSE connection may not report a remote disconnect until another
  // write. Comments keep that transport active so abandoned subscriptions can
  // release their scopes. Ending the protocol stream also stops the heartbeat.
  const comment = new TextEncoder().encode(": keep-alive\n\n");
  const heartbeat = Stream.tick("5 seconds").pipe(
    Stream.drop(1),
    Stream.map(() => comment),
  );
  return HttpServerResponse.setBody(
    response,
    HttpBody.stream(Stream.merge(body.stream, heartbeat, { haltStrategy: "left" }), contentType),
  );
};

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
        const served = mode === "native" ? nativeProtocols : protocols;
        const caller = Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const product = yield* options.caller;
          const sessionId = request.headers["mcp-session-id"] ?? "stateless";
          return {
            id:
              mode === "browser"
                ? browserIdentity(product, sessionId)
                : callerIdentity(product, mode),
            sessionId,
          };
        });
        // Which skills agents read, and in what order, shows whether they follow the entry skill.
        const skill = (input: Parameters<typeof skills>[0]) =>
          skills(input, options.backend).pipe(
            Effect.tap((result) =>
              "content" in result ? options.annotateSkillRead(result) : Effect.void,
            ),
            Effect.withSpan("mcp.skills", {
              attributes: {
                "executor.skill.operation": input.name === undefined ? "list" : "read",
              },
            }),
          );
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
        return yield* Layer.mergeAll(
          toolkit,
          McpServer.events(eventsHandler(options.backend)),
        ).pipe(
          Layer.provide(
            McpServer.layerHttp({
              name: "Executor",
              version: "0.1.0",
              instructions: options.instructions,
              path: "/mcp",
              protocols: served,
            }),
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
    // Each mode's protocol server is built on its first request. A client keeps one
    // mode, so a host does not build all three. The build replaces the request's
    // context with this construction's: the server outlives the request, so it must
    // never capture a caller's backend, identity or scope.
    const context = yield* Effect.context<Effect.Services<ReturnType<typeof handler>>>();
    const onFirstUse = (mode: ElicitationMode) =>
      Effect.cached(
        handler(mode).pipe(
          Effect.updateContext<never, Effect.Services<ReturnType<typeof handler>>>(() => context),
          Effect.uninterruptible,
        ),
      ).pipe(Effect.map(Effect.flatten));
    const model = yield* onFirstUse("model"),
      native = yield* onFirstUse("native"),
      browser = yield* onFirstUse("browser");
    const http = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      const url = new URL(request.url, "http://mcp.internal");
      return Schema.decodeUnknownEffect(query)(HttpServerRequest.searchParamsFromURL(url)).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                { error: "Unsupported elicitation_mode. Use model, native or browser." },
                { status: 400 },
              ),
            ),
          onSuccess: ({ elicitation_mode }) =>
            Match.value(elicitation_mode ?? "model")
              .pipe(
                Match.when("model", () => model),
                Match.when("native", () => native),
                Match.when("browser", () => browser),
                Match.exhaustive,
              )
              .pipe(
                // Hosts may mount the transport under another path, such as an organization
                // URL; the protocol router itself is fixed at /mcp.
                Effect.provideService(
                  HttpServerRequest.HttpServerRequest,
                  request.modify({ url: `/mcp${url.search}` }),
                ),
              ),
        }),
      );
    }).pipe(Effect.map(withSseHeartbeat));
    const approvals: BrowserApprovals = {
      get: (product, address) =>
        executions.browserView(browserIdentity(product, address.sessionId), address.requestId),
      answer: (product, address, response) =>
        executions.answerInBrowser(
          browserIdentity(product, address.sessionId),
          address.requestId,
          response,
        ),
    };
    return { http, approvals };
  });

/** Mount MCP alone when a host does not need direct browser accessors. */
export const mcp = (options: McpOptions) =>
  Layer.unwrap(makeMcp(options).pipe(Effect.map(({ http }) => HttpRouter.add("*", "/mcp", http))));
