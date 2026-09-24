/** Restart the runner-owned product through its loopback-only test control plane. */
import { Config, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Target } from "./platform.ts";
import { Evidence } from "./evidence.ts";

/** Control calls never touch a shared developer preview or production service. */
export const serverControl = (
  action: "start" | "stop" | "restart" | "clock/advance",
  expectedStatus: 200 | 500 = 200,
  body?: { readonly milliseconds: number },
) =>
  Effect.gen(function* () {
    const target = yield* Target,
      client = yield* HttpClient.HttpClient,
      evidence = yield* Evidence;
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
    yield* evidence.step(
      `Product process ${action}`,
      Effect.scoped(
        Effect.gen(function* () {
          const request = HttpClientRequest.post(`${origin}/${action}`).pipe(
            HttpClientRequest.bearerToken(target.apiKey),
          );
          const response = yield* client.execute(
            body === undefined ? request : yield* HttpClientRequest.bodyJson(request, body),
          );
          if (response.status !== expectedStatus)
            return yield* Effect.die(
              `Product process ${action} returned ${response.status}, expected ${expectedStatus}`,
            );
          yield* response.text;
        }),
      ),
    );
  });
