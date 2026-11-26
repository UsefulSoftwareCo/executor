import { AuthenticationUnavailable, type UnknownApiKeys } from "@executor-js/hosted-server";
import { migrationFailed } from "@executor-js/hosted-server/migrations";
import { annotateRequestSpan } from "@executor-js/telemetry/http";
import { Clock, Effect, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { SqlClient } from "effect/sql";

export const migrateV1CapturedApiKeys = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists private_v1_captured_api_key (
    workos_key_id text primary key,
    apikey_id text not null,
    v1_org_id text not null,
    v1_owner text not null,
    v2_user_id text not null,
    v2_org_id text not null,
    captured_at timestamptz not null default now()
  )`;
}).pipe(Effect.mapError(migrationFailed("product")));

export interface V1WorkOSKeys {
  readonly baseUrl: string;
  readonly key: Redacted.Redacted<string>;
}

const workosPrefix = "sk_";
const refusalMillis = 5 * 60_000;
const refusalLimit = 10_000;
const lookupBurst = 20;
const lookupsPerSecond = 5;
const lookupTimeout = "5 seconds";

const Validation = Schema.Struct({
  api_key: Schema.NullOr(
    Schema.Struct({
      id: Schema.NonEmptyString,
      owner: Schema.Union([
        Schema.Struct({
          type: Schema.Literal("user"),
          id: Schema.NonEmptyString,
          organization_id: Schema.NonEmptyString,
        }),
        Schema.Struct({ type: Schema.Literal("organization"), id: Schema.NonEmptyString }),
      ]),
    }),
  ),
});

const Stored = Schema.Array(
  Schema.Struct({
    known: Schema.Boolean,
    moved: Schema.Boolean,
    mapped: Schema.Boolean,
    member: Schema.Boolean,
    captured: Schema.Boolean,
  }),
);

type Outcome =
  | { readonly outcome: "captured" }
  | {
      readonly outcome: "validated_uncaptured";
      readonly reason: "known" | "unmoved" | "unmapped" | "not_member";
    }
  | { readonly outcome: "refused" | "refused_cached" | "limited" | "unavailable" };

const record = (result: Outcome) =>
  annotateRequestSpan({
    "executor.v1_api_key.outcome": result.outcome,
    ...("reason" in result ? { "executor.v1_api_key.reason": result.reason } : {}),
  });

const keyHash = (token: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).pipe(
    Effect.map((digest) => {
      let binary = "";
      for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
      return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    }),
  );

const capturedKeyName = "Imported from Executor v1";

const store = (
  hash: string,
  key: {
    readonly id: string;
    readonly organization: string;
    readonly owner: { readonly kind: "user" | "organization"; readonly id: string };
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = crypto.randomUUID();
    const rows = yield* sql`
      with known as (
        select 1 from private_v1_captured_api_key where workos_key_id = ${key.id}
      ), org as (
        select v2_org_id from private_v1_legacy_org where v1_org_id = ${key.organization}
      ), owner as (
        select user_id from (
          select u.v2_id as user_id from private_v1_import_map u
          where ${key.owner.kind} = 'user' and u.v1_kind = 'user' and u.v1_id = ${key.owner.id}
            and u.status = 'imported' and u.v2_id is not null
          union all
          select m."userId" from member m join org on m."organizationId" = org.v2_org_id
          where ${key.owner.kind} = 'organization' and m.role = 'owner'
        ) found limit 1
      ), eligible as (
        select owner.user_id, org.v2_org_id from owner, org
        where exists (
          select 1 from member m
          where m."userId" = owner.user_id and m."organizationId" = org.v2_org_id)
      ), recorded as (
        insert into private_v1_captured_api_key
          (workos_key_id, apikey_id, v1_org_id, v1_owner, v2_user_id, v2_org_id)
        select ${key.id}, ${id}, ${key.organization}, ${key.owner.id}, user_id, v2_org_id
        from eligible
        where not exists (select 1 from known)
          and not exists (select 1 from apikey where key = ${hash})
        on conflict (workos_key_id) do nothing
        returning v2_user_id, v2_org_id
      ), stored as (
        insert into apikey (id, "configId", name, prefix, start, key, "referenceId", enabled,
          "rateLimitEnabled", "rateLimitTimeWindow", "rateLimitMax", "requestCount", "createdAt",
          "updatedAt", metadata)
        select ${id}, 'default', ${capturedKeyName}, ${workosPrefix}, null, ${hash}, v2_user_id,
          true, false, 86400000, 10, 0, now(), now(),
          jsonb_build_object('organization', v2_org_id)::text
        from recorded
        returning id
      )
      select exists (select 1 from known) as known,
        exists (select 1 from org) as moved,
        exists (select 1 from owner) as mapped,
        exists (select 1 from eligible) as member,
        exists (select 1 from stored) as captured`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Stored)),
    );
    const row = rows[0];
    if (row === undefined) return yield* Effect.fail(new AuthenticationUnavailable());
    if (row.captured) return { outcome: "captured" } satisfies Outcome;
    const reason = row.known
      ? "known"
      : !row.moved
        ? "unmoved"
        : !row.mapped
          ? "unmapped"
          : !row.member
            ? "not_member"
            : "known";
    return { outcome: "validated_uncaptured", reason } satisfies Outcome;
  });

export const v1CapturedApiKeys = (
  workos: Option.Option<V1WorkOSKeys>,
): UnknownApiKeys | undefined => {
  if (Option.isNone(workos)) return undefined;
  const settings = workos.value;
  const refusals = new Map<string, number>();
  let tokens = lookupBurst;
  let refilled = 0;
  const refuse = (hash: string, now: number) => {
    refusals.delete(hash);
    refusals.set(hash, now + refusalMillis);
    if (refusals.size > refusalLimit) {
      const oldest = refusals.keys().next();
      if (oldest.done !== true) refusals.delete(oldest.value);
    }
  };
  const lookup = (token: Redacted.Redacted<string>) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post(`${settings.baseUrl}/api_keys/validations`).pipe(
          HttpClientRequest.bearerToken(settings.key),
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJsonUnsafe({ value: Redacted.value(token) }),
        ),
      );
      if (response.status !== 200) return Option.none();
      return Option.some(
        yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Validation))),
      );
    }).pipe(
      Effect.timeout(lookupTimeout),
      Effect.provide(FetchHttpClient.layer),
      Effect.catchCause(() => Effect.succeed(Option.none())),
    );
  return {
    store: (token) =>
      Effect.gen(function* () {
        if (!Redacted.value(token).startsWith(workosPrefix)) return false;
        const hash = yield* keyHash(Redacted.value(token));
        const now = yield* Clock.currentTimeMillis;
        const until = refusals.get(hash);
        if (until !== undefined && until > now) {
          yield* record({ outcome: "refused_cached" });
          return false;
        }
        tokens = Math.min(lookupBurst, tokens + ((now - refilled) / 1000) * lookupsPerSecond);
        refilled = now;
        if (tokens < 1) {
          yield* record({ outcome: "limited" });
          return yield* Effect.fail(new AuthenticationUnavailable());
        }
        tokens -= 1;
        const answer = yield* lookup(token);
        if (Option.isNone(answer)) {
          yield* record({ outcome: "unavailable" });
          return yield* Effect.fail(new AuthenticationUnavailable());
        }
        const validated = answer.value.api_key;
        if (validated === null) {
          refuse(hash, now);
          yield* record({ outcome: "refused" });
          return false;
        }
        const owner = validated.owner;
        const result = yield* store(hash, {
          id: validated.id,
          organization: owner.type === "user" ? owner.organization_id : owner.id,
          owner: { kind: owner.type, id: owner.id },
        }).pipe(
          Effect.catchTags({
            SqlError: () => Effect.fail(new AuthenticationUnavailable()),
            SchemaError: () => Effect.fail(new AuthenticationUnavailable()),
          }),
        );
        yield* record(result);
        if (result.outcome !== "captured") refuse(hash, now);
        return result.outcome === "captured" || result.reason === "known";
      }).pipe(Effect.withSpan("auth.v1ApiKey")),
  };
};
