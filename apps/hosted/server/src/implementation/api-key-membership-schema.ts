import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Bind native organization-pinned keys to the lifetime of their membership.
 * Run once under the hosted migration lock, after Better Auth creates its tables.
 * Full-account keys and keys whose membership still exists are preserved.
 */
export const migrateApiKeyMemberships = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create function hosted_require_api_key_membership() returns trigger
    language plpgsql as $$
    declare pinned_organization text;
    begin
      pinned_organization := new.metadata::jsonb ->> 'organization';
      if pinned_organization is not null then
        -- A concurrent removal waits for this key's insert to commit, then
        -- removes it in the same transaction as its membership.
        perform member.id from member join organization on organization.id = member."organizationId"
          where member."organizationId" = pinned_organization and member."userId" = new."referenceId"
          for key share of member, organization;
        if not found then
          raise exception 'Organization membership is required for this API key' using errcode = '23503';
        end if;
      end if;
      return new;
    end
    $$`;
  yield* sql`create trigger hosted_api_key_membership
    before insert or update of metadata, "referenceId" on apikey
    for each row execute function hosted_require_api_key_membership()`;
  yield* sql`create function hosted_revoke_member_api_keys() returns trigger
    language plpgsql as $$
    begin
      delete from apikey where "referenceId" = old."userId"
        and metadata::jsonb ->> 'organization' = old."organizationId";
      return old;
    end
    $$`;
  yield* sql`create trigger hosted_member_api_key_revocation
    after delete on member
    for each row execute function hosted_revoke_member_api_keys()`;
  // One-off repair for keys left behind by earlier membership/organization removals.
  // The trigger also runs when organization deletion cascades to its memberships.
  yield* sql`delete from apikey where metadata::jsonb ->> 'organization' is not null
    and not exists (
      select 1 from member join organization on organization.id = member."organizationId"
      where member."userId" = apikey."referenceId"
        and member."organizationId" = apikey.metadata::jsonb ->> 'organization'
    )`;
});
