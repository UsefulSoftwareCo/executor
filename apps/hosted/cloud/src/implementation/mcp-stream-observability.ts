import { Cause, Clock, Effect, Exit, Stream } from "effect";
import { HttpBody, HttpServerRequest, HttpServerResponse } from "effect/http";
import { providerFailureCode } from "./provider-failure.ts";

const heldHeader = "x-executor-session-stream";

export const observeMcpStream =
  (phase: "gateway" | "session") => (response: HttpServerResponse.HttpServerResponse) =>
    Effect.gen(function* () {
      const body = response.body;
      const held =
        body instanceof HttpBody.Stream &&
        (phase === "session" || response.headers[heldHeader] === "held");
      yield* Effect.annotateCurrentSpan("executor.mcp.response.held", held);
      const forwarded =
        phase === "session"
          ? held
            ? HttpServerResponse.setHeader(response, heldHeader, "held")
            : response
          : HttpServerResponse.removeHeader(response, heldHeader);
      if (!(body instanceof HttpBody.Stream)) return forwarded;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const native = yield* HttpServerRequest.toWeb(request);
      const requestSpan = yield* Effect.currentSpan.pipe(Effect.orDie);
      const opened = yield* Clock.currentTimeMillis;
      return HttpServerResponse.setBody(
        forwarded,
        HttpBody.stream(
          body.stream.pipe(
            Stream.onExit((exit) =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((closed) =>
                  Effect.void.pipe(
                    Effect.withSpan("mcp.stream.close", {
                      attributes: {
                        "executor.mcp.stream.phase": phase,
                        "executor.mcp.stream.held": held,
                        "executor.mcp.stream.open_ms": closed - opened,
                        "executor.mcp.stream.outcome": Exit.isSuccess(exit)
                          ? "completed"
                          : Cause.hasInterruptsOnly(exit.cause)
                            ? "interrupted"
                            : "failed",
                        "executor.mcp.stream.request_aborted": native.signal.aborted,
                        ...(Exit.isFailure(exit)
                          ? {
                              "executor.mcp.stream.failure": providerFailureCode(
                                Cause.squash(exit.cause),
                              ),
                            }
                          : {}),
                      },
                    }),
                    Effect.withParentSpan(requestSpan),
                  ),
                ),
              ),
            ),
          ),
          body.contentType,
          body.contentLength,
        ),
      );
    });
