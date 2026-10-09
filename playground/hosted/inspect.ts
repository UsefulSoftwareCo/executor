/** Run the same schema-checked client against either hosted runtime. */
import { HostedApi } from "@executor-js/hosted-server/contracts";
import { Config, Console, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

await Effect.runPromise(
  Effect.gen(function* () {
    const baseUrl = yield* Config.String("HOSTED_URL");
    const client = yield* HttpApiClient.make(HostedApi, { baseUrl });
    const health = yield* client.health.get();
    const protectedRead = yield* client.catalog.list().pipe(
      Effect.as("authorized"),
      Effect.catchTag("Unauthorized", () => Effect.succeed("sign-in required")),
    );
    yield* Console.log({ url: baseUrl, health, catalog: protectedRead });
  }).pipe(Effect.timeout("40 seconds"), Effect.provide(FetchHttpClient.layer)),
);
