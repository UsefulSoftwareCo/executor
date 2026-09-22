/** Browser transport uses native Effect HTTP and Atom; authors receive Promise calls and atoms. */
import { browserSettings, makeBrowserTelemetry } from "@executor-js/telemetry/browser";
import {
  Cause,
  Clock,
  Effect,
  Exit,
  Layer,
  Option,
  Schedule,
  Schema as EffectSchema,
  Stream,
  Tracer,
} from "effect";
import { Atom } from "effect/unstable/reactivity";
import { externalTrace, pendingSpan } from "@executor-js/telemetry";
import { FetchHttpClient, HttpClientError } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { AppUiApi, UiContext, UiDeploymentChanged, UiFailed } from "../contracts/ui.ts";
import { AppQueryFailed, type OperationReference } from "../contracts/live.ts";
import { JsonValue } from "../contracts/schema.ts";
import { decoderOf, type Schema } from "./schema.ts";
import { makeOptimisticClient } from "./optimistic.ts";
import { queryResult, type ObservedQueryValue } from "./query-commit.ts";

/** A scoped page client. Host-injected context carries only the deployment, never credentials. */
export const createAppClient = () => {
  const { runtime, atoms } = makeBrowserTelemetry(
    browserSettings("/_executor/api/telemetry", "executor-app-web"),
  );
  const browser = atoms(Layer.empty);
  const deploymentChanged = Effect.sync(() => {
    window.dispatchEvent(new Event("executor:deployment-changed"));
  });
  let pendingWrites = 0;
  const beforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue = "";
  };
  // Protect queued writes as well as the request currently awaiting its response.
  // Reconciliation reads can outlive acknowledgement and do not need this guard.
  const awaitWrite = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => {
    if (pendingWrites++ === 0) window.addEventListener("beforeunload", beforeUnload);
    return runtime.runPromise(effect).finally(() => {
      if (--pendingWrites === 0) window.removeEventListener("beforeunload", beforeUnload);
    });
  };
  const onHide = (event: PageTransitionEvent) => {
    if (!event.persisted) void dispose().catch((error) => console.error(error));
  };
  const dispose = async () => {
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("beforeunload", beforeUnload);
    optimistic.dispose();
    await runtime.dispose();
  };
  window.addEventListener("pagehide", onHide);
  runtime.runFork(Effect.void);

  const context = Effect.try({
    try: () => document.getElementById("executor-context")?.textContent,
    catch: () => new UiFailed({ reason: "unavailable" }),
  }).pipe(Effect.flatMap(EffectSchema.decodeUnknownEffect(EffectSchema.fromJsonString(UiContext))));
  const client = HttpApiClient.make(AppUiApi).pipe(Effect.provide(FetchHttpClient.layer));
  const payload = (name: string, input: unknown) =>
    Effect.gen(function* () {
      return {
        ...(yield* context),
        name,
        input: yield* EffectSchema.decodeUnknownEffect(JsonValue)(input),
      };
    });
  const request = <Input, Output>(
    kind: "query" | "mutate",
    name: string,
    input: Input,
    output: Schema<Output, boolean>,
  ) =>
    Effect.gen(function* () {
      const api = yield* client;
      const value = yield* api.ui[kind]({ payload: yield* payload(name, input) });
      return yield* EffectSchema.decodeUnknownEffect(decoderOf(output))(value);
    }).pipe(
      Effect.tapErrorTag("UiDeploymentChanged", () => deploymentChanged),
      Effect.withSpan(`ui.app.${kind}`, { attributes: { "executor.operation.name": name } }),
    );
  const source = (name: string, input: JsonValue, output: Schema<unknown, boolean>) =>
    browser
      .atom(
        Stream.suspend(() => {
          let previous: Tracer.ExternalSpan | undefined;
          let attempts = 0;
          return Stream.unwrap(
            Effect.gen(function* () {
              const attempt = attempts++;
              const first = yield* pendingSpan("ui.app.first_result", {
                attributes: {
                  "executor.operation.name": name,
                  "executor.subscription.attempt": attempt,
                },
                links:
                  previous === undefined
                    ? []
                    : [{ span: previous, attributes: { "executor.link.kind": "retry" } }],
              });
              previous = Tracer.externalSpan({
                traceId: first.span.traceId,
                spanId: first.span.spanId,
                sampled: first.span.sampled,
              });
              const finish = (exit: Exit.Exit<unknown, unknown>) =>
                first.finish(exit).pipe(
                  Effect.andThen(
                    Exit.isFailure(exit) && !Cause.hasInterrupts(exit.cause)
                      ? Effect.fail(new AppQueryFailed()).pipe(
                          Effect.withSpan("ui.app.subscription.failure", {
                            parent: first.span,
                            attributes: {
                              "executor.operation.name": name,
                              "executor.subscription.attempt": attempt,
                            },
                          }),
                          Effect.ignore,
                        )
                      : Effect.void,
                  ),
                );
              const clock = yield* Clock.Clock;
              const started = clock.currentTimeMillisUnsafe();
              const frames = yield* Effect.gen(function* () {
                const api = yield* client;
                return yield* api.ui.subscribe({
                  payload: yield* payload(name, input),
                });
              }).pipe(
                Effect.withSpan("ui.app.subscribe", {
                  parent: first.span,
                  attributes: { "executor.operation.name": name },
                }),
                Effect.onError((cause) => finish(Exit.failCause(cause))),
              );
              let revision = 0;
              return frames.pipe(
                Stream.timeout("45 seconds"),
                Stream.concat(Stream.fail(new UiFailed({ reason: "unavailable" }))),
                Stream.filter((frame) => frame.type !== "heartbeat"),
                Stream.mapEffect((frame) => {
                  if (frame.type === "failure") return Effect.fail(frame.error);
                  const server = externalTrace(frame.trace);
                  return Effect.gen(function* () {
                    const value = yield* EffectSchema.decodeUnknownEffect(decoderOf(output))(
                      frame.value,
                    ).pipe(Effect.mapError(() => new UiFailed({ reason: "operation_failed" })));
                    const received = yield* Effect.currentSpan;
                    const receivedAt = clock.currentTimeMillisUnsafe();
                    const currentRevision = revision++;
                    yield* Effect.annotateCurrentSpan({
                      "executor.operation.name": name,
                      "executor.snapshot.revision": currentRevision,
                      "browser.query.elapsed_ms": receivedAt - started,
                      "executor.trace.context_valid": Option.isSome(server),
                    });
                    yield* first.finish(Exit.void);
                    let committed = false;
                    return {
                      value,
                      commit: () => {
                        if (committed) return;
                        committed = true;
                        const committedAt = clock.currentTimeMillisUnsafe();
                        runtime.runFork(
                          Effect.void.pipe(
                            Effect.withSpan("ui.app.result.commit", {
                              parent: received,
                              attributes: {
                                "executor.operation.name": name,
                                "executor.snapshot.revision": currentRevision,
                                "browser.query.elapsed_ms": committedAt - started,
                                "browser.query.receive_to_commit_ms": committedAt - receivedAt,
                                "browser.page.hidden": document.visibilityState === "hidden",
                              },
                            }),
                          ),
                        );
                      },
                    } satisfies ObservedQueryValue<unknown>;
                  }).pipe(
                    Effect.withSpan("ui.app.result.receive", {
                      parent: Option.isSome(server) ? server.value : first.span,
                      kind: "consumer",
                    }),
                  );
                }),
                Stream.onExit(finish),
                Stream.provideService(Tracer.ParentSpan, first.span),
              );
            }),
          ).pipe(
            // Keep the last snapshot while the watcher replaces the document.
            // Unmount or client disposal interrupts the deployment-change wait.
            Stream.catch((error) =>
              EffectSchema.is(UiDeploymentChanged)(error)
                ? Stream.unwrap(deploymentChanged.pipe(Effect.as(Stream.never)))
                : Stream.fail(error),
            ),
            Stream.retry(
              Schedule.spaced("1 second").pipe(
                Schedule.while(
                  ({ input }) =>
                    HttpClientError.isHttpClientError(input) ||
                    Cause.isTimeoutError(input) ||
                    EffectSchema.is(UiFailed)(input),
                ),
              ),
            ),
          );
        }),
      )
      .pipe(Atom.map(queryResult));
  const optimistic = makeOptimisticClient({
    source,
    read: (name, input, output) => request("query", name, input, output),
    write: (name, input, output) => request("mutate", name, input, output),
    fork: (effect) => {
      runtime.runFork(effect);
    },
    run: awaitWrite,
    reportProjectionError: (error) =>
      console.error("Optimistic update failed during replay.", error),
  });
  return {
    /** Close this client when its page or embedding owner is removed. */
    dispose,
    /** Query this app once, with a runtime-validated response. Does not populate the mounted query cache. */
    query: <Input, Output>(
      reference: OperationReference<Input, Output, "query">,
      input: NoInfer<Input>,
      output: Schema<NoInfer<Output>, boolean>,
    ) => runtime.runPromise(request("query", reference.name, input, output)),
    /** Execute a write once in this client's queue. Success acknowledges the write; queries reconcile afterward. */
    mutate: <Input, Output>(
      reference: OperationReference<Input, Output, "mutation">,
      input: NoInfer<Input>,
      output: Schema<NoInfer<Output>, boolean>,
    ) => optimistic.mutation(reference, output)(input),
    /** Create a callable mutation with optional withOptimisticUpdate projections over mounted queries. */
    mutation: optimistic.mutation,
    /** Share a live query across mounts and reconcile optimistic changes against fresh server reads. */
    queryAtom: optimistic.queryAtom,
  };
};
