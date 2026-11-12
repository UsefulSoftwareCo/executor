/** `executor service pair`: a client of the running server that reads keys and writes nothing. */
import { Config, Console, Effect, Option, Redacted, Schedule } from "effect";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { LocalAuthApi } from "../contracts/auth.ts";
import { serverPortConfig } from "../contracts/config.ts";
import { PairFailed } from "../contracts/startup.ts";
import { LocalConfigurationError } from "./bootstrap.ts";
import { registered } from "./service-client.ts";
import { connectionRefused, serviceDirectory } from "./service-files.ts";

/** A running Executor server answers at once, so a listener that stays silent is something else. */
const answerWithin = "10 seconds";

/** Where a connection link is requested, with the credential the server accepts as its API key. */
export interface PairingTarget {
  readonly url: string;
  readonly credential: Redacted.Redacted<string>;
  /** The data directory the credential came from, for messages. */
  readonly directory: string;
  readonly keys: PairFailed["keys"];
  /** For a server this CLI started or found registered: the only origins its links may use. */
  readonly origins?: ReadonlyArray<string>;
}

/**
 * The origins a connection link from this CLI's own server may use: its loopback URL's, and its
 * browser origin when that is an HTTPS origin.
 */
export const serverOrigins = (url: string, browserOrigin: string | undefined) => {
  const secure =
    browserOrigin !== undefined &&
    URL.canParse(browserOrigin) &&
    new URL(browserOrigin).protocol === "https:" &&
    new URL(browserOrigin).origin === browserOrigin;
  return [new URL(url).origin, ...(secure ? [browserOrigin] : [])];
};

/**
 * Whether the CLI may print and open `link`: an http(s) URL without credentials in it, on one of
 * `origins` when they are given. A browser opener starts whatever a link names, such as a file.
 */
const openable = (link: Redacted.Redacted<string>, origins: ReadonlyArray<string> | undefined) => {
  const text = Redacted.value(link);
  if (!URL.canParse(text)) return false;
  const url = new URL(text);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    (origins === undefined || origins.includes(url.origin))
  );
};

/**
 * A one-use connection link from `target`, or the PairFailed that says what to correct. The
 * request carries no Origin header: the API key, not a browser session, authorizes it. A link the
 * CLI may not open counts as an unexpected response.
 */
export const pairingLink = (target: PairingTarget) =>
  Effect.gen(function* () {
    const url = new URL(target.url);
    const failed = (reason: PairFailed["reason"]) =>
      Effect.fail(
        new PairFailed({
          reason,
          server: url.host,
          directory: target.directory,
          keys: target.keys,
        }),
      );
    const client = yield* HttpApiClient.make(LocalAuthApi, {
      baseUrl: target.url,
      transformClient: (client) =>
        client.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(target.credential))),
    });
    return yield* client.auth.pair().pipe(
      Effect.timeout(answerWithin),
      Effect.catchTags({
        PairingUnauthorized: () => failed("key-rejected"),
        AuthStorageError: () => failed("storage-unavailable"),
        HttpClientError: (error) =>
          error.reason instanceof HttpClientError.TransportError
            ? connectionRefused(url).pipe(
                Effect.timeout(answerWithin),
                Effect.catchTag("TimeoutError", () => Effect.succeed(false)),
                Effect.flatMap((refused) => failed(refused ? "no-server" : "unexpected-response")),
              )
            : failed("unexpected-response"),
        AuthForbidden: () => failed("unexpected-response"),
        SchemaError: () => failed("unexpected-response"),
        TimeoutError: () => failed("unexpected-response"),
      }),
      Effect.filterOrElse(
        (link) => openable(link.url, target.origins),
        () => failed("unexpected-response"),
      ),
    );
  }).pipe(
    // Node's fetch throws outside the request when it writes to a connection the peer has reset
    // on macOS (setTypeOfService EINVAL), which ends the process; node:http reports it as an error.
    Effect.provide(NodeHttpClient.layerNodeHttp),
  );

/** The loopback address on EXECUTOR_PORT, for a supplied key when no server is registered. */
const portUrl = serverPortConfig.pipe(
  Effect.map((port) => `http://127.0.0.1:${port}`),
  Effect.mapError(
    () =>
      new LocalConfigurationError({
        reason: "misconfigured",
        message:
          "EXECUTOR_PORT must be a port number from 1 to 65535: the port the running server listens on. Nothing was changed.",
      }),
  ),
);

/** How long `executor service pair` waits for a registered server that is not ready. */
const startingWait = "30 seconds";

/**
 * Print a one-use connection link from the background server, sent the password it registered.
 * A supplied EXECUTOR_API_KEY is sent instead, to the registered server or else to EXECUTOR_PORT.
 * A registered server that is still starting or stopping, or holds the data directory without
 * answering, is waited for, up to 30 seconds.
 */
export const pair = Effect.gen(function* () {
  const directory = yield* serviceDirectory;
  const supplied = yield* Config.Redacted("EXECUTOR_API_KEY").pipe(Config.option);
  const found = yield* registered(directory).pipe(
    Effect.repeat({
      while: (found) => Option.isSome(found) && found.value.status !== "ready",
      schedule: Schedule.spaced("250 millis").pipe(Schedule.upTo({ duration: startingWait })),
    }),
  );
  if (Option.isSome(found) && found.value.status !== "ready")
    return yield* new PairFailed({
      reason: found.value.status,
      server: new URL(found.value.url).host,
      directory,
      keys: Option.isSome(supplied) ? "supplied" : "registered",
    });
  const service = Option.map(found, ({ status: _status, ...running }) => running);
  const origins = Option.map(service, ({ url, browserOrigin }) =>
    serverOrigins(url, browserOrigin),
  );
  const target: PairingTarget = Option.isSome(supplied)
    ? {
        url: Option.isSome(service) ? service.value.url : yield* portUrl,
        credential: supplied.value,
        directory,
        keys: "supplied",
        ...(Option.isSome(origins) ? { origins: origins.value } : {}),
      }
    : Option.isSome(service)
      ? {
          url: service.value.url,
          credential: service.value.password,
          directory,
          keys: "registered",
          ...(Option.isSome(origins) ? { origins: origins.value } : {}),
        }
      : yield* new PairFailed({ reason: "no-server", directory, keys: "registered" });
  const link = yield* pairingLink(target);
  yield* Console.log(Redacted.value(link.url));
});
