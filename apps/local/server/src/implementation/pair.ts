/** `executor pair`: a client of the running server that reads keys and writes nothing. */
import { connect } from "node:net";
import { Console, Effect, Redacted, Schema } from "effect";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { LocalAuthApi } from "../contracts/auth.ts";
import { serverPortConfig } from "../contracts/config.ts";
import { PairFailed } from "../contracts/startup.ts";
import { LocalConfigurationError, savedApiKey } from "./bootstrap.ts";

/**
 * Whether a TCP connection to the port is refused, which is the only sign that nothing listens on
 * it. Fetch cannot tell: Bun's, which the release executable runs, reports every failed connect as
 * `ConnectionRefused`, including a connection the peer accepted and reset before Bun saw it
 * complete, as happens on Windows. A plain socket keeps the operating system's error under Node
 * and Bun alike.
 */
const connectionRefused = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (refused: boolean) => {
      socket.destroy();
      resume(Effect.succeed(refused));
    };
    socket.once("connect", () => settle(false));
    socket.once("error", (error) => settle(refusedCode(error)));
    return Effect.sync(() => socket.destroy());
  });
const refusedCode = Schema.is(Schema.Struct({ code: Schema.Literal("ECONNREFUSED") }));
/** A running Executor server answers at once, so a listener that stays silent is something else. */
const answerWithin = "10 seconds";

/** Print a one-use connection link from the server on EXECUTOR_PORT, sent the directory's key. */
export const pair = (platform: string) =>
  Effect.gen(function* () {
    const port = yield* serverPortConfig.pipe(
      Effect.mapError(
        () =>
          new LocalConfigurationError({
            reason: "misconfigured",
            message:
              "EXECUTOR_PORT must be a port number from 1 to 65535: the port the running server listens on. Nothing was changed.",
          }),
      ),
    );
    const { directory, apiKey, keys } = yield* savedApiKey(platform);
    const failed = (reason: PairFailed["reason"]) =>
      Effect.fail(new PairFailed({ reason, port, directory, keys }));
    const client = yield* HttpApiClient.make(LocalAuthApi, {
      baseUrl: `http://127.0.0.1:${port}`,
      transformClient: (client) =>
        client.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(apiKey))),
    });
    const link = yield* client.auth.pair().pipe(
      Effect.timeout(answerWithin),
      Effect.catchTags({
        PairingUnauthorized: () => failed("key-rejected"),
        AuthStorageError: () => failed("storage-unavailable"),
        HttpClientError: (error) =>
          error.reason instanceof HttpClientError.TransportError
            ? connectionRefused(port).pipe(
                Effect.timeout(answerWithin),
                Effect.catchTag("TimeoutError", () => Effect.succeed(false)),
                Effect.flatMap((refused) => failed(refused ? "no-server" : "unexpected-response")),
              )
            : failed("unexpected-response"),
        AuthForbidden: () => failed("unexpected-response"),
        SchemaError: () => failed("unexpected-response"),
        TimeoutError: () => failed("unexpected-response"),
      }),
    );
    yield* Console.log(Redacted.value(link.url));
  }).pipe(
    // Node's fetch throws outside the request when it writes to a connection the peer has reset
    // on macOS (setTypeOfService EINVAL), which ends the process; node:http reports it as an error.
    Effect.provide(NodeHttpClient.layerNodeHttp),
  );
