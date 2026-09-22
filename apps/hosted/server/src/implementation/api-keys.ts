import { apiKey } from "@better-auth/api-key";
import type { GenericEndpointContext } from "@better-auth/core";
import { fullAuthority } from "@executor-js/authorization";
import { authCall } from "@executor-js/mcp-auth/oauth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { Effect, Option, Redacted, Schema } from "effect";
import { AuthenticationUnavailable } from "../contracts/auth.ts";
import { ApiKeyId, CreateApiKey } from "../contracts/api-keys.ts";
import { OrganizationId } from "../contracts/organization.ts";

/** Better Auth owns the only key store and lifecycle for personal and saved Executor accounts. */
export const apiKeys = apiKey({
  defaultPrefix: "exp_",
  requireName: true,
  maximumNameLength: 80,
  enableSessionForAPIKeys: false,
  rateLimit: { enabled: false },
  keyExpiration: { minExpiresIn: 1 / 86400 },
  // Only the auto-minted Executor app key records metadata; the browser create
  // endpoint rejects it through apiKeyManagement's strict body schema.
  enableMetadata: true,
});

/** A saved Executor account's key authorizes only inside the organization that minted it. */
const KeyMetadata = Schema.NullOr(Schema.Struct({ organization: Schema.optional(OrganizationId) }));
export const pinnedKeyMetadata = (organization: OrganizationId) => ({ organization });

/** Constrain native key management to browser sessions and the v1 PAT inputs. */
export const apiKeyManagement = createAuthMiddleware(async (ctx) => {
  if (!ctx.path?.startsWith("/api-key/") || ctx.request === undefined) return;
  if (ctx.headers?.has("authorization")) throw new APIError("FORBIDDEN");
  if (ctx.method !== "GET" && ctx.headers?.get("origin") !== new URL(ctx.context.baseURL).origin)
    throw new APIError("FORBIDDEN");
  if (ctx.path === "/api-key/create") {
    if (
      Option.isNone(
        Schema.decodeUnknownOption(CreateApiKey, { onExcessProperty: "error" })(ctx.body),
      )
    )
      throw new APIError("BAD_REQUEST");
  }
  if (!["/api-key/create", "/api-key/list", "/api-key/get", "/api-key/delete"].includes(ctx.path))
    throw new APIError("NOT_FOUND");
});

/** Native PATs select key authentication instead of the OAuth bearer path. */
export const isApiKey = (token: string) => token.startsWith("exp_");

/** Project a native key into current-user authority; deleted users cannot retain access. */
const identity = (
  ctx: GenericEndpointContext,
  key: { id: string; referenceId: string; metadata: unknown },
) =>
  Effect.gen(function* () {
    const user = yield* authCall(() =>
      ctx.context.adapter.findOne({
        model: "user",
        where: [{ field: "id", value: key.referenceId }],
        select: ["id"],
      }),
    );
    if (user === null) return yield* Effect.fail(new APIError("UNAUTHORIZED"));
    const id = yield* Schema.decodeUnknownEffect(ApiKeyId)(key.id).pipe(
      Effect.mapError(() => new APIError("SERVICE_UNAVAILABLE")),
    );
    // Unreadable metadata fails closed: it cannot prove the key is an unpinned PAT.
    const metadata = yield* Schema.decodeUnknownEffect(KeyMetadata)(key.metadata).pipe(
      Effect.mapError(() => new APIError("UNAUTHORIZED")),
    );
    return {
      userId: key.referenceId,
      key: { id },
      policy: fullAuthority,
      organization: metadata?.organization,
    };
  });

/** User PATs carry no organization; a pinned key never authorizes another organization. */
export const requirePinnedOrganization = (
  identity: { readonly organization: OrganizationId | undefined },
  organization: OrganizationId,
) =>
  identity.organization === undefined || identity.organization === organization
    ? Effect.void
    : Effect.fail(
        new APIError("FORBIDDEN", {
          message: "This key belongs to a different organization.",
        }),
      );

/** Verify expiry, revocation and usage through Better Auth before applying product authorization. */
export const apiKeyAccess = (ctx: GenericEndpointContext, token: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const result = yield* authCall(() =>
      apiKeys.endpoints.verifyApiKey({
        context: ctx.context,
        body: { key: Redacted.value(token) },
      }),
    );
    if (!result.valid || result.key === null)
      return yield* Effect.fail(new APIError("UNAUTHORIZED"));
    return yield* identity(ctx, result.key);
  });

/** Revoke unclaimed native keys after a failed or concurrent account setup. */
export const accountApiKey = (
  create: () => Promise<{ id: string; key: string }>,
  revoke: (id: string) => Promise<unknown>,
) =>
  Effect.gen(function* () {
    let retained = false;
    const issued = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: create, catch: () => new AuthenticationUnavailable() }),
      (issued) =>
        retained
          ? Effect.void
          : Effect.tryPromise({
              try: () => revoke(issued.id),
              catch: () => new AuthenticationUnavailable(),
            }).pipe(Effect.orDie),
    );
    return {
      key: Redacted.make(issued.key),
      retain: Effect.sync(() => {
        retained = true;
      }),
    };
  });

/** The signed-in owner can review a live native key's pending MCP approval. */
export const browserPersonalTokenAccess = (
  ctx: GenericEndpointContext,
  origin: string,
  id: typeof ApiKeyId.Type,
) =>
  Effect.gen(function* () {
    const headers = ctx.headers;
    if (headers === undefined || headers.has("authorization") || headers.get("origin") !== origin)
      return yield* Effect.fail(new APIError("FORBIDDEN"));
    const key = yield* authCall(() =>
      apiKeys.endpoints.getApiKey({
        context: ctx.context,
        headers,
        query: { id },
      }),
    ).pipe(
      Effect.mapError((error) => (error.statusCode === 404 ? new APIError("UNAUTHORIZED") : error)),
    );
    if (!key.enabled || (key.expiresAt !== null && key.expiresAt.getTime() <= Date.now()))
      return yield* Effect.fail(new APIError("UNAUTHORIZED"));
    return yield* identity(ctx, key);
  });
