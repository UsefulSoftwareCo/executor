/**
 * The import map (`private_v1_import_map`) and the v2 organizations an import writes into. Each
 * row records one v1 item's v2 resource, or why it failed; `(v1_kind, v1_id)` is unique.
 */
import { OrganizationId } from "@executor-js/hosted-server";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { V1ImportUnavailable } from "../../contracts/v1-import.ts";

/**
 * Map kinds: the item kinds, plus `organization`, `user` and `membership` (the v2 identity),
 * `fixed_credentials`, the account an integration's app holds its fixed credentials in (by the
 * integration, or for a connection's own app by the integration and the connection),
 * `connection_app`, a connection's own app when its integration became an app per connection
 * (decision 33, by the connection), and `profile`, which records a connection's link to its app
 * beside its account. `profile` keeps the name from when connections became profiles, so earlier
 * rows still read; see `mapLookup`. A toolkit has a row per member copy, keyed by the toolkit and
 * the member (`toolkitCopyKey`).
 */
export type MapKind =
  | "organization"
  | "user"
  | "membership"
  | "integration"
  | "connection_app"
  | "fixed_credentials"
  | "connection"
  | "profile"
  | "tool_policy"
  | "toolkit"
  | "artifact";

/**
 * The map id of one member's copy of a toolkit (decision 11): the v1 toolkit's row and the member's
 * WorkOS user id. Forwarded toolkit requests find the caller's copy by it (`v1-mcp-forward.ts`).
 */
export const toolkitCopyId = (toolkitRow: string, member: string) => `${toolkitRow}:${member}`;

/**
 * The id the import gives a member's copy of a toolkit in a v2 organization. Generation 0 is the
 * id v1 computes too when it forwards the toolkit's URL. A rollback leaves the copies it revoked
 * under their ids, which are never used again, so an import after it gives such a copy the next
 * generation's id (`importToolkit`). A copy the opt-in import made before copies were per member
 * keeps the id it got then (`adoptToolkitCopy`).
 */
export const toolkitCopyConnectionId = (
  organization: string,
  toolkitRow: string,
  member: string,
  generation: number,
) =>
  sourceHash(
    generation === 0
      ? [organization, toolkitRow, member]
      : [organization, toolkitRow, member, generation],
  ).pipe(Effect.map((hash) => `v1-${hash.slice(0, 40)}`));

export const MapRow = Schema.Struct({
  v1_kind: Schema.String,
  v1_id: Schema.String,
  v2_kind: Schema.NullOr(Schema.String),
  v2_id: Schema.NullOr(Schema.String),
  status: Schema.Literals(["imported", "failed", "skipped"]),
  /** Why it failed or was skipped; for an imported item, its note. */
  reason: Schema.NullOr(Schema.String),
  source_hash: Schema.String,
});
export type MapRow = typeof MapRow.Type;

export type MapResult =
  | {
      readonly status: "imported";
      readonly v2Kind: string;
      readonly v2Id: string;
      readonly note?: string | undefined;
    }
  | { readonly status: "failed" | "skipped"; readonly reason: string };

const Target = Schema.Struct({
  id: OrganizationId,
  name: Schema.String,
  slug: Schema.NonEmptyString,
});
const Owned = Schema.Array(Target);
const Since = Schema.Array(Schema.Struct({ removed: Schema.Boolean, changed: Schema.Boolean }));
const Ids = Schema.Array(Schema.Struct({ id: Schema.String }));

/** SHA-256 of the v1 rows an item was imported from, to skip it while they stay unchanged. */
export const sourceHash = (value: unknown) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
  ).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

const unavailable = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(() => new V1ImportUnavailable()));

export const makeImportStore = (sql: SqlClient.SqlClient) => {
  const rows = (organization: string) =>
    sql`
      select v1_kind, v1_id, v2_kind, v2_id, status, reason, source_hash
      from private_v1_import_map where v1_org_id = ${organization}
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(MapRow))), unavailable);
  const find = (kind: MapKind, id: string) =>
    sql`
      select v1_kind, v1_id, v2_kind, v2_id, status, reason, source_hash
      from private_v1_import_map where v1_kind = ${kind} and v1_id = ${id}
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(MapRow))),
      Effect.map((found) => found[0]),
      unavailable,
    );
  /** Record an attempt. A v1 item keeps one row; a later attempt replaces its result. */
  const record = (input: {
    readonly organization: string;
    readonly kind: MapKind;
    readonly id: string;
    readonly result: MapResult;
    readonly hash: string;
  }) => {
    const imported = input.result.status === "imported" ? input.result : undefined;
    const reason =
      input.result.status === "imported" ? (input.result.note ?? null) : input.result.reason;
    return sql`
      insert into private_v1_import_map
        (v1_org_id, v1_kind, v1_id, v2_kind, v2_id, status, reason, source_hash, updated_at)
      values (${input.organization}, ${input.kind}, ${input.id}, ${imported?.v2Kind ?? null},
        ${imported?.v2Id ?? null}, ${input.result.status}, ${reason}, ${input.hash}, now())
      on conflict (v1_kind, v1_id) do update set
        v2_kind = excluded.v2_kind, v2_id = excluded.v2_id, status = excluded.status,
        reason = excluded.reason, source_hash = excluded.source_hash, updated_at = now()
      where private_v1_import_map.v1_org_id = excluded.v1_org_id
    `.pipe(Effect.asVoid, unavailable);
  };
  /**
   * What became in v2, since its map row was written, of what an earlier run imported an item as:
   * `removed`, `changed` by its users (an app deployed again, or a toolkit's connection saved
   * again; the import records each after writing it), or `kept` as the import left it.
   */
  const sinceImported = (
    kind: "integration" | "connection_app" | "artifact" | "connection" | "toolkit",
    id: string,
  ) =>
    (kind === "connection"
      ? sql`
          select a.id is null as removed, false as changed from private_v1_import_map m
          left join executor_accounts a on a.id = m.v2_id
          where m.v1_kind = ${kind} and m.v1_id = ${id}
        `
      : kind === "toolkit"
        ? // Removing a connection in v2 revokes it and keeps its row.
          sql`
            select c.id is null or c.revoked as removed,
              coalesce(c."updatedAt" > m.updated_at, false) as changed
            from private_v1_import_map m left join "mcpConnection" c on c.id = m.v2_id
            where m.v1_kind = ${kind} and m.v1_id = ${id}
          `
        : sql`
            select a.id is null as removed, exists (
              select 1 from executor_deployments d
              where d.code = a.code and d.created_at > (m.updated_at at time zone 'UTC')
            ) as changed
            from private_v1_import_map m left join executor_apps a on a.id = m.v2_id
            where m.v1_kind = ${kind} and m.v1_id = ${id}
          `
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Since)),
      Effect.map(([found]) =>
        found === undefined || !(found.removed || found.changed)
          ? ("kept" as const)
          : found.removed
            ? ("removed" as const)
            : ("changed" as const),
      ),
      unavailable,
    );
  /**
   * Record under a member's key the copy of a toolkit the opt-in import made for them, which it
   * keyed by the toolkit alone (`toolkitCopyId`): its connection, result and the time it was
   * written, so a later save in v2 still reads as theirs. Whether the member has such a copy.
   */
  const adoptToolkitCopy = (input: {
    readonly organization: string;
    readonly toolkit: string;
    readonly member: string;
    readonly user: string;
  }) =>
    sql`
      insert into private_v1_import_map
        (v1_org_id, v1_kind, v1_id, v2_kind, v2_id, status, reason, source_hash, updated_at)
      select m.v1_org_id, m.v1_kind, ${toolkitCopyId(input.toolkit, input.member)}, m.v2_kind,
        m.v2_id, m.status, m.reason, m.source_hash, m.updated_at
      from private_v1_import_map m join "mcpConnection" c on c.id = m.v2_id
      where m.v1_kind = 'toolkit' and m.v1_id = ${input.toolkit}
        and m.v1_org_id = ${input.organization} and m.status = 'imported'
        and c."userId" = ${input.user}
      on conflict (v1_kind, v1_id) do nothing
      returning v2_id as id
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Ids)),
      Effect.map((adopted) => adopted.length > 0),
      unavailable,
    );
  /**
   * The versions of an integration's app that the import deployed itself, oldest first: those
   * made before its map row was last written, since the import records an app after deploying it.
   */
  const importedVersions = (integration: string) =>
    sql`
      select d.id from private_v1_import_map m
      join executor_apps a on a.id = m.v2_id
      join executor_deployments d on d.code = a.code
      where m.v1_kind = 'integration' and m.v1_id = ${integration}
        and d.created_at <= (m.updated_at at time zone 'UTC')
      order by d.created_at, d.id
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Ids)),
      Effect.map((found) => found.map((row) => row.id)),
      unavailable,
    );
  /**
   * The integrations of an organization whose imported app runs a version deployed after the
   * import recorded it: by its users, or by a repair.
   */
  const deployedSince = (organization: string) =>
    sql`
      select m.v1_id as id from private_v1_import_map m
      join executor_apps a on a.id = m.v2_id
      join executor_deployments d on d.id = a.active_deployment
      where m.v1_org_id = ${organization} and m.v1_kind = 'integration' and m.status = 'imported'
        and d.created_at > (m.updated_at at time zone 'UTC')
      order by m.v1_id
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Ids)),
      Effect.map((found) => new Set(found.map((row) => row.id))),
      unavailable,
    );
  /** Whether the import made this app for one of the organization's integrations. */
  const importedApp = (organization: string, app: string) =>
    sql`
      select m.v1_id as id from private_v1_import_map m
      where m.v1_org_id = ${organization} and m.v1_kind = 'integration' and m.status = 'imported'
        and m.v2_id = ${app}
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Ids)),
      Effect.map((found) => found.length > 0),
      unavailable,
    );
  const target = (id: string) =>
    sql`select id, name, slug from organization where id = ${id}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Owned)),
      Effect.map((found) => found[0]),
      unavailable,
    );
  /**
   * A new organization owned by the user, named after the v1 organization, at the first of
   * `candidates` no organization has, or none when every one is taken. Creating it queues the usual team, billing and default-app
   * jobs. The user's first organization also completes onboarding. With `hold`, the same
   * statement records the paid v1 subscription the organization's billing carries over from
   * (`billing.ts`), so v2's billing never finds the organization without it.
   */
  const createOrganization = (
    userId: string,
    name: string,
    candidates: readonly string[],
    hold: { readonly v1Organization: string; readonly subscription: string } | null,
  ) =>
    Effect.gen(function* () {
      for (const candidate of candidates) {
        const id = yield* Effect.sync(() => crypto.randomUUID());
        const memberId = yield* Effect.sync(() => crypto.randomUUID());
        // The unique slug arbitrates concurrent names; a collision writes nothing.
        const created = yield* sql`with created as (
          insert into organization (id, name, slug, logo, "createdAt")
            values (${id}, ${name}, ${candidate}, null, now())
            on conflict (slug) do nothing returning id, name, slug
        ), owner as (
          insert into member (id, "organizationId", "userId", role, "createdAt")
            select ${memberId}, created.id, ${userId}, 'owner', now() from created
            returning "organizationId"
        ), setup as (
          insert into cloud_organization_setup (user_id, organization_id, domain, applied)
            select ${userId}, owner."organizationId", null, true from owner
            on conflict (user_id) do nothing
        ), hold as (
          insert into private_v1_import_billing (organization_id, v1_org_id, state, subscription)
            select created.id, ${hold?.v1Organization ?? null}, 'held', ${hold?.subscription ?? null}::jsonb
            from created where ${hold !== null}
        ) select created.id, created.name, created.slug from created join owner
          on owner."organizationId" = created.id
        `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Owned)));
        if (created[0] !== undefined) return created[0];
      }
      return undefined;
    }).pipe(unavailable);
  /**
   * Hold the billing of an organization an earlier run made, which may have none: one the
   * opt-in import copied before its v1 subscription could carry over. A hold already there stays.
   */
  const holdBilling = (
    organization: string,
    hold: { readonly v1Organization: string; readonly subscription: string },
  ) =>
    sql`
      insert into private_v1_import_billing (organization_id, v1_org_id, state, subscription)
      values (${organization}, ${hold.v1Organization}, 'held', ${hold.subscription}::jsonb)
      on conflict (organization_id) do nothing
    `.pipe(Effect.asVoid, unavailable);
  /**
   * Rename a v2 organization from `from` to `to`, only while it still has `from`; whether it did.
   * A plain update of the slug, as a rename in v2's settings is: the update queues the team's app
   * domain again (`hosted_provision_team`).
   */
  const renameOrganization = (input: {
    readonly holder: string;
    readonly from: string;
    readonly to: string;
  }) =>
    sql`
      update organization set slug = ${input.to}
      where id = ${input.holder} and slug = ${input.from}
      returning id
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Ids)),
      Effect.map((renamed) => renamed.length === 1),
      unavailable,
    );
  return {
    rows,
    find,
    record,
    sinceImported,
    adoptToolkitCopy,
    importedVersions,
    deployedSince,
    importedApp,
    target,
    createOrganization,
    holdBilling,
    renameOrganization,
  };
};
export type ImportStore = ReturnType<typeof makeImportStore>;
