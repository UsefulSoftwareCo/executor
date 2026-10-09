/**
 * A fake credentials store on loopback, for scenarios that set `EXECUTOR_CREDENTIAL_ADAPTER_URL`.
 * It is not a secure store: its sealed bytes are plain JSON. It keeps each OAuth grant's refresh
 * token and client secret in memory and seals placeholders in their place, then renews and
 * revokes with the real values itself, as a store that keeps its keys elsewhere would.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

/** What the host posts to every route. `fields` only to `/encrypt`, `bytes` to the others. */
const Request = Schema.Struct({
  identity: Schema.String,
  fields: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  bytes: Schema.optional(Schema.String),
});
type Json = typeof Schema.Json.Type;
type Fields = { readonly [key: string]: Json };

/** RFC 6749 §5.2 codes the host records; any other code is sent as an error body without one. */
const providerErrors = new Set([
  "invalid_grant",
  "invalid_client",
  "invalid_request",
  "invalid_scope",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_redirect_uri",
  "invalid_client_metadata",
  "access_denied",
  "unsupported_response_type",
  "server_error",
  "temporarily_unavailable",
]);
/** The refusal reason a token endpoint's error code gives, as the host's own transport reads it. */
const errorReason = (error: string) =>
  error === "invalid_grant"
    ? "invalid_grant"
    : error === "invalid_client" ||
        error === "incorrect_client_credentials" ||
        error === "invalid_client_id" ||
        error.startsWith("invalid_client:")
      ? "invalid_client"
      : "request";

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringOf = (record: Fields, key: string) => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};
/** RFC 6749 §2.3.1: form-encode each part before HTTP Basic. */
const formEncode = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");

export const credentialAdapter = Effect.gen(function* () {
  /** Real secrets by placeholder. */
  const secrets = new Map<string, string>();
  let renewal: "unavailable" | undefined;
  let reseal: "unavailable" | undefined;
  let lifetime: "text" | undefined;
  /** The bytes the latest renewal sealed. */
  let renewedBytes: string | undefined;
  const metrics = {
    encrypts: 0,
    decrypts: 0,
    renewals: 0,
    revocations: 0,
    identities: new Set<string>(),
  };

  /** A placeholder for `value`; one this store issued stays as it is. */
  const handle = (value: Json | undefined): Json => {
    if (typeof value !== "string" || value === "" || secrets.has(value)) return value ?? null;
    const placeholder = `handle_${randomUUID()}`;
    secrets.set(placeholder, value);
    return placeholder;
  };
  /**
   * Only an OAuth grant hides its secrets: an account identity whose record has `server`,
   * `client`, `fields` and `response`. The account's fields under the same identity, sign-in
   * attempts (`oauth_`) and saved clients (`client_`) keep their real values, because the host
   * still signs in with them.
   */
  const isGrant = (identity: string, record: Fields) =>
    identity.startsWith("acc_") &&
    "server" in record &&
    "client" in record &&
    "fields" in record &&
    "response" in record;
  const seal = (identity: string, record: Fields) => {
    const client = record["client"];
    const sealed: Fields = isGrant(identity, record)
      ? {
          ...record,
          ...("refreshToken" in record ? { refreshToken: handle(record["refreshToken"]) } : {}),
          ...(isRecord(client) && "client_secret" in client
            ? { client: { ...client, client_secret: handle(client["client_secret"]) } }
            : {}),
        }
      : record;
    return Buffer.from(JSON.stringify({ v: 1, identity, record: sealed })).toString("base64");
  };
  /** The sealed record, or undefined when the bytes are not this store's or not this identity's. */
  const open = (identity: string, bytes: string | undefined) => {
    if (bytes === undefined) return undefined;
    try {
      const envelope: unknown = JSON.parse(Buffer.from(bytes, "base64").toString("utf8"));
      return isRecord(envelope) &&
        envelope["v"] === 1 &&
        envelope["identity"] === identity &&
        isRecord(envelope["record"])
        ? envelope["record"]
        : undefined;
    } catch {
      return undefined;
    }
  };
  const reveal = (value: Json | undefined) =>
    typeof value === "string" ? (secrets.get(value) ?? value) : undefined;

  /** A token or revocation request with the grant's own client authentication and format. */
  const post = (
    url: string,
    grant: Fields,
    parameters: ReadonlyArray<readonly [string, string]>,
    format: "form" | "json",
  ) =>
    Effect.gen(function* () {
      const client = isRecord(grant["client"]) ? grant["client"] : {};
      const clientId = stringOf(client, "client_id") ?? "";
      const secret = reveal(client["client_secret"]);
      const method = stringOf(client, "token_endpoint_auth_method");
      const body = new URLSearchParams(parameters.map(([key, value]) => [key, value]));
      let authorization: string | undefined;
      if (method === "client_secret_basic" || method === "client_secret_basic_raw") {
        const encode = method === "client_secret_basic" ? formEncode : (value: string) => value;
        authorization = `Basic ${Buffer.from(`${encode(clientId)}:${encode(secret ?? "")}`).toString("base64")}`;
      } else {
        body.set("client_id", clientId);
        if (method === "client_secret_post" && secret !== undefined)
          body.set("client_secret", secret);
      }
      const request = HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeaders({
          accept: "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        }),
        HttpClientRequest.bodyText(
          format === "json" ? JSON.stringify(Object.fromEntries(body)) : body.toString(),
          format === "json" ? "application/json" : "application/x-www-form-urlencoded",
        ),
      );
      const response = yield* HttpClient.execute(request);
      return {
        status: response.status,
        retryAfter: response.headers["retry-after"],
        challenge: response.headers["www-authenticate"],
        text: yield* response.text,
      };
    }).pipe(
      Effect.scoped,
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provide(FetchHttpClient.layer),
      Effect.option,
    );

  /** The RFC 6749 refresh or client credentials request, answered as the host's contract asks. */
  const renew = (identity: string, grant: Fields) =>
    Effect.gen(function* () {
      const server = isRecord(grant["server"]) ? grant["server"] : {};
      const endpoint = stringOf(server, "token_endpoint");
      const resource = stringOf(grant, "resource");
      const scopes = grant["scopes"];
      const separator = stringOf(grant, "scopeSeparator") ?? " ";
      const refreshToken = reveal(grant["refreshToken"]);
      const parameters: Array<readonly [string, string]> =
        grant["grant"] === "client_credentials"
          ? [
              ["grant_type", "client_credentials"],
              ...(Array.isArray(scopes) && scopes.length > 0
                ? [["scope", scopes.join(separator)] as const]
                : []),
            ]
          : refreshToken === undefined
            ? []
            : [
                ["grant_type", "refresh_token"],
                ["refresh_token", refreshToken],
              ];
      if (endpoint === undefined || parameters.length === 0)
        return HttpServerResponse.jsonUnsafe({ reason: "invalid_response" }, { status: 422 });
      const answer = yield* post(
        endpoint,
        grant,
        [...parameters, ...(resource === undefined ? [] : [["resource", resource] as const])],
        grant["tokenRequestFormat"] === "json" ? "json" : "form",
      );
      if (answer._tag === "None")
        return HttpServerResponse.jsonUnsafe({ reason: "request" }, { status: 422 });
      const { status, text } = answer.value;
      const retryAfter =
        status === 429 && Number.isFinite(Number(answer.value.retryAfter))
          ? new Date(Date.now() + Number(answer.value.retryAfter) * 1000).toISOString()
          : undefined;
      const parsed: unknown = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return undefined;
        }
      })();
      const error = isRecord(parsed) ? stringOf(parsed, "error") : undefined;
      const accessToken = isRecord(parsed) ? stringOf(parsed, "access_token") : undefined;
      if (status === 200 && error === undefined && isRecord(parsed) && accessToken !== undefined) {
        const rotated = stringOf(parsed, "refresh_token");
        const renewed = rotated === undefined ? grant : { ...grant, refreshToken: rotated };
        const tokens = Object.fromEntries(
          Object.entries(parsed)
            .filter(([key]) => key !== "refresh_token" && key !== "id_token")
            .map(([key, value]) =>
              key === "expires_in" && lifetime === "text" ? [key, String(value)] : [key, value],
            ),
        );
        renewedBytes = seal(identity, renewed);
        return HttpServerResponse.jsonUnsafe({ tokens, bytes: renewedBytes });
      }
      const challenge = status === 401 && answer.value.challenge !== undefined;
      return HttpServerResponse.jsonUnsafe(
        {
          reason:
            error === undefined ? (challenge ? "request" : "invalid_response") : errorReason(error),
          status,
          ...(error !== undefined && providerErrors.has(error) ? { providerError: error } : {}),
          ...(error !== undefined
            ? { answer: "error_body" }
            : challenge
              ? { answer: "challenge" }
              : {}),
          ...(retryAfter === undefined ? {} : { retryAfter }),
        },
        { status: 422 },
      );
    });

  /** RFC 7009 with the real refresh token, or the access token when there is none. */
  const revoke = (grant: Fields) =>
    Effect.gen(function* () {
      const server = isRecord(grant["server"]) ? grant["server"] : {};
      const endpoint = stringOf(server, "revocation_endpoint");
      if (endpoint === undefined) return "unsupported" as const;
      const fields = isRecord(grant["fields"]) ? grant["fields"] : {};
      const refreshToken =
        grant["grant"] === "client_credentials" ? undefined : reveal(grant["refreshToken"]);
      const accessToken = stringOf(fields, "access_token");
      const token =
        refreshToken !== undefined
          ? ([refreshToken, "refresh_token"] as const)
          : accessToken !== undefined && accessToken !== ""
            ? ([accessToken, "access_token"] as const)
            : undefined;
      if (token === undefined) return "no_token" as const;
      const answer = yield* post(
        endpoint,
        grant,
        [
          ["token", token[0]],
          ["token_type_hint", token[1]],
        ],
        "form",
      );
      return answer._tag === "Some" && answer.value.status >= 200 && answer.value.status < 300
        ? ("revoked" as const)
        : ("failed" as const);
    });

  /** Read the host's request; a body this store did not seal for that identity is a 400. */
  const route = (
    path: "/encrypt" | "/decrypt" | "/renew" | "/revoke",
    respond: (
      input: typeof Request.Type,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, never>,
  ) =>
    HttpRouter.add(
      "POST",
      path,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Request)),
          Effect.option,
        );
        if (input._tag === "None") return HttpServerResponse.empty({ status: 400 });
        metrics.identities.add(input.value.identity);
        return yield* respond(input.value);
      }),
    );
  const sealed = (input: typeof Request.Type) => open(input.identity, input.bytes);
  const refused = HttpServerResponse.empty({ status: 400 });
  const routes = Layer.mergeAll(
    route("/encrypt", (input) =>
      Effect.sync(() => {
        metrics.encrypts++;
        return input.fields === undefined
          ? refused
          : HttpServerResponse.jsonUnsafe({ bytes: seal(input.identity, input.fields) });
      }),
    ),
    route("/decrypt", (input) =>
      Effect.sync(() => {
        metrics.decrypts++;
        if (reseal === "unavailable" && input.bytes === renewedBytes) {
          reseal = undefined;
          return HttpServerResponse.empty({ status: 503 });
        }
        const record = sealed(input);
        return record === undefined ? refused : HttpServerResponse.jsonUnsafe({ fields: record });
      }),
    ),
    route("/renew", (input) =>
      Effect.suspend(() => {
        // An outage answers before any renewal is attempted, so it is not counted as one.
        if (renewal === "unavailable")
          return Effect.succeed(HttpServerResponse.empty({ status: 503 }));
        metrics.renewals++;
        const record = sealed(input);
        return record === undefined || !isGrant(input.identity, record)
          ? Effect.succeed(refused)
          : renew(input.identity, record);
      }),
    ),
    route("/revoke", (input) =>
      Effect.suspend(() => {
        metrics.revocations++;
        const record = sealed(input);
        return record === undefined || !isGrant(input.identity, record)
          ? Effect.succeed(refused)
          : revoke(record).pipe(
              Effect.map((outcome) => HttpServerResponse.jsonUnsafe({ outcome })),
            );
      }),
    ),
  );
  const listener = yield* Effect.sync(() => createServer());
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(() => listener, { host: "127.0.0.1", port: 0 })),
    ),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => listener.closeAllConnections()));
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Adapter fixture needs a TCP listener");
  return {
    origin: `http://127.0.0.1:${server.address.port}`,
    /**
     * `renew: "unavailable"` answers every renewal with 503, as an adapter outage would.
     * `reseal: "unavailable"` answers 503 once, to the host's decrypt of the bytes the next renewal
     * sealed, as an outage right after the service rotated the token would.
     * `expiresIn: "text"` passes the service's `expires_in` on as a numeric string, as some
     * services send it.
     */
    configure: (input: {
      readonly renew?: "unavailable" | null;
      readonly reseal?: "unavailable" | null;
      readonly expiresIn?: "text" | null;
    }) =>
      Effect.sync(() => {
        if (input.renew !== undefined) renewal = input.renew === null ? undefined : input.renew;
        if (input.reseal !== undefined) reseal = input.reseal === null ? undefined : input.reseal;
        if (input.expiresIn !== undefined)
          lifetime = input.expiresIn === null ? undefined : input.expiresIn;
      }),
    metrics: Effect.sync(() => ({
      encrypts: metrics.encrypts,
      decrypts: metrics.decrypts,
      renewals: metrics.renewals,
      revocations: metrics.revocations,
      identities: [...metrics.identities],
    })),
  };
});
