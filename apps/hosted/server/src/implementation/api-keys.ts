import { apiKey, defaultKeyHasher } from "@better-auth/api-key";
import { generateRandomString } from "better-auth/crypto";
import { SqlClient } from "effect/unstable/sql";
import { StorageError } from "@executor-js/sdk/core";
import type { GenericEndpointContext } from "@better-auth/core";
import { fullAuthority } from "@executor-js/authorization";
import { authCall } from "@executor-js/mcp-auth/oauth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { Effect, Option, Redacted, Schema } from "effect";
import { ApiKeyId, ApiKeyMetadata, CreateApiKey } from "../contracts/api-keys.ts";
import { OrganizationId } from "../contracts/organization.ts";

/** Better Auth owns the only key store and lifecycle for personal and saved Executor accounts. */
export const apiKeys = apiKey({
  defaultPrefix: "exp_",
  requireName: true,
  maximumNameLength: 80,
  enableSessionForAPIKeys: false,
  rateLimit: { enabled: false },
  keyExpiration: { minExpiresIn: 1 / 86400 },
  // Metadata records the key's scope; apiKeyManagement's strict body schema
  // limits browser-created keys to a single organization pin.
  enableMetadata: true,
});

/** Stored metadata; keys created before pinning existed carry none. */
const KeyMetadata = Schema.NullOr(ApiKeyMetadata);
/** Pin a key to one organization; the auto-minted Executor app key always uses this. */
export const pinnedKeyMetadata = (organization: OrganizationId) => ({ organization });

/** Constrain native key management to browser sessions and the PAT inputs. */
export const apiKeyManagement = createAuthMiddleware(async (ctx) => {
  if (!ctx.path?.startsWith("/api-key/") || ctx.request === undefined) return;
  if (ctx.headers?.has("authorization")) throw new APIError("FORBIDDEN");
  if (ctx.method !== "GET" && ctx.headers?.get("origin") !== new URL(ctx.context.baseURL).origin)
    throw new APIError("FORBIDDEN");
  if (ctx.path === "/api-key/create") {
    const input = Schema.decodeUnknownOption(CreateApiKey, { onExcessProperty: "error" })(ctx.body);
    if (Option.isNone(input)) throw new APIError("BAD_REQUEST");
    // A pinned key must belong to an organization the creator is a member of today.
    const organization = input.value.metadata?.organization;
    if (organization !== undefined) {
      const session = await getSessionFromCtx(ctx);
      if (session === null) throw new APIError("UNAUTHORIZED");
      const member = await ctx.context.adapter.findOne({
        model: "member",
        where: [
          { field: "userId", value: session.user.id },
          { field: "organizationId", value: organization },
        ],
        select: ["id"],
      });
      if (member === null)
        throw new APIError("FORBIDDEN", {
          message: "You are not a member of that organization.",
        });
    }
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

/** A full-account key carries no organization; a pinned key never authorizes another organization. */
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

/**
 * Insert a native Better Auth key in the caller's account transaction. The only cleartext
 * copy is returned redacted for encrypted SDK storage; rollback removes both records.
 * Fields follow the pinned api-key plugin's public schema and native create endpoint.
 */
export const managedAccountKey = (organization: OrganizationId, user: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const token = Redacted.make(`exp_${generateRandomString(64)}`);
    const hash = yield* Effect.tryPromise({
      try: () => defaultKeyHasher(Redacted.value(token)),
      catch: () => new StorageError(),
    });
    yield* sql`insert into apikey (id, "configId", name, prefix, start, key, "referenceId", enabled,
      "rateLimitEnabled", "rateLimitTimeWindow", "rateLimitMax", "requestCount", "createdAt", "updatedAt", metadata)
      values (${crypto.randomUUID()}, 'default', 'Executor app', 'exp_', ${Redacted.value(token).slice(0, 6)}, ${hash}, ${user}, true,
        false, 86400000, 10, 0, now(), now(), ${JSON.stringify(pinnedKeyMetadata(organization))})`;
    return token;
  }).pipe(Effect.mapError(() => new StorageError()));
