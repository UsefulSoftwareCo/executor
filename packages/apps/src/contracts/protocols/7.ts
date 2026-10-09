/**
 * Host protocol 7: protocol 6 plus credential hosts and field exposure.
 *
 * A provider may declare the hosts its credentials are sent to, and each auth method may mark
 * fields `plain` (not secret) or `raw` (secret, but readable by app code). A provider that
 * declares hosts receives its other string fields as sealed handles, which the host's outbound
 * network replaces with the real values only on requests to those hosts. The markers are part of
 * the provider's identity; hosts are not. In an invocation, an account's provider carries the
 * hosts granted to that account, which can be narrower than the app's declaration. Every other
 * message is protocol 6's, re-exported unchanged.
 *
 * Once released this protocol is frozen like the earlier ones: `bun run check` compares `protocol7` with
 * `packages/apps/protocols/7.json`. The module imports only `effect` and earlier protocol modules,
 * so no change elsewhere can alter it. Define the next protocol instead of editing this file.
 * See notes/apps-publishing.md.
 */
import { Schema } from "effect";
import { JsonObject } from "./1.ts";
import { OAuth2Config } from "./oauth-6.ts";
import {
  DeclaredRequirements as PreviousRequirements,
  ResolvedAccount as PreviousAccount,
  HostInvocation as PreviousInvocation,
  protocol6,
} from "./6.ts";

export * from "./6.ts";

/**
 * Where a provider's credentials may be sent: an exact host, `host:port`, or `*.` followed by a
 * domain, matching exactly one more label. Lowercase, without a scheme or path.
 */
export const CredentialHost = Schema.String.check(
  Schema.isPattern(
    /^(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[0-9]{1,5})?$/,
  ),
);

/** Field names an auth method exposes to app code. Every other string field is secret. */
const exposure = {
  /** Not secret: app code reads the real value and forms show it. */
  plain: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  /** Secret, but app code reads the real value, for signing and similar uses. */
  raw: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
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

/** Account requirements retaining protocol 6's checks and cardinality. */
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
});
export type DeclaredRequirements = typeof DeclaredRequirements.Type;

/**
 * Host-resolved credentials for one stable saved account. When the provider declares hosts, its
 * secret string fields are sealed handles, not values.
 */
export const ResolvedAccount = Schema.Struct({
  ...PreviousAccount.fields,
  provider: DeclaredProvider,
});
export type ResolvedAccount = typeof ResolvedAccount.Type;

/** Saved selections carrying protocol 7 provider declarations. */
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

/** Every message of protocol 7, in the order its snapshot records them. */
export const protocol7 = {
  version: 7,
  schemas: {
    ...protocol6.schemas,
    requirements: DeclaredRequirements,
    accounts: ResolvedAccounts,
    invocation: HostInvocation,
  },
} as const;
