import { AsyncLocalStorage } from "node:async_hooks";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { Clock, Effect, Exit, Option, Schema } from "effect";
import { HttpServerRequest, type HttpServerResponse } from "effect/http";

const KnownError = Schema.Literals([
  "access_denied",
  "state_not_found",
  "state_mismatch",
  "state_expired",
  "invalid_callback_request",
  "no_code",
  "oauth_provider_not_found",
  "issuer_missing",
  "issuer_mismatch",
  "nonce_binding_missing",
  "invalid_code",
  "unable_to_get_user_info",
  "no_callback_url",
  "unable_to_link_account",
  "account_not_linked",
  "email_does_not_match",
  "account_already_linked_to_different_user",
  "email_not_found",
  "email_not_verified",
  "unable_to_create_user",
  "unable_to_create_session",
  "signup_disabled",
]);
/** Grant types a client may name; Executor serves authorization codes and refresh tokens. */
const GrantType = Schema.Literals(["authorization_code", "refresh_token", "client_credentials"]);
/** RFC 6749 token errors, and RFC 8707's for a resource the grant does not cover. */
const TokenError = Schema.Literals([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "invalid_target",
]);
const TokenErrorBody = Schema.fromJsonString(Schema.Struct({ error: Schema.String }));
const JsonTokenRequest = Schema.fromJsonString(Schema.Struct({ grant_type: Schema.String }));
/** Token requests are a few hundred bytes; a larger body is not read a second time. */
const tokenBodyLimit = 16_384;
const formType = "application/x-www-form-urlencoded";
/** better-call's test for a JSON body, applied before its form one. */
const jsonType = /^application\/([a-z0-9.+-]*\+)?json/i;
/**
 * A copy of the body Better Auth will parse, taken before it reads the original. None when it
 * would not parse one: its token endpoint answers any type but a form 415 without reading.
 */
const tokenBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    if (Number(request.headers["content-length"]) > tokenBodyLimit) return Option.none();
    const type = request.headers["content-type"]?.toLowerCase() ?? "";
    const essence = type.split(";")[0]!.trim();
    const json = jsonType.test(type);
    // `formData()` refuses any other form type.
    if (!essence.includes(formType) || (!json && essence !== formType)) return Option.none();
    const body = (yield* HttpServerRequest.toWeb(request)).clone().body;
    return body === null ? Option.none() : Option.some({ json, body });
  }).pipe(Effect.orElseSucceed(() => Option.none()));

/**
 * Read the copy as its bytes arrive, at most `tokenBodyLimit`, beside Better Auth's own read. A
 * promise rather than a fiber, so the read keeps pace with Better Auth's and its answer never
 * waits for it. `text` stays undefined until the whole copy is read.
 */
const readBody = (body: ReadableStream<Uint8Array>) => {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const read: { text: string | undefined; readonly cancel: () => void } = {
    text: undefined,
    cancel: () => void reader.cancel().catch(() => undefined),
  };
  const next = (): Promise<void> =>
    reader.read().then(({ done, value }) => {
      if (done) {
        const decoder = new TextDecoder();
        read.text =
          chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") +
          decoder.decode();
        return;
      }
      size += value.byteLength;
      if (size > tokenBodyLimit) return read.cancel();
      chunks.push(value);
      return next();
    });
  // A body the client stopped sending stays unread.
  next().catch(() => undefined);
  return read;
};

/** The grant type Better Auth reads from the body: the last value named, trimmed, case kept. */
const grantType = (json: boolean, text: string) => {
  const value = json
    ? Option.getOrUndefined(
        Option.map(Schema.decodeUnknownOption(JsonTokenRequest)(text), (body) => body.grant_type),
      )
    : new URLSearchParams(text).getAll("grant_type").at(-1);
  const trimmed = value?.trim() ?? "";
  // Better Auth answers an empty grant type as a missing one.
  if (trimmed === "") return "unknown";
  return Option.getOrElse(Schema.decodeUnknownOption(GrantType)(trimmed), () => "other" as const);
};

/** The `error` of the endpoint's own JSON answer when it is a known code; never its description. */
const tokenError = (response: HttpServerResponse.HttpServerResponse) => {
  if (response.status < 400) return "none";
  if (response.body._tag !== "Uint8Array") return "other";
  return Option.getOrElse(
    Option.flatMap(
      Schema.decodeUnknownOption(TokenErrorBody)(new TextDecoder().decode(response.body.body)),
      (body) => Schema.decodeUnknownOption(TokenError)(body.error),
    ),
    () => "other" as const,
  );
};

/**
 * The MCP client a registration names, from a closed set. Each pattern is matched, in order,
 * against the registration's `client_name` and then its `software_id`, ignoring case. Both are
 * self-declared, so this says what a client calls itself, never who it is.
 */
const clientFamilies = [
  ["executor-cli", /\bexecutor cli\b/iu],
  // "Claude Code (<server name>)".
  ["claude-code", /\bclaude[ -]?code\b/iu],
  ["claude-desktop", /\bclaude desktop\b/iu],
  // Claude's connectors register as "claudeai" for the web and desktop apps alike.
  ["claude-ai", /\bclaude(?:\.?ai)?\b/iu],
  ["codex", /\bcodex\b/iu],
  ["chatgpt", /\bchatgpt\b/iu],
  ["cursor", /\bcursor\b/iu],
  ["vscode", /\b(?:visual studio code|vs ?code)\b/iu],
  ["windsurf", /\b(?:windsurf|codeium)\b/iu],
] as const;
/** Callbacks only one client can receive, for a registration whose name says nothing known. */
const clientCallbacks = [
  ["claude-ai", /^https:\/\/(?:claude\.ai|claude\.com)\//iu],
  ["chatgpt", /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//iu],
  ["cursor", /^cursor:/iu],
  ["vscode", /^(?:https:\/\/(?:insiders\.)?vscode\.dev\/redirect|vscode(?:-insiders)?:)/iu],
] as const;
type ClientFamily = (typeof clientFamilies)[number][0] | "other" | "unknown";
const RegisteredClient = Schema.Struct({
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  softwareId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  redirectUris: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});
/** `unknown` when no registration was found; `other` for one that names no known client. */
const clientFamily = (row: unknown): ClientFamily => {
  const client = Schema.decodeUnknownOption(RegisteredClient)(row);
  if (Option.isNone(client)) return "unknown";
  const { name, softwareId, redirectUris } = client.value;
  for (const text of [name, softwareId]) {
    if (!text) continue;
    const found = clientFamilies.find(([, pattern]) => pattern.test(text));
    if (found !== undefined) return found[0];
  }
  const callback = clientCallbacks.find(([, pattern]) =>
    (redirectUris ?? []).some((uri) => pattern.test(uri)),
  );
  return callback === undefined ? "other" : callback[0];
};
const OAuthClientRequest = Schema.Struct({ client_id: Schema.NonEmptyString });
const ConsentRequest = Schema.Struct({ oauth_query: Schema.String });
/**
 * The client ID an OAuth request names, where Better Auth reads it: the token request's body or
 * Basic credentials, the authorization request's query or body, or the consent's signed query.
 */
const requestedClientId = (ctx: {
  readonly path?: string | undefined;
  readonly body?: unknown;
  readonly query?: unknown;
  readonly headers?: Headers | undefined;
}) => {
  const named = (value: unknown) =>
    Option.getOrUndefined(
      Option.map(Schema.decodeUnknownOption(OAuthClientRequest)(value), (body) => body.client_id),
    );
  if (ctx.path === "/oauth2/consent")
    return Option.getOrUndefined(
      Option.flatMap(Schema.decodeUnknownOption(ConsentRequest)(ctx.body), (body) =>
        Option.fromNullishOr(new URLSearchParams(body.oauth_query).get("client_id")),
      ),
    );
  const id = named(ctx.body) ?? named(ctx.query);
  if (id !== undefined || ctx.path !== "/oauth2/token") return id;
  const basic = /^basic\s+(\S+)$/iu.exec(ctx.headers?.get("authorization") ?? "");
  if (basic === null) return undefined;
  try {
    const user = atob(basic[1]!).split(":")[0]!;
    return user === "" ? undefined : decodeURIComponent(user);
  } catch {
    return undefined;
  }
};
const clientPaths = new Set(["/oauth2/token", "/oauth2/authorize", "/oauth2/consent"]);
interface OAuthRequest {
  familyRevoked: boolean;
  /** Set once the request's client registration has been read, found or not. */
  client: ClientFamily | undefined;
}

type Stage = "callback_validation" | "token_exchange" | "user_info" | "account_session";
interface Progress {
  stage: Stage;
  sessionCreated: boolean;
}
interface Observation {
  readonly provider: "github" | "google" | "other";
  readonly progress: Progress;
  readonly run: <A>(effect: Effect.Effect<A>) => Promise<A>;
}

/**
 * Observe social callbacks and OAuth token, authorization and consent requests without
 * exporting URLs, tokens, client IDs or names, provider payloads or thrown errors.
 */
export const authObservability = () => {
  const requests = new AsyncLocalStorage<Observation>();
  const oauthRequests = new AsyncLocalStorage<OAuthRequest>();
  /** Run an OAuth request, then record the family of the client it named. */
  const observeClient = <E, R>(
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    observed: OAuthRequest = { familyRevoked: false, client: undefined },
  ) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>();
      const exit = yield* Effect.promise((signal) =>
        oauthRequests.run(observed, () =>
          Effect.runPromiseExit(handler.pipe(Effect.provideContext(context)), { signal }),
        ),
      );
      yield* Effect.annotateCurrentSpan("auth.token.client_family", observed.client ?? "unknown");
      return exit;
    });
  /** Record the grant, the answer's OAuth error, rate limiting and any family revocation. */
  const observeToken = <E, R>(
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // Read the copy beside Better Auth, never before it: its rate limit answers without the
      // body, and telemetry must not delay that answer.
      const copy = Option.map(yield* tokenBody(request), ({ json, body }) => ({
        json,
        read: readBody(body),
      }));
      const span = yield* Effect.currentSpan.pipe(Effect.option);
      const observed: OAuthRequest = { familyRevoked: false, client: undefined };
      const exit = yield* observeClient(handler, observed);
      // A body still arriving when the answer is ready stays unknown.
      let grant: ReturnType<typeof grantType> = "unknown";
      if (Option.isSome(copy)) {
        const { json, read } = copy.value;
        if (read.text === undefined) read.cancel();
        else grant = grantType(json, read.text);
      }
      if (observed.familyRevoked && Option.isSome(span))
        span.value.event("auth.token.refresh_family_revoked", yield* Clock.currentTimeNanos);
      yield* Effect.annotateCurrentSpan({
        "auth.token.grant_type": grant,
        "auth.token.error": Exit.isSuccess(exit) ? tokenError(exit.value) : "other",
        "auth.token.rate_limited": Exit.isSuccess(exit) && exit.value.status === 429,
        "auth.token.refresh_family_revoked": observed.familyRevoked,
      });
      return yield* exit;
    });
  const stage = async <A>(name: Stage, task: () => Promise<A>, accepted: (value: A) => boolean) => {
    const observation = requests.getStore();
    if (observation === undefined) return task();
    observation.progress.stage = name;
    const result = await observation.run(
      Effect.gen(function* () {
        // Better Auth owns these Promise errors. Keep the original rejection for it,
        // but never let a provider payload become an Effect span's error cause.
        const result = yield* Effect.promise(() =>
          Promise.resolve()
            .then(task)
            .then(
              (value) => ({ ok: true as const, value }),
              (cause: unknown) => ({ ok: false as const, cause }),
            ),
        );
        yield* Effect.annotateCurrentSpan({
          "auth.provider": observation.provider,
          "auth.stage": name,
          "executor.outcome": result.ok && accepted(result.value) ? "success" : "failed",
        });
        return result;
      }).pipe(Effect.withSpan(`auth.oauth.${name}`)),
    );
    if (!result.ok) throw result.cause;
    if (accepted(result.value))
      observation.progress.stage = name === "token_exchange" ? "user_info" : "account_session";
    return result.value;
  };
  const plugin: BetterAuthPlugin = {
    id: "executor-auth-observability",
    // Register last so emulator and other provider plugins have finished initialization.
    init: (context) => {
      // Better Auth assigns the returned context onto this one, so keep the adapter it replaces.
      const adapter = context.adapter;
      return {
        context: {
          // Better Auth reads the client of most OAuth requests by its ID. Classify that row
          // as it passes, so a request that loads its client costs no further query.
          adapter: {
            ...adapter,
            findOne: async <T>(query: Parameters<typeof adapter.findOne>[0]) => {
              const row = await adapter.findOne<T>(query);
              const observed = oauthRequests.getStore();
              if (observed !== undefined && query.model === "oauthClient")
                observed.client = clientFamily(row);
              return row;
            },
          },
          socialProviders: context.socialProviders.map((provider) => ({
            ...provider,
            validateAuthorizationCode: (...args) =>
              stage(
                "token_exchange",
                () => provider.validateAuthorizationCode(...args),
                (value) => value != null,
              ),
            getUserInfo: (...args) =>
              stage(
                "user_info",
                () => provider.getUserInfo(...args),
                (value) => value?.user != null,
              ),
          })),
        },
      };
    },
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path !== undefined && clientPaths.has(ctx.path),
          // Requests that fail before Better Auth reads their client, such as a refresh token
          // that no longer exists, read it here by its ID. Telemetry never fails the request.
          handler: createAuthMiddleware(async (ctx) => {
            const observed = oauthRequests.getStore();
            if (observed === undefined || observed.client !== undefined) return;
            const clientId = requestedClientId(ctx);
            if (clientId === undefined) return;
            await ctx.context.adapter
              .findOne({ model: "oauthClient", where: [{ field: "clientId", value: clientId }] })
              .catch(() => undefined);
          }),
        },
      ],
    },
  };
  return {
    plugin,
    /** Better Auth's reuse detection revoked the refresh family of the current token request. */
    refreshFamilyRevoked: () => {
      const observed = oauthRequests.getStore();
      if (observed !== undefined) observed.familyRevoked = true;
    },
    sessionCreated: () => {
      const observation = requests.getStore();
      if (observation !== undefined) observation.progress.sessionCreated = true;
    },
    observe: <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = new URL(request.url, "https://auth.invalid").pathname;
        if (request.method === "POST" && path === "/api/auth/oauth2/token")
          return yield* observeToken(handler);
        if (path === "/api/auth/oauth2/authorize" || path === "/api/auth/oauth2/consent")
          return yield* Effect.flatten(observeClient(handler));
        const match = /^\/api\/auth\/(?:oauth2\/)?callback\/([^/]+)$/.exec(path);
        if (match === null) return yield* handler;
        const provider = match[1] === "github" || match[1] === "google" ? match[1] : "other";
        const requestSpan = yield* Effect.currentSpan.pipe(Effect.option);
        const record = (attributes: Record<string, string | number | boolean>) =>
          Effect.gen(function* () {
            yield* Effect.annotateCurrentSpan(attributes);
            // Retain HTTP 302 while marking the enclosing request's logical failure too.
            if (Option.isSome(requestSpan))
              for (const [key, value] of Object.entries(attributes))
                requestSpan.value.attribute(key, value);
            yield* Effect.logInfo("auth.oauth.callback.completed").pipe(
              Effect.annotateLogs(attributes),
            );
          });
        return yield* Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          const progress: Progress = { stage: "callback_validation", sessionCreated: false };
          const exit = yield* Effect.promise((signal) =>
            requests.run(
              {
                provider,
                progress,
                run: (effect) =>
                  Effect.runPromise(effect.pipe(Effect.provideContext(context)), { signal }),
              },
              () => Effect.runPromiseExit(handler.pipe(Effect.provideContext(context)), { signal }),
            ),
          );
          if (Exit.isFailure(exit)) {
            const attributes = {
              "auth.provider": provider,
              "auth.outcome": "failure",
              "auth.error_code": "internal_error",
              "auth.stage": progress.stage,
              "auth.session_created": progress.sessionCreated,
              "executor.outcome": "failed",
            };
            yield* record(attributes);
            return exit;
          }
          const response = exit.value;
          // Inspect only to project a bounded code. Never retain the URL or description.
          let error: string | null = null;
          const location = response.headers.location;
          if (location !== undefined) {
            try {
              error = new URL(location, "https://auth.invalid").searchParams.get("error");
            } catch {
              error = "invalid_redirect";
            }
          }
          const code =
            error === null
              ? response.status >= 400
                ? "http_error"
                : "none"
              : Option.getOrElse(
                  Schema.decodeUnknownOption(KnownError)(error),
                  () => "unrecognized_error" as const,
                );
          const outcome =
            code !== "none" ? "failure" : progress.sessionCreated ? "success" : "unconfirmed";
          const attributes = {
            "auth.provider": provider,
            "auth.outcome": outcome,
            "auth.error_code": code,
            "auth.stage": progress.stage,
            "auth.session_created": progress.sessionCreated,
            "http.response.status_code": response.status,
            "executor.outcome": outcome === "failure" ? "failed" : outcome,
          };
          yield* record(attributes);
          return exit;
        }).pipe(
          Effect.withSpan("auth.oauth.callback", { attributes: { "auth.provider": provider } }),
          Effect.flatten,
        );
      }),
  };
};
