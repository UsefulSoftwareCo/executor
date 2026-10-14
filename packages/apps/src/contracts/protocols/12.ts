/**
 * Host protocol 12: protocol 11 plus credential placements, cache reads beside an acquire and app
 * icons.
 *
 * An auth method may declare `request`: the only places the outbound network substitutes its secret
 * fields, whole header values and query parameters, each an exact template. An invocation's account
 * carries the placements granted to it. A cache `acquire` may name other keys to read in the same
 * transaction (`reads`). Requirements may declare the app's `icons`. Older bundles declare no
 * placements or icons and never send `reads`. Every other message is protocol 11's, re-exported
 * unchanged.
 *
 * Once released this protocol is frozen like the earlier ones: `bun run check` compares `protocol12`
 * with `packages/apps/protocols/12.json`. The module imports only `effect` and earlier protocol
 * modules, so no change elsewhere can alter it. Define the next protocol instead of editing this
 * file. See notes/apps-publishing.md.
 */
import { Schema } from "effect";
import { JsonObject } from "./1.ts";
import { OAuth2Config } from "./oauth-6.ts";
import { RouterIcon } from "./4.ts";
import { CredentialHost } from "./7.ts";
import {
  DeclaredRequirements as PreviousRequirements,
  HostInvocation as PreviousInvocation,
  ResolvedAccount as PreviousAccount,
  protocol11,
} from "./11.ts";

export * from "./11.ts";

/** A reference to one of the method's own account fields. */
export const PlacementField = Schema.Struct({ field: Schema.NonEmptyString });

/** Literal text or a field reference: what base64 may encode. Base64 never nests. */
export const PlacementText = Schema.Union([Schema.String, PlacementField]);

/** Base64 (RFC 4648, padded) of the UTF-8 bytes of its parts, such as Basic credentials. */
export const PlacementBase64 = Schema.Struct({
  base64: Schema.Array(PlacementText).check(Schema.isMinLength(1)),
});

/** One part of a value template. Parts concatenate. */
export const PlacementPart = Schema.Union([Schema.String, PlacementField, PlacementBase64]);

const template = Schema.Array(PlacementPart).check(Schema.isMinLength(1));

/** A lowercase HTTP header name (RFC 9110 token). */
export const PlacementHeaderName = Schema.String.check(
  Schema.isPattern(/^[!#$%&'*+.^_`|~0-9a-z-]+$/u),
);

/**
 * Where a credential may be sent and the exact value it is sent as. A header placement is the
 * header's whole value; a query placement is the whole value of the named query parameter.
 */
export const Placement = Schema.Union([
  Schema.Struct({ in: Schema.Literal("header"), name: PlacementHeaderName, value: template }),
  Schema.Struct({ in: Schema.Literal("query"), name: Schema.NonEmptyString, value: template }),
]);

/** An auth method's placements. */
export const Placements = Schema.Array(Placement);

/**
 * Field names an auth method exposes to app code, and where its secret fields may be sent. Every
 * other string field is secret.
 */
const exposure = {
  plain: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  raw: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  request: Schema.optionalKey(Placements),
};

/** Serializable authentication declarations interpreted by the trusted host. */
export const DeclaredAuthMethod = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("secrets"),
    label: Schema.String,
    fields: JsonObject,
    ...exposure,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[0].fields,
    response: JsonObject,
    ...exposure,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[1].fields,
    response: JsonObject,
    ...exposure,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[2].fields,
    response: JsonObject,
    ...exposure,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[3].fields,
    response: JsonObject,
    ...exposure,
  }),
]);

/** A credential-free provider declaration with the hosts its credentials may be sent to. */
export const DeclaredProvider = Schema.Struct({
  name: Schema.NonEmptyString,
  auth: Schema.Record(Schema.NonEmptyString, DeclaredAuthMethod),
  hosts: Schema.optionalKey(Schema.Array(CredentialHost)),
});
export type DeclaredProvider = typeof DeclaredProvider.Type;

const iconCharacters = 32 * 1024;

/** One image an app shows for itself: base64 image data or an HTTPS URL. */
const AppIcon = Schema.Struct({
  ...RouterIcon.fields,
  src: Schema.String.check(
    Schema.isPattern(
      /^(?:data:image\/(?:svg\+xml|png|webp|jpeg);base64,[A-Za-z0-9+/]*={0,2}|https:\/\/\S+)$/u,
    ),
    Schema.isMaxLength(iconCharacters),
  ),
});

/** An app's icons, bounded in number and total size. */
const AppIcons = Schema.Array(AppIcon).check(
  Schema.isMaxLength(8),
  Schema.makeFilter((icons) => JSON.stringify(icons).length <= iconCharacters, {
    message: `An app's icons total at most ${iconCharacters} characters`,
  }),
);

/**
 * Protocol 11's requirements, with providers that may declare placements. Requirements may declare
 * the app's icons, so a host shows them without evaluating the app.
 */
export const DeclaredRequirements = Schema.Struct({
  ...PreviousRequirements.fields,
  accounts: Schema.Record(
    Schema.NonEmptyString,
    Schema.Struct({
      definition: DeclaredProvider,
      cardinality: Schema.Literals(["one", "many"]),
      health: Schema.optionalKey(Schema.Literal(true)),
    }),
  ),
  icons: Schema.optionalKey(AppIcons),
});
export type DeclaredRequirements = typeof DeclaredRequirements.Type;

/**
 * Host-resolved credentials for one stable saved account. The provider carries the hosts and
 * placements granted to this account.
 */
export const ResolvedAccount = Schema.Struct({
  ...PreviousAccount.fields,
  provider: DeclaredProvider,
});
export type ResolvedAccount = typeof ResolvedAccount.Type;

/** Saved selections carrying protocol 12 provider declarations. */
export const ResolvedAccounts = Schema.Record(
  Schema.NonEmptyString,
  Schema.Union([ResolvedAccount, Schema.Array(ResolvedAccount)]),
);
export type ResolvedAccounts = typeof ResolvedAccounts.Type;

/** The JSON body the host sends to a bundle's generated server entry. */
export const HostInvocation = Schema.Struct({
  ...PreviousInvocation.fields,
  accounts: ResolvedAccounts,
});
export type HostInvocation = typeof HostInvocation.Type;

const Key = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Time = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const CacheEntry = Schema.Struct({
  value: Schema.Json,
  version: Schema.String,
  freshUntil: Time,
  staleUntil: Time,
});

/** Protocol 11's cache commands; an `acquire` may read other keys in the same transaction. */
export const CacheCommand = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("read"), keys: Schema.Array(Key) }),
  Schema.Struct({
    operation: Schema.Literal("acquire"),
    key: Key,
    refresh: Schema.Boolean,
    version: Schema.optionalKey(Schema.NullOr(Schema.String)),
    reads: Schema.optionalKey(Schema.Array(Key)),
  }),
  Schema.Struct({
    operation: Schema.Literal("claim"),
    key: Key,
    version: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    operation: Schema.Literal("publish"),
    key: Key,
    lease: Schema.String,
    entry: CacheEntry,
  }),
  Schema.Struct({ operation: Schema.Literal("release"), key: Key, lease: Schema.String }),
  Schema.Struct({ operation: Schema.Literal("renew"), key: Key, lease: Schema.String }),
  Schema.Struct({
    operation: Schema.Literal("write"),
    entries: Schema.Array(Schema.Struct({ key: Key, entry: CacheEntry })),
  }),
  Schema.Struct({ operation: Schema.Literal("invalidate"), key: Key }),
]);
export type CacheCommand = typeof CacheCommand.Type;

/** Every message of protocol 12, in the order its snapshot records them. */
export const protocol12 = {
  version: 12,
  schemas: {
    ...protocol11.schemas,
    requirements: DeclaredRequirements,
    accounts: ResolvedAccounts,
    invocation: HostInvocation,
    cacheCommand: CacheCommand,
  },
} as const;
