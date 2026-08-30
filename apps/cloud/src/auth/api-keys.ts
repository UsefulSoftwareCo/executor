import { Context, Data, Effect, Layer, Option, Schema } from "effect";

import { sha256Hex } from "@executor-js/sdk";

import { ApiKeyManagementError } from "./errors";
import { WorkOSClient } from "./workos";

/**
 * Which view a validated key resolves to.
 *   - `"user"` — the product view. The key belongs to a member; the request
 *     binds to that member as the acting subject. Every key today is this.
 *   - `"org"` — the PLATFORM view. The key belongs to the organization itself,
 *     so there is no acting member: the request gets tenant-wide READ-ONLY
 *     reach and no bound subject. Privileged; minted separately (PR 1.5).
 */
export type ApiKeyScope = "user" | "org";

/** The owner an api key resolves to — NOT a full {@link Principal} (no email /
 * name / roles), so it carries an honest, distinct name. */
export type ApiKeyOwner = {
  readonly scope: ApiKeyScope;
  /** The acting member for a `"user"` key; `null` for an `"org"` key, which
   *  has no member behind it. Nullable rather than a sentinel so nothing can
   *  accidentally bind an org key to a subject. */
  readonly accountId: string | null;
  readonly organizationId: string;
  readonly keyId: string;
};

export type ApiKeySummary = {
  readonly id: string;
  readonly name: string;
  readonly obfuscatedValue: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt: string | null;
};

export type CreatedApiKey = ApiKeySummary & {
  readonly value: string;
};

export class ApiKeyValidationError extends Data.TaggedError("ApiKeyValidationError")<{
  readonly cause: unknown;
}> {}

/**
 * The requested key id is not an org-owned key of this organization — it does
 * not exist, belongs to a member rather than the org, or belongs to a different
 * org in the same WorkOS workspace. Distinct from `ApiKeyManagementError` (an
 * upstream failure) so callers can answer "not found" without a 500.
 */
export class OrgApiKeyNotFound extends Data.TaggedError("OrgApiKeyNotFound")<{
  readonly keyId: string;
}> {}

// WorkOS keys are owned by either a user or an organization. The user shape
// carries the member id in `id` and the org in `organization_id`; the org shape
// carries the ORG in `id` and no member at all. Both decode here — the
// distinction is a branch (`ownerFromApiKey`), not a decode failure, so an
// org-owned key is no longer indistinguishable from an invalid one.
const UserApiKeyOwner = Schema.Struct({
  type: Schema.Literal("user"),
  id: Schema.String,
  organizationId: Schema.optional(Schema.String),
  organization_id: Schema.optional(Schema.String),
});

const OrgApiKeyOwner = Schema.Struct({
  type: Schema.Literal("organization"),
  id: Schema.String,
});

const WorkOSApiKeyOwner = Schema.Union([UserApiKeyOwner, OrgApiKeyOwner]);

const ApiKey = Schema.Struct({
  id: Schema.String,
  owner: UserApiKeyOwner,
  name: Schema.optional(Schema.String),
  obfuscatedValue: Schema.optional(Schema.String),
  obfuscated_value: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.String),
  lastUsedAt: Schema.optional(Schema.NullOr(Schema.String)),
  last_used_at: Schema.optional(Schema.NullOr(Schema.String)),
});

// Validation accepts BOTH owner shapes. The user list/create paths below stay
// user-only on purpose (they are the console's personal-key CRUD); the ORG
// list/create paths are the separate, privileged surface beside them, gated to
// admins at the account-provider boundary.
const ValidatedApiKey = Schema.Struct({
  id: Schema.String,
  owner: WorkOSApiKeyOwner,
});

const ValidateApiKeyResponse = Schema.Struct({
  apiKey: Schema.NullOr(ValidatedApiKey),
});

const RawCreatedApiKey = Schema.Struct({
  id: Schema.String,
  owner: UserApiKeyOwner,
  name: Schema.optional(Schema.String),
  obfuscatedValue: Schema.optional(Schema.String),
  obfuscated_value: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.String),
  lastUsedAt: Schema.optional(Schema.NullOr(Schema.String)),
  last_used_at: Schema.optional(Schema.NullOr(Schema.String)),
  value: Schema.String,
});

const ListApiKeysResponse = Schema.Struct({
  data: Schema.Array(ApiKey),
});

// The ORG-owned mirror of `ApiKey` / `RawCreatedApiKey`. A separate shape
// rather than a widened one: `summaryFromApiKey` reads the user shape's
// `organization_id` to prove the key belongs to the caller's org, and an
// org-owned row carries the org in `owner.id` instead. Merging them would mean
// one nullable field standing for two different things.
const OrgApiKey = Schema.Struct({
  id: Schema.String,
  owner: OrgApiKeyOwner,
  name: Schema.optional(Schema.String),
  obfuscatedValue: Schema.optional(Schema.String),
  obfuscated_value: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.String),
  lastUsedAt: Schema.optional(Schema.NullOr(Schema.String)),
  last_used_at: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawCreatedOrgApiKey = Schema.Struct({
  ...OrgApiKey.fields,
  value: Schema.String,
});

// `data` is decoded element-by-element, NOT as `Schema.Array(OrgApiKey)`: WorkOS
// may return user-owned keys alongside org-owned ones, and a whole-array decode
// fails on the first non-org element — blanking the entire list rather than
// dropping the one row that doesn't belong. Same per-row tolerance the user-key
// path gets from `summaryFromApiKey` returning null.
const ListOrgApiKeysResponse = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
});

const CreateOrgApiKeyResponse = Schema.Union([
  RawCreatedOrgApiKey,
  Schema.Struct({ apiKey: RawCreatedOrgApiKey }),
  Schema.Struct({ api_key: RawCreatedOrgApiKey }),
]);

const CreateApiKeyResponse = Schema.Union([
  RawCreatedApiKey,
  Schema.Struct({ apiKey: RawCreatedApiKey }),
  Schema.Struct({ api_key: RawCreatedApiKey }),
]);

const decodeValidateApiKeyResponse = Schema.decodeUnknownOption(ValidateApiKeyResponse);
const decodeListApiKeysResponse = Schema.decodeUnknownOption(ListApiKeysResponse);
const decodeCreateApiKeyResponse = Schema.decodeUnknownOption(CreateApiKeyResponse);
const decodeListOrgApiKeysResponse = Schema.decodeUnknownOption(ListOrgApiKeysResponse);
const decodeOrgApiKey = Schema.decodeUnknownOption(OrgApiKey);
const decodeCreateOrgApiKeyResponse = Schema.decodeUnknownOption(CreateOrgApiKeyResponse);

const ownerFromApiKey = (apiKey: typeof ValidatedApiKey.Type): ApiKeyOwner | null => {
  if (apiKey.owner.type === "organization") {
    // An org-owned key IS the org: `owner.id` is the organization, and there
    // is no member to act as. This resolves to the platform view.
    return {
      scope: "org",
      accountId: null,
      organizationId: apiKey.owner.id,
      keyId: apiKey.id,
    };
  }
  const organizationId = apiKey.owner.organizationId ?? apiKey.owner.organization_id;
  if (!organizationId) return null;
  return {
    scope: "user",
    accountId: apiKey.owner.id,
    organizationId,
    keyId: apiKey.id,
  };
};

const ownerFromResponse = (value: unknown): ApiKeyOwner | null =>
  Option.match(decodeValidateApiKeyResponse(value), {
    onNone: () => null,
    onSome: ({ apiKey }) => (apiKey ? ownerFromApiKey(apiKey) : null),
  });

const summaryFromApiKey = (apiKey: typeof ApiKey.Type): ApiKeySummary | null => {
  const organizationId = apiKey.owner.organizationId ?? apiKey.owner.organization_id;
  if (!organizationId) return null;
  return {
    id: apiKey.id,
    name: apiKey.name ?? "API key",
    obfuscatedValue: apiKey.obfuscatedValue ?? apiKey.obfuscated_value ?? "",
    createdAt: apiKey.createdAt ?? apiKey.created_at ?? "",
    updatedAt: apiKey.updatedAt ?? apiKey.updated_at ?? "",
    lastUsedAt: apiKey.lastUsedAt ?? apiKey.last_used_at ?? null,
  };
};

const listFromResponse = (value: unknown): readonly ApiKeySummary[] =>
  Option.match(decodeListApiKeysResponse(value), {
    onNone: () => [],
    onSome: ({ data }) =>
      data.flatMap((apiKey) => {
        const summary = summaryFromApiKey(apiKey);
        return summary ? [summary] : [];
      }),
  });

// The org-owned mirror of `summaryFromApiKey`. `organizationId` is checked by
// the CALLER against the org it asked for: WorkOS's workspace api key is
// workspace-wide, so a response naming a different org than the one requested
// must not be surfaced as that org's key.
const summaryFromOrgApiKey = (
  apiKey: typeof OrgApiKey.Type,
  organizationId: string,
): ApiKeySummary | null => {
  if (apiKey.owner.id !== organizationId) return null;
  return {
    id: apiKey.id,
    name: apiKey.name ?? "API key",
    obfuscatedValue: apiKey.obfuscatedValue ?? apiKey.obfuscated_value ?? "",
    createdAt: apiKey.createdAt ?? apiKey.created_at ?? "",
    updatedAt: apiKey.updatedAt ?? apiKey.updated_at ?? "",
    lastUsedAt: apiKey.lastUsedAt ?? apiKey.last_used_at ?? null,
  };
};

const orgListFromResponse = (value: unknown, organizationId: string): readonly ApiKeySummary[] =>
  Option.match(decodeListOrgApiKeysResponse(value), {
    onNone: () => [],
    onSome: ({ data }) =>
      data.flatMap((entry) =>
        Option.match(decodeOrgApiKey(entry), {
          // Not an org-owned key (a user key sharing the listing, or a shape we
          // don't recognize) — skip the row, keep the rest.
          onNone: () => [],
          onSome: (apiKey) => {
            const summary = summaryFromOrgApiKey(apiKey, organizationId);
            return summary ? [summary] : [];
          },
        }),
      ),
  });

const orgCreatedFromResponse = (value: unknown, organizationId: string): CreatedApiKey | null =>
  Option.match(decodeCreateOrgApiKeyResponse(value), {
    onNone: () => null,
    onSome: (response) => {
      const apiKey =
        "value" in response ? response : "apiKey" in response ? response.apiKey : response.api_key;
      const summary = summaryFromOrgApiKey(apiKey, organizationId);
      return summary ? { ...summary, value: apiKey.value } : null;
    },
  });

const createdFromResponse = (value: unknown): CreatedApiKey | null =>
  Option.match(decodeCreateApiKeyResponse(value), {
    onNone: () => null,
    onSome: (response) => {
      const apiKey =
        "value" in response ? response : "apiKey" in response ? response.apiKey : response.api_key;
      const summary = summaryFromApiKey(apiKey);
      return summary ? { ...summary, value: apiKey.value } : null;
    },
  });

// ---------------------------------------------------------------------------
// Per-isolate validation cache.
//
// Every /mcp request and every api-key-authenticated /api/* request funnels
// through `validate`, and each call is a live WorkOS round trip (~100-150ms).
// The JWT bearer path beside it verifies locally against a JWKS cached for an
// hour; api keys had no cache at all. This is the same bounded TTL map the
// engine already uses for billing outcomes (engine/execution-gate.ts).
//
// Security shape, stated explicitly because this is auth code:
//   - The map key is the SHA-256 digest of the presented key value, never the
//     raw credential, so the map's keys cannot be reversed into a usable key.
//     The digest reaches no log, span, or error message.
//   - Only SUCCESSFUL validations are cached. An invalid key and an upstream
//     failure always miss: an attacker probing bad keys cannot poison the map
//     (the size bound alone handles memory), and a just-created key works
//     immediately instead of waiting out a stale negative entry.
//   - REVOCATION WINDOW: the isolate that serves the revoke drops its own
//     entries for that key id immediately (`invalidateKeyId`, called by both
//     revoke paths below), so revoking a key through the console refuses it
//     on the next request wherever the same isolate validates. OTHER isolates
//     that validated the key before revocation keep serving it for up to the
//     TTL (60s). That residual window is the price of the cache, and it is
//     far tighter than the 1h JWKS rotation window the JWT path already
//     accepts.
//   - Concurrent misses for the same key each call WorkOS; there is no
//     in-flight dedupe. The duplicate window is one round trip per key per
//     TTL per isolate — exactly the cost EVERY request paid before this
//     cache — and dedupe would add interruption-safety machinery (a
//     cancelled leader must not strand its waiters) to auth-critical code.
// ---------------------------------------------------------------------------

const API_KEY_VALIDATION_CACHE_TTL_MS = 60_000;
// Sweep guard so a long-lived isolate serving many keys can't grow the cache
// map unbounded (mirrors BALANCE_CACHE_MAX_ENTRIES in execution-gate.ts).
const API_KEY_VALIDATION_CACHE_MAX_ENTRIES = 10_000;

type ApiKeyValidationCacheEntry = {
  readonly owner: ApiKeyOwner;
  readonly expiresAtMs: number;
};

// The map lives at MODULE scope — one per isolate — not inside
// `makeCachedApiKeyValidate`, because the `ApiKeyService.WorkOS` layer is NOT
// built once per isolate on every plane: the account middleware rebuilds it
// per request. A map owned by each build would give the revoke paths a fresh
// empty cache to invalidate while the long-lived identity plane kept serving
// the revoked key from its own. Every build shares this map instead (entries
// are pure validation RESULTS, so which build's WorkOS client wrote them does
// not matter), which is also what makes the entries survive between requests
// on the per-request plane at all.
const isolateApiKeyValidationCache = new Map<string, ApiKeyValidationCacheEntry>();

export type ApiKeyValidate = (
  value: string,
) => Effect.Effect<ApiKeyOwner | null, ApiKeyValidationError>;

/**
 * Wrap a `validate` function with the success cache described above. Exported
 * for tests only — production use is the `ApiKeyService.WorkOS` layer below,
 * every build of which shares the module-scope map.
 *
 * The `ttlMs` / `maxEntries` / `now` / `cache` knobs exist so tests can
 * exercise expiry, the size bound, and map sharing without wall time or
 * module state; production passes only `cache`.
 */
export const makeCachedApiKeyValidate = (
  validate: ApiKeyValidate,
  options?: {
    readonly ttlMs?: number;
    readonly maxEntries?: number;
    readonly now?: () => number;
    /** The map to cache into. Production passes the module-scope
     *  `isolateApiKeyValidationCache`; tests default to a private map. */
    readonly cache?: Map<string, ApiKeyValidationCacheEntry>;
  },
): {
  readonly validate: ApiKeyValidate;
  /**
   * Drop every cached entry that resolved to this key id. The cache is keyed
   * by the digest of the presented VALUE and a revoke only knows the key ID,
   * so this walks the map — bounded by `maxEntries`, and revocation is a rare
   * human action, not a hot path.
   */
  readonly invalidateKeyId: (keyId: string) => void;
  /** Test seam: the digests currently cached, so tests can assert the raw
   *  credential never appears as a map key. */
  readonly cacheKeys: () => ReadonlyArray<string>;
} => {
  const ttlMs = options?.ttlMs ?? API_KEY_VALIDATION_CACHE_TTL_MS;
  const maxEntries = options?.maxEntries ?? API_KEY_VALIDATION_CACHE_MAX_ENTRIES;
  const now = options?.now ?? Date.now;
  const cache = options?.cache ?? new Map<string, ApiKeyValidationCacheEntry>();

  const writeCache = (digest: string, owner: ApiKeyOwner, nowMs: number): void => {
    if (cache.size >= maxEntries) {
      for (const [key, entry] of cache) {
        if (entry.expiresAtMs <= nowMs) cache.delete(key);
      }
      // Still saturated after dropping expired entries: reset rather than grow.
      if (cache.size >= maxEntries) cache.clear();
    }
    cache.set(digest, { owner, expiresAtMs: nowMs + ttlMs });
  };

  return {
    cacheKeys: () => [...cache.keys()],
    invalidateKeyId: (keyId) => {
      for (const [digest, entry] of cache) {
        if (entry.owner.keyId === keyId) cache.delete(digest);
      }
    },
    validate: (value) =>
      Effect.gen(function* () {
        const digest = yield* sha256Hex(value);
        const nowMs = now();
        const cached = cache.get(digest);
        if (cached && cached.expiresAtMs > nowMs) return cached.owner;
        const owner = yield* validate(value);
        // Cache only a resolved owner — see the block comment above for why
        // null results and failures always stay misses.
        if (owner) writeCache(digest, owner, nowMs);
        return owner;
      }),
  };
};

export class ApiKeyService extends Context.Service<
  ApiKeyService,
  {
    readonly validate: (value: string) => Effect.Effect<ApiKeyOwner | null, ApiKeyValidationError>;
    readonly listUserKeys: (input: {
      readonly accountId: string;
      readonly organizationId: string;
    }) => Effect.Effect<readonly ApiKeySummary[], ApiKeyManagementError>;
    readonly createUserKey: (input: {
      readonly accountId: string;
      readonly organizationId: string;
      readonly name: string;
    }) => Effect.Effect<CreatedApiKey, ApiKeyManagementError>;
    readonly revokeUserKey: (input: {
      readonly keyId: string;
    }) => Effect.Effect<void, ApiKeyManagementError>;
    /**
     * The org-owned keys of an organization — the credentials that resolve to
     * the read-only platform view. Privileged: callers gate on admin membership
     * before reaching this.
     */
    readonly listOrgKeys: (input: {
      readonly organizationId: string;
    }) => Effect.Effect<readonly ApiKeySummary[], ApiKeyManagementError>;
    readonly createOrgKey: (input: {
      readonly organizationId: string;
      readonly name: string;
    }) => Effect.Effect<CreatedApiKey, ApiKeyManagementError>;
    /**
     * Revoke an org-owned key. Ownership is resolved against the ORG's own key
     * listing — never the caller's personal keys — so a member's user key id
     * (or another org's key id, since the WorkOS workspace key is
     * workspace-wide) cannot be destroyed through this path.
     */
    readonly revokeOrgKey: (input: {
      readonly organizationId: string;
      readonly keyId: string;
    }) => Effect.Effect<void, ApiKeyManagementError | OrgApiKeyNotFound>;
  }
>()("@executor-js/cloud/ApiKeyService") {
  static WorkOS = Layer.effect(this)(
    Effect.gen(function* () {
      const workos = yield* WorkOSClient;
      // The cache MAP is the module-scope per-isolate one (see its comment);
      // this build only contributes the validate function that fills it, so
      // however many times a plane rebuilds this layer, hits, misses, and
      // invalidations all land in the same map.
      const cachedValidate = makeCachedApiKeyValidate(
        (value) =>
          workos.validateApiKey(value).pipe(
            Effect.map(ownerFromResponse),
            Effect.mapError((cause) => new ApiKeyValidationError({ cause })),
          ),
        { cache: isolateApiKeyValidationCache },
      );
      return {
        validate: cachedValidate.validate,
        listUserKeys: ({ accountId, organizationId }) =>
          workos.listUserApiKeys(accountId, organizationId).pipe(
            Effect.map(listFromResponse),
            Effect.mapError((cause) => new ApiKeyManagementError({ cause })),
          ),
        createUserKey: ({ accountId, organizationId, name }) =>
          workos.createUserApiKey({ userId: accountId, organizationId, name }).pipe(
            Effect.mapError((cause) => new ApiKeyManagementError({ cause })),
            Effect.flatMap((response) => {
              const created = createdFromResponse(response);
              return created
                ? Effect.succeed(created)
                : Effect.fail(new ApiKeyManagementError({ cause: "invalid_create_response" }));
            }),
          ),
        revokeUserKey: ({ keyId }) =>
          workos.deleteApiKey(keyId).pipe(
            Effect.mapError((cause) => new ApiKeyManagementError({ cause })),
            Effect.tap(() => Effect.sync(() => cachedValidate.invalidateKeyId(keyId))),
          ),
        listOrgKeys: ({ organizationId }) =>
          workos.listOrgApiKeys(organizationId).pipe(
            Effect.map((response) => orgListFromResponse(response, organizationId)),
            Effect.mapError((cause) => new ApiKeyManagementError({ cause })),
          ),
        createOrgKey: ({ organizationId, name }) =>
          workos.createOrgApiKey({ organizationId, name }).pipe(
            Effect.mapError((cause) => new ApiKeyManagementError({ cause })),
            Effect.flatMap((response) => {
              const created = orgCreatedFromResponse(response, organizationId);
              return created
                ? Effect.succeed(created)
                : Effect.fail(new ApiKeyManagementError({ cause: "invalid_create_response" }));
            }),
          ),
        // Ownership is checked against the ORG's decoded key listing before the
        // delete goes out. `deleteApiKey` is scope-blind — handed any key id it
        // would happily destroy a member's personal credential, or a key
        // belonging to a sibling org in the same workspace. The listing already
        // drops both of those (`orgListFromResponse` filters on owner type AND
        // organization), so filtering through it is the whole authorization.
        revokeOrgKey: ({ organizationId, keyId }) =>
          Effect.gen(function* () {
            const response = yield* workos
              .listOrgApiKeys(organizationId)
              .pipe(Effect.mapError((cause) => new ApiKeyManagementError({ cause })));
            const owned = orgListFromResponse(response, organizationId);
            if (!owned.some((key) => key.id === keyId)) {
              return yield* new OrgApiKeyNotFound({ keyId });
            }
            yield* workos
              .deleteApiKey(keyId)
              .pipe(Effect.mapError((cause) => new ApiKeyManagementError({ cause })));
            cachedValidate.invalidateKeyId(keyId);
          }),
      };
    }),
  );
}
