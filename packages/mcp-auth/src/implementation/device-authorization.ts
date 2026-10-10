/**
 * RFC 8628 device authorization for the OAuth provider. The request, approval and polling state
 * live in Better Auth's verification table; tokens come from the provider's own issuance with the
 * approved grant as their reference, so they are the same tokens the browser flow issues.
 *
 * Every stored identifier is an HMAC of a code under the auth secret, so a database read cannot
 * recover a usable device code or a user code.
 */
import type { BetterAuthPlugin, GenericEndpointContext } from "@better-auth/core";
import {
  DEVICE_CODE_GRANT_TYPE,
  extendOAuthProvider,
  getOAuthProviderApi,
  type OAuthExtensionGrantHandlerInput,
  type OAuthOptions,
  type OAuthProviderExtension,
  type Scope,
} from "@better-auth/oauth-provider";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { makeSignature } from "better-auth/crypto";
import { Base64Url } from "effect/encoding";
import { Clock, Effect, Option, Schema } from "effect";
import {
  DeviceDecision,
  DeviceRequestView,
  deviceVerificationPath,
  formatUserCode,
  normalizeUserCode,
  userCodeAlphabet,
  userCodeLength,
} from "../contracts/device.ts";
import { GrantId } from "../contracts/grant.ts";
import { authCall, parse, runAuth } from "./auth-call.ts";

/** How long a person has to approve a request, and the polling interval the client starts with. */
const requestSeconds = 600;
const pollSeconds = 5;
/** Requests outlive their expiry this long so a late poll learns `expired_token`. */
const expiredSeconds = 600;
const deviceAuthorizationPath = "/oauth2/device-authorization";

const Decision = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("denied") }),
  Schema.Struct({
    status: Schema.Literal("approved"),
    userId: Schema.NonEmptyString,
    grant: GrantId,
    /** The approving browser session, which tokens name as the browser flow's do. */
    sessionId: Schema.NonEmptyString,
  }),
]);
const DeviceRequest = Schema.Struct({
  clientId: Schema.NonEmptyString,
  resource: Schema.NonEmptyString,
  scopes: Schema.Array(Schema.String),
  /** The user code's key, so finishing the request also forgets it. */
  userCode: Schema.NonEmptyString,
  expiresAt: Schema.Number,
  decision: Decision,
});
type DeviceRequest = typeof DeviceRequest.Type;
const StoredRequest = Schema.fromJsonString(DeviceRequest);
const Poll = Schema.fromJsonString(Schema.Struct({ at: Schema.Number, interval: Schema.Number }));
const VerificationRow = Schema.Struct({ id: Schema.String, value: Schema.String });

/** RFC 8628 token and request errors, in the provider's own error shape. */
const oauthError = (error: string, description: string) =>
  new APIError("BAD_REQUEST", { error, error_description: description });

const deviceIdentifier = (key: string) => `device-code:${key}`;
const userCodeIdentifier = (key: string) => `device-user-code:${key}`;
const pollIdentifier = (key: string) => `device-poll:${key}`;

/** Keyed so stored identifiers neither reveal nor let anyone guess the codes offline. */
const codeKey = (ctx: GenericEndpointContext, kind: "device" | "user", code: string) =>
  authCall(() => makeSignature(`${kind}:${code}`, ctx.context.secret));

const randomUserCode = () => {
  const letters: string[] = [];
  // Reject bytes past the last whole multiple of the alphabet so every letter is equally likely.
  const limit = 256 - (256 % userCodeAlphabet.length);
  while (letters.length < userCodeLength)
    for (const byte of crypto.getRandomValues(new Uint8Array(userCodeLength)))
      if (byte < limit && letters.length < userCodeLength)
        letters.push(userCodeAlphabet[byte % userCodeAlphabet.length] ?? "");
  return letters.join("");
};

export interface DeviceAuthorizationOptions {
  /** The browser origin that serves the verification page. */
  readonly origin: string;
  /** The provider's options, as the token endpoint uses them. */
  readonly provider: OAuthOptions<Scope[]>;
  /** Whether a resource is one this host issues tokens for. */
  readonly accepts: (resource: string) => boolean;
  /** The signed-in browser user and session, refusing cross-origin and bearer requests. */
  readonly session: (
    ctx: GenericEndpointContext,
  ) => Effect.Effect<{ readonly userId: string; readonly sessionId: string }, APIError>;
  /** Create and record the grant one approval authorizes, as consent does. */
  readonly approve: (
    ctx: GenericEndpointContext,
    request: {
      readonly userId: string;
      readonly clientId: string;
      readonly resource: string;
      readonly scopes: readonly string[];
    },
  ) => Effect.Effect<GrantId, APIError>;
  /** Withdraw a grant whose approval lost a race with another decision. */
  readonly revoke: (ctx: GenericEndpointContext, grant: GrantId) => Effect.Effect<void, APIError>;
}

export const deviceAuthorizationPlugin = (settings: DeviceAuthorizationOptions) => {
  const find = (ctx: GenericEndpointContext, identifier: string) =>
    authCall(() => ctx.context.internalAdapter.findVerificationValue(identifier)).pipe(
      Effect.flatMap((row) =>
        row === null
          ? Effect.succeedNone
          : parse(VerificationRow, row).pipe(
              Effect.mapError(() => new APIError("SERVICE_UNAVAILABLE")),
              Effect.map(Option.some),
            ),
      ),
    );
  /** The request a device code names, with the row it was read from. */
  const read = (ctx: GenericEndpointContext, key: string) =>
    find(ctx, deviceIdentifier(key)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (row) =>
            parse(StoredRequest, row.value).pipe(
              Effect.mapError(() => new APIError("SERVICE_UNAVAILABLE")),
              Effect.map((request) => Option.some({ row, request })),
            ),
        }),
      ),
    );
  /** The request a typed user code names. */
  const locate = (ctx: GenericEndpointContext, input: string) =>
    Effect.gen(function* () {
      const code = normalizeUserCode(input);
      if (code === undefined) return Option.none();
      const pointer = yield* find(ctx, userCodeIdentifier(yield* codeKey(ctx, "user", code)));
      if (Option.isNone(pointer)) return Option.none();
      const found = yield* read(ctx, pointer.value.value);
      return Option.map(found, (found) => ({ ...found, key: pointer.value.value }));
    });
  /** Compare-and-set, so concurrent decisions and redemptions cannot both win. */
  const replace = (
    ctx: GenericEndpointContext,
    row: typeof VerificationRow.Type,
    request: DeviceRequest,
  ) =>
    Schema.encodeEffect(StoredRequest)(request).pipe(
      Effect.mapError(() => new APIError("SERVICE_UNAVAILABLE")),
      Effect.flatMap((value) =>
        authCall(() =>
          ctx.context.adapter.update({
            model: "verification",
            where: [
              { field: "id", value: row.id },
              { field: "value", value: row.value },
            ],
            update: { value, updatedAt: new Date() },
          }),
        ),
      ),
      Effect.map((changed) => changed !== null),
    );
  const forget = (ctx: GenericEndpointContext, key: string, request: DeviceRequest) =>
    Effect.forEach(
      [deviceIdentifier(key), userCodeIdentifier(request.userCode), pollIdentifier(key)],
      (identifier) =>
        authCall(() => ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier)),
      { discard: true },
    );
  /** RFC 8628 section 3.5: polling faster than the interval adds five seconds to it. */
  const pace = (ctx: GenericEndpointContext, key: string, now: number, expiresAt: number) =>
    Effect.gen(function* () {
      const identifier = pollIdentifier(key);
      const previous = yield* find(ctx, identifier);
      const last = Option.isSome(previous)
        ? yield* parse(Poll, previous.value.value).pipe(
            Effect.mapError(() => new APIError("SERVICE_UNAVAILABLE")),
          )
        : undefined;
      const early = last !== undefined && now - last.at < last.interval * 1000;
      const value = yield* Schema.encodeEffect(Poll)({
        at: now,
        interval: (last?.interval ?? pollSeconds) + (early ? 5 : 0),
      }).pipe(Effect.mapError(() => new APIError("SERVICE_UNAVAILABLE")));
      yield* authCall(() =>
        last === undefined
          ? ctx.context.internalAdapter.createVerificationValue({
              identifier,
              value,
              expiresAt: new Date(expiresAt),
            })
          : ctx.context.internalAdapter.updateVerificationByIdentifier(identifier, { value }),
      );
      if (early)
        return yield* Effect.fail(
          oauthError("slow_down", "Poll no more often than the interval, plus five seconds."),
        );
    });

  /** The token endpoint's `urn:ietf:params:oauth:grant-type:device_code` grant. */
  const exchange = ({ ctx, provider }: OAuthExtensionGrantHandlerInput) =>
    runAuth(
      Effect.gen(function* () {
        const { device_code } = yield* parse(
          Schema.Struct({ device_code: Schema.NonEmptyString }),
          ctx.body,
        ).pipe(Effect.mapError(() => oauthError("invalid_request", "device_code is required.")));
        const { client } = yield* authCall(() =>
          Promise.resolve(provider.authenticateClient({ requireCredentials: false })),
        );
        const key = yield* codeKey(ctx, "device", device_code);
        const found = yield* read(ctx, key);
        if (Option.isNone(found) || found.value.request.clientId !== client.clientId)
          return yield* Effect.fail(oauthError("invalid_grant", "Unknown device code."));
        const { row, request } = found.value;
        const now = yield* Clock.currentTimeMillis;
        yield* pace(ctx, key, now, request.expiresAt + expiredSeconds * 1000);
        if (now >= request.expiresAt) {
          yield* forget(ctx, key, request);
          return yield* Effect.fail(
            oauthError("expired_token", "The device code expired. Start signing in again."),
          );
        }
        const decision = request.decision;
        if (decision.status === "pending")
          return yield* Effect.fail(
            oauthError("authorization_pending", "Waiting for the person to approve the request."),
          );
        if (decision.status === "denied") {
          yield* forget(ctx, key, request);
          return yield* Effect.fail(oauthError("access_denied", "The request was denied."));
        }
        // Single use: only the poll that consumes the approved row receives tokens.
        const consumed = yield* authCall(() =>
          ctx.context.internalAdapter.consumeVerificationValue(deviceIdentifier(key)),
        );
        yield* forget(ctx, key, request);
        if (consumed === null || consumed.value !== row.value)
          return yield* Effect.fail(oauthError("invalid_grant", "Unknown device code."));
        const user = yield* authCall(() =>
          ctx.context.internalAdapter.findUserById(decision.userId),
        );
        if (user === null)
          return yield* Effect.fail(oauthError("invalid_grant", "Unknown device code."));
        return yield* authCall(() =>
          Promise.resolve(
            provider.issueTokens({
              client,
              scopes: [...request.scopes],
              user,
              resources: [request.resource],
              referenceId: decision.grant,
              sessionId: decision.sessionId,
            }),
          ),
        );
      }),
    );

  const extension: OAuthProviderExtension = {
    grants: { [DEVICE_CODE_GRANT_TYPE]: exchange },
    metadata: ({ ctx }) => ({
      device_authorization_endpoint: `${ctx.context.baseURL}${deviceAuthorizationPath}`,
    }),
  };

  return {
    id: "executor-device-authorization",
    init: (ctx) => {
      extendOAuthProvider(ctx, extension);
    },
    endpoints: {
      /** RFC 8628 section 3.1: a client asks for a device code and a user code. */
      deviceAuthorization: createAuthEndpoint(
        deviceAuthorizationPath,
        {
          method: "POST",
          cloneRequest: true,
          metadata: { allowedMediaTypes: ["application/x-www-form-urlencoded"] },
        },
        (ctx) =>
          runAuth(
            Effect.gen(function* () {
              const body = yield* parse(
                Schema.Struct({
                  scope: Schema.optionalKey(Schema.String),
                  resource: Schema.optionalKey(Schema.String),
                }),
                ctx.body,
              ).pipe(
                Effect.mapError(() =>
                  oauthError("invalid_request", "Send one scope and one resource."),
                ),
              );
              const scopes = (body.scope ?? "").split(" ").filter((scope) => scope.length > 0);
              if (scopes.length === 0)
                return yield* Effect.fail(oauthError("invalid_scope", "Request a scope."));
              if (body.resource === undefined || !settings.accepts(body.resource))
                return yield* Effect.fail(
                  oauthError("invalid_target", "Name the Executor URL to authorize as resource."),
                );
              const resource = body.resource;
              const { clientId } = yield* authCall(() =>
                Promise.resolve(
                  getOAuthProviderApi(
                    ctx,
                    settings.provider,
                    DEVICE_CODE_GRANT_TYPE,
                  ).authenticateClient({ scopes, requireCredentials: false }),
                ),
              );
              const deviceCode = Base64Url.encode(crypto.getRandomValues(new Uint8Array(32)));
              const userCode = randomUserCode();
              const key = yield* codeKey(ctx, "device", deviceCode);
              const userKey = yield* codeKey(ctx, "user", userCode);
              const now = yield* Clock.currentTimeMillis;
              const expiresAt = now + requestSeconds * 1000;
              const value = yield* Schema.encodeEffect(StoredRequest)({
                clientId,
                resource,
                scopes,
                userCode: userKey,
                expiresAt,
                decision: { status: "pending" },
              }).pipe(Effect.mapError(() => new APIError("SERVICE_UNAVAILABLE")));
              yield* authCall(() =>
                ctx.context.internalAdapter.createVerificationValue({
                  identifier: deviceIdentifier(key),
                  value,
                  expiresAt: new Date(expiresAt + expiredSeconds * 1000),
                }),
              );
              yield* authCall(() =>
                ctx.context.internalAdapter.createVerificationValue({
                  identifier: userCodeIdentifier(userKey),
                  value: key,
                  expiresAt: new Date(expiresAt),
                }),
              );
              const verification = new URL(deviceVerificationPath, settings.origin);
              const complete = new URL(verification);
              complete.searchParams.set("user_code", formatUserCode(userCode));
              ctx.setHeader("Cache-Control", "no-store");
              ctx.setHeader("Pragma", "no-cache");
              return {
                device_code: deviceCode,
                user_code: formatUserCode(userCode),
                verification_uri: verification.href,
                verification_uri_complete: complete.href,
                expires_in: requestSeconds,
                interval: pollSeconds,
              };
            }),
          ),
      ),
      /** The pending request a user code names, for the signed-in person reviewing it. */
      getDeviceRequest: createAuthEndpoint(
        "/device/request",
        { method: "GET", requireHeaders: true },
        (ctx) =>
          runAuth(
            Effect.gen(function* () {
              yield* settings.session(ctx);
              const { user_code } = yield* parse(
                Schema.Struct({ user_code: Schema.String }),
                ctx.query,
              );
              const found = yield* locate(ctx, user_code);
              const now = yield* Clock.currentTimeMillis;
              if (Option.isNone(found) || now >= found.value.request.expiresAt)
                return yield* Effect.fail(new APIError("NOT_FOUND"));
              const { request } = found.value;
              if (request.decision.status !== "pending")
                return yield* Effect.fail(new APIError("CONFLICT"));
              return DeviceRequestView.make({
                clientId: request.clientId,
                resource: request.resource,
                scopes: request.scopes,
              });
            }),
          ),
      ),
      /**
       * Approve or deny a request. Approval creates the grant for the organization the page sends,
       * exactly as consent does; the device's next poll redeems it once.
       */
      decideDeviceRequest: createAuthEndpoint(
        "/device/decide",
        { method: "POST", requireHeaders: true },
        (ctx) =>
          runAuth(
            Effect.gen(function* () {
              const session = yield* settings.session(ctx);
              const input = yield* parse(
                Schema.Struct({ user_code: Schema.String, accept: Schema.Boolean }),
                ctx.body,
              );
              const found = yield* locate(ctx, input.user_code);
              const now = yield* Clock.currentTimeMillis;
              if (Option.isNone(found) || now >= found.value.request.expiresAt)
                return yield* Effect.fail(new APIError("NOT_FOUND"));
              const { row, request } = found.value;
              if (request.decision.status !== "pending")
                return yield* Effect.fail(new APIError("CONFLICT"));
              if (!input.accept) {
                const denied = yield* replace(ctx, row, {
                  ...request,
                  decision: { status: "denied" },
                });
                if (!denied) return yield* Effect.fail(new APIError("CONFLICT"));
                return DeviceDecision.make({ status: "denied" });
              }
              const grant = yield* settings.approve(ctx, {
                userId: session.userId,
                clientId: request.clientId,
                resource: request.resource,
                scopes: request.scopes,
              });
              const approved = yield* replace(ctx, row, {
                ...request,
                decision: {
                  status: "approved",
                  userId: session.userId,
                  grant,
                  sessionId: session.sessionId,
                },
              });
              if (!approved) {
                yield* settings.revoke(ctx, grant);
                return yield* Effect.fail(new APIError("CONFLICT"));
              }
              return DeviceDecision.make({ status: "approved" });
            }),
          ),
      ),
    },
    // Ten guesses a minute against ten-minute codes from 20^8 make guessing a live code hopeless.
    rateLimit: [
      { pathMatcher: (path) => path === deviceAuthorizationPath, window: 60, max: 10 },
      {
        pathMatcher: (path) => path === "/device/request" || path === "/device/decide",
        window: 60,
        max: 10,
      },
    ],
  } satisfies BetterAuthPlugin;
};
