/** Restart the runner-owned product through its loopback-only test control plane. */
import { Config, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Target } from "./platform.ts";
import { Evidence } from "./evidence.ts";

/** Control calls never touch a shared developer preview or production service. */
export const serverControl = (
  action: "start" | "stop" | "restart",
  expectedStatus: 200 | 500 = 200,
) =>
  Effect.gen(function* () {
    const target = yield* Target,
      client = yield* HttpClient.HttpClient,
      evidence = yield* Evidence;
    const origin = yield* Config.String("EXECUTOR_E2E_CONTROL_ORIGIN").pipe(
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
          const response = yield* client.execute(
            HttpClientRequest.post(`${origin}/${action}`).pipe(
              HttpClientRequest.bearerToken(target.apiKey),
            ),
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
