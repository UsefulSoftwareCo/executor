import { Cause, Effect, Exit, Stream } from "effect";
import { HttpBody, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { providerFailureCode } from "./provider-failure.ts";

/** Record which side closes an MCP stream without retaining frames, headers or error messages. */
export const observeMcpStream =
  (phase: "gateway" | "session") => (response: HttpServerResponse.HttpServerResponse) =>
    Effect.gen(function* () {
      const body = response.body;
      if (!(body instanceof HttpBody.Stream)) return response;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const native = yield* HttpServerRequest.toWeb(request);
      const requestSpan = yield* Effect.currentSpan.pipe(Effect.orDie);
      return HttpServerResponse.setBody(
        response,
        HttpBody.stream(
          body.stream.pipe(
            Stream.onExit((exit) =>
              Effect.void.pipe(
                Effect.withSpan("mcp.stream.close", {
                  attributes: {
                    "executor.mcp.stream.phase": phase,
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
          body.contentType,
          body.contentLength,
        ),
      );
    });
