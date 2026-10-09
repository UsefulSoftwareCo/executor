import { Cause, Clock, Effect, Exit, Stream } from "effect";
import { HttpBody, HttpServerRequest, HttpServerResponse } from "effect/http";
import { providerFailureCode } from "./provider-failure.ts";

/**
 * Tells the gateway that the session object is holding the response open. Every body the
 * gateway forwards is a stream, but only a session response with a stream body stays open after
 * its answer (`subscriptions/listen`); the others are buffered. The gateway removes the header.
 */
const heldHeader = "x-executor-session-stream";

/**
 * Record which side closes an MCP stream without retaining frames, headers or error messages.
 * The request span says whether its response is held open, so its duration (until the response
 * starts) is request/response latency for every MCP method. The close records how long the body
 * stayed open after that: a held stream's lifetime, or a buffered body's transfer.
 */
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
                        // Both readings follow I/O (the response starting, the body ending), so
                        // the I/O clock is current at each.
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
