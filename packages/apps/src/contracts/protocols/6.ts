/**
 * Host protocol 6: protocol 5 plus an explicit authorization-server metadata URL on OAuth
 * discovery, in both requirements and resolved account bindings. Every other message is protocol
 * 5's, re-exported unchanged.
 *
 * Once released this protocol is frozen like the earlier ones: `bun run check` compares `protocol6`
 * with `packages/apps/protocols/6.json`. The module imports only `effect` and earlier protocol
 * modules, so no change elsewhere can alter it. Define the next protocol instead of editing this
 * file. See notes/apps-publishing.md.
 */
import { Schema } from "effect";
import { JsonObject } from "./1.ts";
import { OAuth2Config } from "./oauth-6.ts";
import {
  DeclaredRequirements as PreviousRequirements,
  ResolvedAccount as PreviousAccount,
  HostInvocation as PreviousInvocation,
  protocol5,
} from "./5.ts";

export * from "./5.ts";

/** Serializable authentication declarations interpreted by the trusted host. */
export const DeclaredAuthMethod = Schema.Union([
  Schema.Struct({ type: Schema.Literal("secrets"), label: Schema.String, fields: JsonObject }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[0].fields,
    response: JsonObject,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[1].fields,
    response: JsonObject,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[2].fields,
    response: JsonObject,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[3].fields,
    response: JsonObject,
  }),
]);

/** A credential-free provider declaration in protocol 6. */
export const DeclaredProvider = Schema.Struct({
  name: Schema.NonEmptyString,
  auth: Schema.Record(Schema.NonEmptyString, DeclaredAuthMethod),
});
export type DeclaredProvider = typeof DeclaredProvider.Type;

/** Account requirements retaining protocol 5's account checks and cardinality. */
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

/** Host-resolved credentials retain the same provider declaration as the requirement. */
export const ResolvedAccount = Schema.Struct({
  ...PreviousAccount.fields,
  provider: DeclaredProvider,
});
export type ResolvedAccount = typeof ResolvedAccount.Type;

/** Saved selections carrying protocol 6 provider declarations. */
export const ResolvedAccounts = Schema.Record(
  Schema.NonEmptyString,
  Schema.Union([ResolvedAccount, Schema.Array(ResolvedAccount)]),
);
export type ResolvedAccounts = typeof ResolvedAccounts.Type;

/** Invocation inputs retain metadata overrides when binding saved accounts. */
export const HostInvocation = Schema.Struct({
  ...PreviousInvocation.fields,
  accounts: ResolvedAccounts,
});
export type HostInvocation = typeof HostInvocation.Type;

/** Protocol 6 carries the metadata URL in requirements and resolved account bindings. */
export const protocol6 = {
  version: 6,
  schemas: {
    ...protocol5.schemas,
    requirements: DeclaredRequirements,
    accounts: ResolvedAccounts,
    invocation: HostInvocation,
  },
} as const;
