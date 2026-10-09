/** Restart the runner-owned product through its loopback-only test control plane. */
import { Config, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Target } from "./platform.ts";
import { Evidence } from "./evidence.ts";
import type { OperatorSettings } from "./managed-server.ts";

/** Control calls never touch a shared developer preview or production service. */
export const controlRequest = (path: string, expectedStatus: number, body?: unknown) =>
  Effect.gen(function* () {
    const target = yield* Target,
      client = yield* HttpClient.HttpClient;
    const origin = yield* (
      target.controlOrigin === undefined
        ? Config.String("EXECUTOR_E2E_CONTROL_ORIGIN")
        : Effect.succeed(target.controlOrigin)
    ).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.String.check(
            Schema.makeFilter((text) => {
              const url = URL.parse(text);
              return (
                url !== null &&
                url.origin === text &&
                url.hostname === "127.0.0.1" &&
                url.protocol === "http:"
              );
            }),
          ),
        ),
      ),
    );
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const request = HttpClientRequest.post(`${origin}/${path}`).pipe(
          HttpClientRequest.bearerToken(target.apiKey),
        );
        const response = yield* client.execute(
          body === undefined ? request : yield* HttpClientRequest.bodyJson(request, body),
        );
        const text = yield* response.text;
        // Control responses carry no credentials; a failed fixture explains itself.
        if (response.status !== expectedStatus)
          return yield* Effect.die(
            `Product control ${path} returned ${response.status}, expected ${expectedStatus}${text === "" ? "" : `: ${text.slice(0, 500)}`}`,
          );
        return text;
      }),
    );
  });

/**
 * Stop, start, restart or kill the product, advance its stopped clock, set its data-step mode or
 * turn on an operator setting for its next start.
 */
export const serverControl = (
  action: "start" | "stop" | "restart" | "kill" | "clock/advance" | "data-steps" | "environment",
  expectedStatus: 200 | 500 = 200,
  body?:
    | { readonly milliseconds: number }
    | { readonly mode: "report" | "apply" }
    | typeof OperatorSettings.Type,
) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    yield* evidence.step(
      `Product process ${action}`,
      controlRequest(action, expectedStatus, body).pipe(Effect.asVoid),
    );
  });
