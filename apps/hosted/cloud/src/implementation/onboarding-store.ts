import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { fumadb } from "fumadb-effect";
import { column, idColumn, schema, table } from "fumadb-effect/schema";
import { sqlAdapter } from "fumadb-effect/sql";
import {
  CompanyProfile,
  OnboardingReady,
  OnboardingUnavailable,
  type TeamDetails,
} from "../contracts/onboarding.ts";

const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  emailVerified: Schema.Boolean,
  image: Schema.NullOr(Schema.String),
});
const EntryState = Schema.Struct({
  organizations: OnboardingReady.fields.organizations,
  invitation: Schema.NullOr(Schema.String),
  provisioned: Schema.Boolean,
});

// Query mappings only. Better Auth owns its table; the cloud migration owns the
// existing company table. Reading these mappings does not run either migrator.
const onboardingSchema = schema({
  version: "1.0.0",
  tables: {
    users: table("user", {
      id: idColumn("id", Schema.String, { type: "varchar(255)" }),
      name: column("name", Schema.String),
      email: column("email", Schema.String),
      emailVerified: column("emailVerified", Schema.Boolean),
      image: column("image", Schema.NullOr(Schema.String)),
    }),
    companies: table("cloud_company_profile", {
      domain: idColumn("domain", Schema.String, { type: "varchar(255)" }),
      status: column("status", Schema.Literals(["pending", "ready", "unavailable"])),
      profile: column("profile", Schema.NullOr(Schema.String)),
      attempts: column("attempts", Schema.Int),
      lease: column("lease", Schema.NullOr(Schema.String)),
      retryAt: column("retry_at", Schema.Date),
    }),
  },
});
const storage = fumadb({ namespace: "cloud-onboarding", schemas: [onboardingSchema] });

/** Typed reads and cache writes; PostgreSQL-specific locking and batching stay at this boundary. */
export const makeOnboardingStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const provide = <A, E>(operation: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    operation.pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const db = storage.client(sqlAdapter({ provider: "postgresql" })).orm("1.0.0");
  const user = (id: string) =>
    db.findFirst("users", { where: (b) => b("id", "=", id) }).pipe(provide);
  const lockUser = (id: string) =>
    sql`
    select id, name, email, "emailVerified", image from "user" where id = ${id} for update
  `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(User))),
      Effect.map((rows) => rows[0]),
    );
  // This statement must follow the user lock so a waiting request sees the
  // previous transaction's committed membership under READ COMMITTED.
  const state = (id: string, email: string) =>
    sql`select
    coalesce((select jsonb_agg(jsonb_build_object(
      'id', o.id, 'name', o.name, 'slug', o.slug, 'logo', o.logo
    ) order by o."createdAt", o.id) from organization o join member m on m."organizationId" = o.id
      where m."userId" = ${id}), '[]'::jsonb) as organizations,
    (select id from invitation where lower(email) = lower(${email}) and status = 'pending'
      and "expiresAt" > now() order by "expiresAt", id limit 1) as invitation,
    (exists(select 1 from cloud_organization_setup where user_id = ${id})
      or exists(select 1 from invitation where lower(email) = lower(${email}) and status = 'accepted')) as provisioned
  `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(EntryState))),
      Effect.flatMap((rows) =>
        rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new OnboardingUnavailable()),
      ),
    );

  const create = (userId: string, details: TeamDetails, slug: string) =>
    Effect.gen(function* () {
      const id = yield* Effect.sync(() => crypto.randomUUID());
      const memberId = yield* Effect.sync(() => crypto.randomUUID());
      // No preflight slug read: the unique constraint arbitrates concurrent names.
      // A collision writes none of the three records, allowing a suffix retry.
      return yield* sql`with created as (
      insert into organization (id, name, slug, logo, "createdAt")
        values (${id}, ${details.name}, ${slug}, ${details.logo}, now())
        on conflict (slug) do nothing returning id, name, slug, logo
    ), owner as (
      insert into member (id, "organizationId", "userId", role, "createdAt")
        select ${memberId}, created.id, ${userId}, 'owner', now() from created returning "organizationId"
    ), setup as (
      insert into cloud_organization_setup (user_id, organization_id, domain, applied)
        select ${userId}, owner."organizationId", null, true from owner returning organization_id
    ) select created.id, created.name, created.slug, created.logo
      from created join setup on setup.organization_id = created.id
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(OnboardingReady.fields.organizations)));
    });
  const company = (domain: string) =>
    db.findFirst("companies", { where: (b) => b("domain", "=", domain) }).pipe(provide);
  const claimCompany = (domain: string, lease: string) =>
    sql`
    insert into cloud_company_profile (domain, lease, attempts, retry_at)
      values (${domain}, ${lease}, 1, now() + interval '30 seconds')
    on conflict (domain) do update set lease = excluded.lease,
      attempts = cloud_company_profile.attempts + 1, retry_at = excluded.retry_at
      where cloud_company_profile.status = 'pending' and cloud_company_profile.retry_at <= now()
    returning domain
  `.pipe(Effect.map((rows) => rows.length === 1));
  const saveCompany = (domain: string, lease: string, profile: CompanyProfile | null) =>
    db
      .updateMany("companies", {
        where: (b) => b.and(b("domain", "=", domain), b("lease", "=", lease)),
        set: {
          status: profile === null ? "unavailable" : "ready",
          profile: profile === null ? null : JSON.stringify(profile),
          lease: null,
        },
      })
      .pipe(provide);
  const releaseCompany = (domain: string, lease: string) =>
    Effect.gen(function* () {
      const retryAt = new Date((yield* Clock.currentTimeMillis) + 60_000);
      yield* db.updateMany("companies", {
        where: (b) => b.and(b("domain", "=", domain), b("lease", "=", lease)),
        set: { lease: null, retryAt },
      });
    }).pipe(provide);
  const canReadIcon = (userId: string, owner: string, logo: string) =>
    sql`select exists(
    select 1 from cloud_organization_setup s
      join organization o on o.id = s.organization_id
      join member m on m."organizationId" = o.id
      where s.user_id = ${owner} and m."userId" = ${userId} and o.logo = ${logo}
  ) as allowed`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ allowed: Schema.Boolean }))),
      ),
      Effect.flatMap((rows) =>
        rows[0] ? Effect.succeed(rows[0].allowed) : Effect.fail(new OnboardingUnavailable()),
      ),
    );
  return {
    canReadIcon,
    user,
    lockUser,
    state,
    create,
    company,
    claimCompany,
    saveCompany,
    releaseCompany,
    transaction: sql.withTransaction,
  };
});
