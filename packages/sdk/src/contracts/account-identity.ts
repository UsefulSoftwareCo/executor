/** A verified upstream identity shared by compatible account bindings at one placement. */
import { Schema } from "effect";
import { OwnerId, HttpUrl } from "./shared.ts";

export const AccountIdentityId = Schema.String.pipe(Schema.brand("AccountIdentityId"));
export type AccountIdentityId = typeof AccountIdentityId.Type;

/** Display metadata only. Tokens, subjects and placement authority stay host-owned. */
export const AccountIdentity = Schema.Struct({
  id: AccountIdentityId,
  issuer: HttpUrl,
  name: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
});
export type AccountIdentity = typeof AccountIdentity.Type;

/** Provenance is written only after the authorization server authenticates the token's subject. */
export const StoredAccountIdentity = Schema.Struct({
  ...AccountIdentity.fields,
  owner: OwnerId,
  placement: Schema.NonEmptyString,
  issuer: HttpUrl,
  subject: Schema.NonEmptyString,
  verifiedAt: Schema.Date,
  createdAt: Schema.Date,
});
export type StoredAccountIdentity = typeof StoredAccountIdentity.Type;
