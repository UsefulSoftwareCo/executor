import { Context, Data, Effect, Layer, Option, Schema } from "effect";

import { ApiKeyManagementError } from "./api-key-errors";
import { WorkOSAuth } from "./workos";

export type ApiKeyPrincipal = {
  readonly accountId: string;
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

const UserApiKeyOwner = Schema.Struct({
  type: Schema.Literal("user"),
  id: Schema.String,
  organizationId: Schema.optional(Schema.String),
  organization_id: Schema.optional(Schema.String),
});

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

const ValidateApiKeyResponse = Schema.Struct({
  apiKey: Schema.NullOr(ApiKey),
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

const CreateApiKeyResponse = Schema.Union([
  RawCreatedApiKey,
  Schema.Struct({ apiKey: RawCreatedApiKey }),
  Schema.Struct({ api_key: RawCreatedApiKey }),
]);

const decodeValidateApiKeyResponse = Schema.decodeUnknownOption(ValidateApiKeyResponse);
const decodeListApiKeysResponse = Schema.decodeUnknownOption(ListApiKeysResponse);
const decodeCreateApiKeyResponse = Schema.decodeUnknownOption(CreateApiKeyResponse);

const principalFromResponse = (value: unknown): ApiKeyPrincipal | null =>
  Option.match(decodeValidateApiKeyResponse(value), {
    onNone: () => null,
    onSome: ({ apiKey }) => {
      if (!apiKey) return null;
      const organizationId = apiKey.owner.organizationId ?? apiKey.owner.organization_id;
      if (!organizationId) return null;
      return {
        accountId: apiKey.owner.id,
        organizationId,
        keyId: apiKey.id,
      };
    },
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

export class ApiKeyService extends Context.Service<
  ApiKeyService,
  {
    readonly validate: (
      value: string,
    ) => Effect.Effect<ApiKeyPrincipal | null, ApiKeyValidationError>;
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
  }
>()("@executor-js/cloud/ApiKeyService") {
  static WorkOS = Layer.effect(this)(
    Effect.gen(function* () {
      const workos = yield* WorkOSAuth;
      return {
        validate: (value: string) =>
          workos.validateApiKey(value).pipe(
            Effect.map(principalFromResponse),
            Effect.mapError((cause) => new ApiKeyValidationError({ cause })),
          ),
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
          workos
            .deleteApiKey(keyId)
            .pipe(Effect.mapError((cause) => new ApiKeyManagementError({ cause }))),
      };
    }),
  );
}
