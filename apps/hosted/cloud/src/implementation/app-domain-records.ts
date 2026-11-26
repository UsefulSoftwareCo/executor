import { OrganizationId, OrganizationSlug } from "@executor-js/hosted-server/organization";
import { UiFailed } from "apps/ui/contracts";
import { Context, DateTime, Effect, Predicate, Schema } from "effect";
import { SqlClient, SqlError } from "effect/sql";

export const AppDomainStatus = Schema.Literals(["pending", "ready", "failed"]);

export const AppDomainRecord = Schema.Struct({
  organization_id: OrganizationId,
  slug: OrganizationSlug,
  status: AppDomainStatus,
  checked_at: Schema.Date,
});

export class AppDomainDatabase extends Context.Service<
  AppDomainDatabase,
  Effect.Effect<SqlClient.SqlClient, UiFailed>
>()("cloud/AppDomainDatabase") {}

export const migrateAppDomainRecords = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists cloud_app_domain (
    organization_id text primary key references organization(id) on delete cascade,
    slug text not null,
    status text not null check (status in ('pending', 'ready', 'failed')),
    checked_at timestamptz not null
  )`;
});

export const readAppDomainRecord = (organization: typeof OrganizationId.Type) =>
  Effect.gen(function* () {
    const sql = yield* Effect.flatten(AppDomainDatabase);
    const rows = yield* sql`select organization_id, slug, status, checked_at
      from cloud_app_domain where organization_id = ${organization}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AppDomainRecord))),
      Effect.mapError(() => new UiFailed({ reason: "unavailable" })),
    );
    return rows[0];
  });

export const writeAppDomainRecords = (
  records: ReadonlyArray<{
    readonly organization: typeof OrganizationId.Type;
    readonly slug: typeof OrganizationSlug.Type;
    readonly status: typeof AppDomainStatus.Type;
  }>,
  checkedAt: DateTime.Utc,
) =>
  Effect.gen(function* () {
    if (records.length === 0) return;
    const sql = yield* SqlClient.SqlClient;
    const observed = sql.csv(
      records.map((record) => sql`(${record.organization}, ${record.slug}, ${record.status})`),
    );
    yield* sql`insert into cloud_app_domain (organization_id, slug, status, checked_at)
      select observed.organization_id, observed.slug, observed.status,
        ${DateTime.toDateUtc(checkedAt)}::timestamptz
      from (values ${observed}) as observed(organization_id, slug, status)
      join organization on organization.id = observed.organization_id
      for key share of organization
      on conflict (organization_id) do update set
        slug = excluded.slug, status = excluded.status, checked_at = excluded.checked_at`;
  }).pipe(
    Effect.tapError((error) => Effect.annotateCurrentSpan(writeFailure(error.reason))),
    Effect.withSpan("app_domains.write", { attributes: { "app_domains.teams": records.length } }),
  );

const reported = (cause: unknown, field: "code" | "constraint") =>
  Predicate.hasProperty(cause, field) &&
  typeof cause[field] === "string" &&
  /^[A-Za-z0-9_]{1,63}$/.test(cause[field])
    ? cause[field]
    : undefined;

const writeFailure = (reason: SqlError.SqlError["reason"]) => {
  const code = reported(reason.cause, "code");
  const constraint = reported(reason.cause, "constraint");
  return {
    "app_domains.write.failure": reason._tag,
    ...(code === undefined ? {} : { "db.response.status_code": code }),
    ...(constraint === undefined ? {} : { "app_domains.write.constraint": constraint }),
  };
};
