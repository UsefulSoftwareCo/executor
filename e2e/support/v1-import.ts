/**
 * The v1 import's operator routes on a managed local Cloud, called as an operator does: with the
 * bearer token the Cloud was started with (`v1-import-operator.json`), never a user session.
 */
import { randomUUID } from "node:crypto";
import { Effect, FileSystem, Schedule, Schema } from "effect";
import { heldValue } from "./failure-text.ts";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { writeRows, type RowStatement } from "./cloud-rows.ts";
import { Target } from "./platform.ts";

const Operator = Schema.Struct({ token: heldValue(Schema.String) });

/** An item skipped because v1 cannot run it either. */
const StaleItem = Schema.Struct({
  kind: Schema.String,
  id: Schema.String,
  label: Schema.String,
  integration: Schema.NullOr(Schema.String),
  category: Schema.String,
  reason: Schema.String,
});
const DroppedCredential = Schema.Struct({
  integration: Schema.String,
  carrier: Schema.String,
  name: Schema.String,
  reason: Schema.String,
});
const MemberSecretMismatch = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  integration: Schema.String,
  members: Schema.Number,
  values: Schema.Number,
});

/** The report fields scenarios read. Reports hold more; these are what they assert. */
export const V1Report = Schema.Struct({
  organization: Schema.String,
  runId: Schema.String,
  mode: Schema.String,
  status: Schema.String,
  reason: Schema.NullOr(Schema.String),
  counts: Schema.Struct({
    v1: Schema.Record(Schema.String, Schema.Number),
    v2: Schema.Record(Schema.String, Schema.Number),
  }),
  emailMatches: Schema.Array(Schema.Struct({ email: Schema.String, match: Schema.String })),
  skippedMembers: Schema.Array(Schema.Struct({ user: Schema.String, reason: Schema.String })),
  slug: Schema.NullOr(
    Schema.Struct({
      v1: Schema.String,
      v2: Schema.NullOr(Schema.String),
      changed: Schema.Boolean,
      displaced: Schema.optionalKey(
        Schema.Struct({
          organization: Schema.String,
          slug: Schema.NullOr(Schema.String),
          reason: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
  into: Schema.optionalKey(
    Schema.Struct({
      organization: Schema.String,
      mode: Schema.NullOr(Schema.String),
      refused: Schema.optionalKey(Schema.String),
    }),
  ),
  integrationFailures: Schema.Array(
    Schema.Struct({ id: Schema.String, label: Schema.String, error: Schema.String }),
  ),
  droppedTraceTools: Schema.Array(
    Schema.Struct({ integration: Schema.String, tools: Schema.Array(Schema.String) }),
  ),
  connectionFailures: Schema.Array(
    Schema.Struct({
      reason: Schema.String,
      reconnect: Schema.optional(Schema.Literal(true)),
      connections: Schema.Array(
        Schema.Struct({ id: Schema.String, label: Schema.String, integration: Schema.String }),
      ),
    }),
  ),
  firstPartyMismatches: Schema.Array(
    Schema.Struct({ client: Schema.String, reason: Schema.String, connections: Schema.Number }),
  ),
  unmatchedRules: Schema.Array(
    Schema.Struct({ id: Schema.String, pattern: Schema.String, action: Schema.String }),
  ),
  staleItems: Schema.Array(StaleItem),
  droppedCredentials: Schema.Array(DroppedCredential),
  memberSecretMismatches: Schema.Array(MemberSecretMismatch),
  orgApiKeys: Schema.Unknown,
  artifacts: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      unmappedRoles: Schema.Array(Schema.Struct({ role: Schema.String, problem: Schema.String })),
      error: Schema.optionalKey(Schema.String),
    }),
  ),
  flags: Schema.Struct({
    sso: Schema.NullOr(Schema.Boolean),
    overFreeMemberLimit: Schema.Boolean,
    paidPlans: Schema.Array(Schema.String),
  }),
  vaultFailures: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      integration: Schema.String,
      reason: Schema.String,
    }),
  ),
  /** Integrations that move as an app per connection, with each connection's app. */
  splitIntegrations: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        apps: Schema.Array(
          Schema.Struct({
            connection: Schema.String,
            label: Schema.String,
            owner: Schema.String,
            name: Schema.String,
            status: Schema.String,
            v2Id: Schema.optionalKey(Schema.String),
            reason: Schema.optionalKey(Schema.String),
            rules: Schema.optionalKey(
              Schema.Struct({
                omitted: Schema.Number,
                always: Schema.Number,
                never: Schema.Number,
                otherwise: Schema.NullOr(Schema.String),
              }),
            ),
          }),
        ),
      }),
    ),
  ),
  billing: Schema.optionalKey(
    Schema.Struct({
      subscription: Schema.NullOr(
        Schema.Struct({
          plan: Schema.String,
          version: Schema.Number,
          pricing: Schema.String,
          v2Pricing: Schema.String,
          trialing: Schema.Boolean,
          cancelling: Schema.Boolean,
        }),
      ),
      problem: Schema.NullOr(Schema.String),
      carried: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  v2Organization: Schema.optionalKey(Schema.Struct({ id: Schema.String, slug: Schema.String })),
  verification: Schema.optionalKey(
    Schema.Struct({
      items: Schema.Struct({
        planned: Schema.Number,
        withResult: Schema.Number,
        failed: Schema.Number,
      }),
      members: Schema.Struct({ planned: Schema.Number, inV2: Schema.Number }),
      accounts: Schema.Struct({ checked: Schema.Number, unreadable: Schema.Number }),
      apps: Schema.Struct({ checked: Schema.Number, withoutVersion: Schema.Number }),
      passed: Schema.Boolean,
    }),
  ),
  cutover: Schema.optionalKey(Schema.Boolean),
  items: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        id: Schema.String,
        label: Schema.String,
        context: Schema.NullOr(Schema.String),
        status: Schema.String,
        v2Id: Schema.optionalKey(Schema.String),
        reason: Schema.optionalKey(Schema.String),
        note: Schema.optionalKey(Schema.String),
        needsRepair: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
});
export type V1Report = typeof V1Report.Type;

const ReportResponse = Schema.Struct({
  report: Schema.NullOr(Schema.Unknown),
  instances: Schema.Struct({ dryRun: Schema.String, import: Schema.String }),
});

export const Aggregate = Schema.Struct({
  runId: Schema.String,
  complete: Schema.Boolean,
  organizations: Schema.Number,
  pending: Schema.Array(Schema.String),
  errored: Schema.Array(
    Schema.Struct({ organization: Schema.String, instance: Schema.String, status: Schema.String }),
  ),
  statuses: Schema.Record(Schema.String, Schema.Number),
  blocked: Schema.Array(Schema.String),
  integrationFailures: Schema.Array(
    Schema.Struct({
      organization: Schema.String,
      entry: Schema.Struct({ id: Schema.String, label: Schema.String, error: Schema.String }),
    }),
  ),
  heldBack: Schema.Array(
    Schema.Struct({ organization: Schema.String, reason: Schema.NullOr(Schema.String) }),
  ),
  staleItems: Schema.Struct({
    byCategory: Schema.Record(Schema.String, Schema.Number),
    items: Schema.Array(Schema.Struct({ organization: Schema.String, entry: StaleItem })),
  }),
  droppedCredentials: Schema.Array(
    Schema.Struct({ organization: Schema.String, entry: DroppedCredential }),
  ),
  memberSecretMismatches: Schema.Array(
    Schema.Struct({ organization: Schema.String, entry: MemberSecretMismatch }),
  ),
});

/** One aggregation request's answer: the next page's cursor, or the finished aggregate. */
const AggregatePage = Schema.Union([
  Schema.Struct({ cursor: Schema.String, organizations: Schema.Number }),
  Schema.Struct({ cursor: Schema.Null, aggregate: Aggregate }),
]);

/**
 * Allow these v1 organizations to be imported, as a person with database access does: a row each
 * in Cloud's `private_v1_import_allowed`, which no route writes. An import of an organization
 * without a row is refused.
 */
export const allowV1Import = (...organizations: readonly string[]) =>
  writeRows("sso-database.json", organizations.map(allowV1ImportRow)).pipe(Effect.asVoid);

/** {@link allowV1Import}'s statement, for a scenario that writes it with others. */
export const allowV1ImportRow = (organization: string): RowStatement => ({
  sql: "insert into private_v1_import_allowed (v1_org_id, note) values ($1, 'E2E scenario') on conflict (v1_org_id) do nothing",
  params: [organization],
});

/**
 * List the v2 organization an import of this v1 organization may rename to take its slug, as a
 * person with database access does: the allow table row's `displace_v2_org_id`.
 */
export const listV1SlugDisplacement = (organization: string, holder: string) =>
  writeRows("sso-database.json", [
    {
      sql: "update private_v1_import_allowed set displace_v2_org_id = $2 where v1_org_id = $1",
      params: [organization, holder],
    },
  ]).pipe(Effect.asVoid);

/**
 * List the existing v2 organization an import of this v1 organization moves into instead of a new
 * one, and how, as a person with database access does: the allow table row's `into_v2_org_id` and
 * `into_mode`, which the import reads as `nothing_to_copy` when unset.
 */
export const listV1Into = (organization: string, target: string, mode?: string) =>
  writeRows("sso-database.json", [listV1IntoRow(organization, target, mode)]).pipe(Effect.asVoid);

/** {@link listV1Into}'s statement, after its organization's {@link allowV1ImportRow}. */
export const listV1IntoRow = (
  organization: string,
  target: string,
  mode?: string,
): RowStatement => ({
  sql: "update private_v1_import_allowed set into_v2_org_id = $2, into_mode = nullif($3, '') where v1_org_id = $1",
  params: [organization, target, mode ?? ""],
});

/** A run id no other scenario uses. */
export const v1RunId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

export const v1ImportOperator = Effect.gen(function* () {
  const target = yield* Target;
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const { token } = yield* fs
    .readFileString(`${target.directory}/v1-import-operator.json`)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Operator))));
  const origin = target.metadata.origin;
  /** A request to the routes with any authorization, or none, and its status and body. */
  const send = (
    method: "GET" | "POST",
    path: string,
    options: { readonly body?: unknown; readonly authorization?: string | undefined } = {},
  ) =>
    Effect.gen(function* () {
      let request = HttpClientRequest.make(method)(`${origin}${path}`);
      if (options.authorization !== undefined)
        request = HttpClientRequest.setHeader(request, "authorization", options.authorization);
      if (options.body !== undefined)
        request = yield* HttpClientRequest.bodyJson(request, options.body);
      const response = yield* http.execute(request);
      const text = yield* response.text;
      return {
        status: response.status,
        body: text === "" ? null : (JSON.parse(text) as unknown),
      };
    });
  const operator = `Bearer ${token}`;
  const report = (run: string, organization: string) =>
    send("GET", `/api/internal/v1-import/runs/${run}/orgs/${organization}`, {
      authorization: operator,
    }).pipe(
      Effect.flatMap((response) => Schema.decodeUnknownEffect(ReportResponse)(response.body)),
    );
  return {
    send,
    /**
     * Start a run over these organizations, at most `maxInFlight` running at once across every
     * run of this Cloud. The default, 100, leaves room beside other scenarios' runs; only a
     * scenario on its own Cloud can assert the bound.
     */
    start: (input: {
      readonly mode: "dry-run" | "import";
      readonly runId: string;
      readonly organizations?: readonly string[];
      readonly after?: string;
      readonly limit?: number;
      readonly maxInFlight?: number;
    }) =>
      send("POST", "/api/internal/v1-import/start", {
        body: { maxInFlight: 100, ...input },
        authorization: operator,
      }),
    /** Repair a moved organization (`repair.ts`), or only plan it when `apply` is false. */
    repair: (organization: string, apply: boolean) =>
      send("POST", `/api/internal/v1-import/orgs/${organization}/repair`, {
        body: { apply },
        authorization: operator,
      }),
    /**
     * Run an earlier version of one of a moved organization's imported apps again, while it still
     * runs `expected` (`restoreApp`).
     */
    restore: (
      organization: string,
      body: { readonly app: string; readonly version: string; readonly expected: string },
    ) =>
      send("POST", `/api/internal/v1-import/orgs/${organization}/restore`, {
        body,
        authorization: operator,
      }),
    /** The organization's report once its run has written it. */
    waitForReport: (run: string, organization: string) =>
      report(run, organization).pipe(
        Effect.flatMap((response) =>
          response.report === null
            ? Effect.fail(
                new Error(
                  `No report yet (instances: ${response.instances.dryRun} / ${response.instances.import})`,
                ),
              )
            : Schema.decodeUnknownEffect(V1Report)(response.report),
        ),
        Effect.retry(Schedule.spaced("500 millis").pipe(Schedule.upTo({ duration: "50 seconds" }))),
      ),
    /** Give a paid organization's subscription back to v1, as the operator command does. */
    returnBilling: (organization: string) =>
      send("POST", `/api/internal/v1-import/orgs/${organization}/return-billing`, {
        authorization: operator,
      }),
    /** Give an organization back to v1, as the operator command's `rollback` does. */
    rollback: (organization: string) =>
      send("POST", `/api/internal/v1-import/orgs/${organization}/rollback`, {
        authorization: operator,
      }),
    instances: (run: string, organization: string) =>
      report(run, organization).pipe(Effect.map((response) => response.instances)),
    /** One aggregation request, as sent: its status and body. */
    aggregatePage: (run: string, query: { readonly cursor?: string; readonly limit?: number }) =>
      send(
        "POST",
        `/api/internal/v1-import/runs/${run}/aggregate?${new URLSearchParams(
          Object.entries(query).map(([key, value]) => [key, String(value)]),
        ).toString()}`,
        { authorization: operator },
      ),
    /**
     * The run's aggregate, requesting page after page as the operator command does, with at most
     * `limit` organizations a page; also how many pages it took.
     */
    aggregate: (run: string, limit?: number) =>
      Effect.gen(function* () {
        let cursor: string | undefined;
        for (let pages = 1; ; pages++) {
          const response = yield* send(
            "POST",
            `/api/internal/v1-import/runs/${run}/aggregate?${new URLSearchParams({
              ...(cursor === undefined ? {} : { cursor }),
              ...(limit === undefined ? {} : { limit: String(limit) }),
            }).toString()}`,
            { authorization: operator },
          );
          const page = yield* Schema.decodeUnknownEffect(AggregatePage)(response.body);
          if (page.cursor === null) return { ...page.aggregate, pages };
          cursor = page.cursor;
        }
      }),
  };
}).pipe(Effect.provide(FetchHttpClient.layer));
