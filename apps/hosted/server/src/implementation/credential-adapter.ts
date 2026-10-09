/**
 * A credentials store reached over HTTP. The adapter owns encryption, key custody, OAuth renewal
 * and revocation; the host sends it only identities and sealed bytes, and never logs a body.
 */
import { parseDestination, type HostEgress } from "@executor-js/utils/url-policy";
import {
  CredentialsError,
  CredentialsRenewalRefused,
  JsonObject,
  type Credentials,
} from "@executor-js/sdk/core";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { CredentialAdapterUrlInvalid } from "../contracts/credential-adapter.ts";

/**
 * `EXECUTOR_CREDENTIAL_ADAPTER_URL`, checked at startup. Unset, the host encrypts with
 * `EXECUTOR_ENCRYPTION_KEY`. The adapter authenticates the host itself, by mTLS or network policy.
 * Every request also passes the connect-time address check, so an adapter on a private network
 * needs its exact HTTP origin in `EXECUTOR_URL_ALLOW_HTTP_ORIGINS`.
 */
export const credentialAdapterSetting = (egress: HostEgress) =>
  Config.String("EXECUTOR_CREDENTIAL_ADAPTER_URL").pipe(
    Config.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<URL>()),
        onSome: (value) => {
          const url = parseDestination(value, egress.policy);
          // Routes are joined to the path, so a query would be dropped from every request.
          return url === undefined || url.search !== ""
            ? Effect.fail(
                new CredentialAdapterUrlInvalid({
                  message:
                    "EXECUTOR_CREDENTIAL_ADAPTER_URL must be an HTTPS URL, or an HTTP URL this host allows (loopback, or an origin in EXECUTOR_URL_ALLOW_HTTP_ORIGINS), with no credentials, query or fragment. An adapter on a private or internal host needs its exact HTTP origin in EXECUTOR_URL_ALLOW_HTTP_ORIGINS.",
                }),
              )
            : Effect.succeed(Option.some(url));
        },
      }),
    ),
  );

const Sealed = Schema.Struct({ bytes: Schema.String });
const Opened = Schema.Struct({ fields: JsonObject });
const Renewed = Schema.Struct({ tokens: JsonObject, bytes: Schema.String });
const Refused = Schema.toCodecJson(CredentialsRenewalRefused);
const Revoked = Schema.Struct({
  outcome: Schema.Literals(["revoked", "unsupported", "no_token", "failed"]),
});

const bytesOf = (value: string) =>
  Effect.fromResult(Base64.decode(value)).pipe(Effect.mapError(() => new CredentialsError()));

/**
 * `POST {url}/encrypt|decrypt|renew|revoke` with JSON bodies; bytes travel as base64. Any
 * transport failure, unexpected status or undecodable body is a `CredentialsError`. `/renew`
 * answers 422 with the refusal's fields when the service refused the renewal. The host waits 30
 * seconds for each answer, so `/renew` must give the service a shorter deadline of its own.
 */
export const httpCredentialAdapter = (url: URL, egress: HostEgress): Credentials => {
  const post = (route: string, body: object) =>
    Effect.gen(function* () {
      // The request belongs to this scope: closing it aborts a body nobody reads.
      const response = yield* HttpClient.withScope(egress.client).execute(
        HttpClientRequest.post(
          new URL(`${url.pathname.replace(/\/$/, "")}/${route}`, url).href,
        ).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
      );
      yield* Effect.annotateCurrentSpan("http.response.status_code", response.status);
      return { status: response.status, json: yield* response.json };
    }).pipe(
      Effect.scoped,
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeout("30 seconds"),
      Effect.mapError(() => new CredentialsError()),
    );
  const read = <A>(schema: Schema.Decoder<A>, answer: { status: number; json: unknown }) =>
    answer.status === 200
      ? Schema.decodeUnknownEffect(schema)(answer.json).pipe(
          Effect.mapError(() => new CredentialsError()),
        )
      : Effect.fail(new CredentialsError());
  return {
    encrypt: (identity, fields) =>
      post("encrypt", { identity, fields: Redacted.value(fields) }).pipe(
        Effect.flatMap((answer) => read(Sealed, answer)),
        Effect.flatMap(({ bytes }) => bytesOf(bytes)),
        Effect.withSpan("sdk.credentials.encrypt"),
      ),
    decrypt: (identity, bytes) =>
      post("decrypt", { identity, bytes: Base64.encode(Redacted.value(bytes)) }).pipe(
        Effect.flatMap((answer) => read(Opened, answer)),
        Effect.map(({ fields }) => Redacted.make(fields)),
        Effect.withSpan("sdk.credentials.decrypt"),
      ),
    renew: (identity, sealed) =>
      post("renew", { identity, bytes: Base64.encode(Redacted.value(sealed)) }).pipe(
        Effect.flatMap((answer) =>
          answer.status === 422
            ? Schema.decodeUnknownEffect(Refused)({
                ...(typeof answer.json === "object" ? answer.json : {}),
                _tag: "CredentialsRenewalRefused",
              }).pipe(
                Effect.mapError(() => new CredentialsError()),
                Effect.flatMap(Effect.fail),
              )
            : read(Renewed, answer),
        ),
        Effect.flatMap(({ tokens, bytes }) =>
          bytesOf(bytes).pipe(Effect.map((sealed) => ({ tokens: Redacted.make(tokens), sealed }))),
        ),
        Effect.withSpan("sdk.credentials.renew"),
      ),
    revoke: (identity, sealed) =>
      post("revoke", { identity, bytes: Base64.encode(Redacted.value(sealed)) }).pipe(
        Effect.flatMap((answer) => read(Revoked, answer)),
        Effect.map(({ outcome }) => outcome),
        Effect.withSpan("sdk.credentials.revoke"),
      ),
  };
};
