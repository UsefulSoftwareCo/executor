/**
 * The server-side v1 move (`notes/v1-import.md`): one `V1Import` Workflow instance per v1
 * organization, started in batches by an operator, never by a user. A dry run reads v1 and v2 and
 * writes only its report; an import also writes v2.
 */
import { Schema } from "effect";
import { V1OrganizationId } from "./v1-import.ts";

/** `dry-run` writes nothing but its report; `import` writes v2 too. */
export const V1ImportMode = Schema.Literals(["dry-run", "import"]);
export type V1ImportMode = typeof V1ImportMode.Type;

/** Names one pass over the organizations, such as `dry-1`. Reports are kept per run. */
export const V1ImportRunId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,23}$/u));
export type V1ImportRunId = typeof V1ImportRunId.Type;

export const V1ImportParams = Schema.Struct({
  v1OrgId: V1OrganizationId,
  mode: V1ImportMode,
  runId: V1ImportRunId,
});
export type V1ImportParams = typeof V1ImportParams.Type;

/**
 * The Workflow instance of one organization in one run. An import has one instance per
 * organization, its v1 id, so starting it twice finds the first. A dry run never takes that id:
 * its instance is the organization's id and the run's, so dry runs repeat beside a later import.
 */
export const v1ImportInstance = (params: {
  readonly v1OrgId: string;
  readonly mode: V1ImportMode;
  readonly runId: string;
}) => (params.mode === "import" ? params.v1OrgId : `${params.v1OrgId}-dry-${params.runId}`);

/** The private `AppBuilds` objects of a run. Reports hold customer data and stay internal. */
export const v1ImportReportKey = (organization: string, runId: string) =>
  `v1-import/${organization}/${runId}/report.json`;
/** One marker per organization a run started, which its report replaces with its outcome. */
export const v1ImportRunPrefix = (runId: string) => `v1-import/runs/${runId}/orgs/`;
/**
 * The organizations started by every run whose report is not written yet: each start adds one,
 * and the organization's report step removes it. A start counts the ones still running, across
 * runs, so the deployment's whole load stays within the bound.
 */
export const v1ImportInFlightPrefix = "v1-import/in-flight/";
export const v1ImportInFlightKey = (runId: string, organization: string) =>
  `${v1ImportInFlightPrefix}${runId}/${organization}`;
/** What an in-flight entry holds: when its organization's instance was started. */
export const V1ImportInFlight = Schema.Struct({ startedAt: Schema.Number });
export const v1ImportAggregateKey = (runId: string) => `v1-import/runs/${runId}/aggregate.json`;
/** An aggregation's partial result between its pages. */
export const v1ImportAggregatingKey = (runId: string, aggregation: string) =>
  `v1-import/runs/${runId}/aggregating/${aggregation}.json`;

/** Where an organization ended: moved, held back by design, or not convertible yet. */
export const V1OrgOutcome = Schema.Literals([
  "started",
  "planned",
  "blocked",
  "held_back",
  "imported",
  "failed",
]);
export type V1OrgOutcome = typeof V1OrgOutcome.Type;

export const V1RunMarker = Schema.Struct({ status: V1OrgOutcome, mode: V1ImportMode });

const Count = Schema.Number;

/**
 * Why an item v1 itself can no longer run is skipped rather than blocking its organization
 * (`notes/v1-import.md`, decisions 20 and 21). Every refusal either names one of these or blocks.
 *
 * - `local_server`: a local (stdio) MCP server, which v1 Cloud never ran.
 * - `no_base_url`: an API with no absolute server or base URL, so v1 had no host to call.
 * - `not_http`: a base URL, GraphQL endpoint or MCP address that is not http(s); for a tool, an
 *   OpenAPI operation whose server is not http(s), such as `wss://`, as v1 sent only HTTP requests.
 * - `undefined_server_variable`: an API whose server URL uses a variable no server defines, which
 *   v1 never resolved; for a tool, one operation's server.
 * - `unreadable_spec`: v1's stored specification does not read as one.
 * - `removed_tool`: a tool v1 last listed before the organization revised its integration, which
 *   the revised specification no longer has; v1 drops it when it next lists the tools.
 * - `missing_client`: the connection's OAuth client no longer exists in v1.
 * - `undeclared_method`: the connection's sign-in method is not one its integration declares.
 * - `incomplete_credential`: the connection's saved credential lacks a value its method sends.
 * - `missing_credential`: v1's Vault no longer holds the connection's saved credential.
 * - `unmatched_rule`: a tool policy that matches no tool v1 lists. It still moves, for tools the
 *   server may list again, and is reported in `unmatchedRules`.
 */
export const V1StaleCategory = Schema.Literals([
  "local_server",
  "no_base_url",
  "not_http",
  "undefined_server_variable",
  "unreadable_spec",
  "removed_tool",
  "missing_client",
  "undeclared_method",
  "incomplete_credential",
  "missing_credential",
  "unmatched_rule",
]);
export type V1StaleCategory = typeof V1StaleCategory.Type;

/**
 * How a v1 organization moves into an existing v2 organization the operator listed
 * (`notes/v1-import.md`, decisions 32 and 35): with nothing to copy (the default), leaving its v1
 * data in v1, copying it into an organization with nothing set up, or copying only the
 * integrations the operator listed into an organization its members already work in.
 */
export const V1IntoMode = Schema.Literals([
  "nothing_to_copy",
  "leave_v1_data",
  "copy_into_empty",
  "copy_selected",
]);
export type V1IntoMode = typeof V1IntoMode.Type;

const SelectedIntegration = Schema.Struct({ slug: Schema.String, label: Schema.String });

/**
 * What a `copy_selected` move does with each v1 integration (decision 35). A listed integration is
 * refused when v1 has no such integration or an app already in the organization has a name its
 * app takes; either holds the organization back.
 */
export const V1SelectedIntegrations = Schema.Struct({
  copied: Schema.Array(SelectedIntegration),
  leftInV1: Schema.Array(SelectedIntegration),
  refused: Schema.Array(Schema.Struct({ slug: Schema.String, reason: Schema.String })),
});
export type V1SelectedIntegrations = typeof V1SelectedIntegrations.Type;

const EmailMatch = Schema.Struct({
  email: Schema.String,
  match: Schema.Literals(["merge", "conflict"]),
});
const SkippedMember = Schema.Struct({
  user: Schema.String,
  reason: Schema.Literals(["unverified_email", "pending", "inactive"]),
});
const Slug = Schema.Struct({
  v1: Schema.String,
  v2: Schema.NullOr(Schema.String),
  changed: Schema.Boolean,
  /**
   * The v2 organization the operator listed to give up the slug (`notes/v1-import.md`, "Slug
   * displacement"), and its new slug; null, with why, when the displacement does not apply.
   */
  displaced: Schema.optionalKey(
    Schema.Struct({
      organization: Schema.String,
      slug: Schema.NullOr(Schema.String),
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
});
const IntegrationFailure = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  error: Schema.String,
});
const DroppedTraceTools = Schema.Struct({
  integration: Schema.String,
  tools: Schema.Array(Schema.String),
});
const ConnectionFailure = Schema.Struct({
  reason: Schema.String,
  /** The connections move without their account, for their owners to connect again in v2. */
  reconnect: Schema.optional(Schema.Literal(true)),
  connections: Schema.Array(
    Schema.Struct({ id: Schema.String, label: Schema.String, integration: Schema.String }),
  ),
});
const FirstPartyMismatch = Schema.Struct({
  client: Schema.String,
  reason: Schema.Literals(["unavailable", "different_client", "v1_unknown"]),
  connections: Count,
});
const UnmatchedRule = Schema.Struct({
  id: Schema.String,
  pattern: Schema.String,
  action: Schema.String,
});
/**
 * An item skipped because v1 cannot run it either. A connection or rule of a skipped integration
 * takes its integration's category, with `integration` naming it. A tool is one v1 name an
 * imported app leaves out, by its integration.
 */
const StaleItem = Schema.Struct({
  kind: Schema.Literals(["integration", "connection", "tool_policy", "tool"]),
  id: Schema.String,
  label: Schema.String,
  /** The integration a connection, rule or tool belongs to, by label. */
  integration: Schema.NullOr(Schema.String),
  category: V1StaleCategory,
  reason: Schema.String,
});
/**
 * Fixed credentials an integration sent that its app leaves out (decision 22): a value that is its
 * OAuth connections' own client ID or client secret, which their sign-in already sends.
 */
const DroppedCredential = Schema.Struct({
  integration: Schema.String,
  carrier: Schema.Literals(["header", "query"]),
  name: Schema.String,
  reason: Schema.Literals(["oauth_client_id", "oauth_client_secret"]),
});
/**
 * An org connection whose user-scoped secret several members hold with different values. The first
 * member's moves (decision 23); the values are compared in memory and never reported.
 */
const MemberSecretMismatch = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  integration: Schema.String,
  /** Members holding the item, and how many distinct values they hold. */
  members: Count,
  values: Count,
});
const ApiKeys = Schema.Struct({
  read: Schema.Literal(true),
  keys: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) })),
  actsAs: Schema.NullOr(Schema.String),
});
const Artifact = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  unmappedRoles: Schema.Array(Schema.Struct({ role: Schema.String, problem: Schema.String })),
  /** Why it fails, or would: absent when it moves. */
  error: Schema.optionalKey(Schema.String),
});
const VaultFailure = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  integration: Schema.String,
  reason: Schema.Literals(["missing", "unavailable"]),
});
/**
 * An integration whose connections' v1 rules differ, which moves as an app per connection
 * (decision 33): each connection's app, by the connection's row id and name, with what it did or
 * would do and, when it was generated, how many tools its rules leave out, ask before and run
 * without asking, and what they do with a tool none of them names.
 */
const SplitIntegration = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  apps: Schema.Array(
    Schema.Struct({
      connection: Schema.String,
      label: Schema.String,
      owner: Schema.Literals(["org", "user"]),
      name: Schema.String,
      status: Schema.Literals(["imported", "planned", "failed", "skipped"]),
      v2Id: Schema.optionalKey(Schema.String),
      reason: Schema.optionalKey(Schema.String),
      rules: Schema.optionalKey(
        Schema.Struct({
          omitted: Count,
          always: Count,
          never: Count,
          otherwise: Schema.NullOr(Schema.Literals(["omitted", "always"])),
        }),
      ),
    }),
  ),
});

/**
 * An import's cutover check (`notes/v1-import.md`, cutover step 4): every planned item has a result
 * and none failed, every planned member is a member of the v2 organization and it has no others
 * (its seats), every imported account's credentials decrypt with v2's key, and every imported
 * integration's app has an active version. The organization cuts over only when it `passed`.
 */
export const V1ImportVerification = Schema.Struct({
  items: Schema.Struct({ planned: Count, withResult: Count, failed: Count }),
  members: Schema.Struct({ planned: Count, inV2: Count }),
  accounts: Schema.Struct({ checked: Count, unreadable: Count }),
  apps: Schema.Struct({ checked: Count, withoutVersion: Count }),
  passed: Schema.Boolean,
});
export type V1ImportVerification = typeof V1ImportVerification.Type;

/** How a v1 Team subscription charges, and how its carried-over v2 subscription does. */
const TeamPricing = Schema.Literals(["per_member", "flat"]);

/**
 * A paid organization's v1 subscription and its carry-over to v2's Team plan
 * (`notes/v1-import.md`, "Billing"). `subscription` is null when it does not map; `problem` says
 * why it cannot carry over, from the mapping or Autumn's preview; `carried` is an import's result.
 */
export const V1BillingCarryOver = Schema.Struct({
  subscription: Schema.NullOr(
    Schema.Struct({
      plan: Schema.String,
      version: Count,
      pricing: TeamPricing,
      v2Pricing: TeamPricing,
      trialing: Schema.Boolean,
      cancelling: Schema.Boolean,
    }),
  ),
  problem: Schema.NullOr(Schema.String),
  carried: Schema.optionalKey(Schema.Boolean),
});
export type V1BillingCarryOver = typeof V1BillingCarryOver.Type;

/**
 * One organization's report. Its fields are the ones `notes/v1-import.md` lists under "Dry run";
 * an import adds each item's result (`items`).
 */
export const V1OrgReport = Schema.Struct({
  organization: Schema.String,
  runId: Schema.String,
  mode: V1ImportMode,
  status: V1OrgOutcome,
  /** Why the organization is held back or failed. */
  reason: Schema.NullOr(Schema.String),
  /** Counts of each v1 kind, and of the v2 resources they plan or became. */
  counts: Schema.Struct({
    v1: Schema.Record(Schema.String, Count),
    v2: Schema.Record(Schema.String, Count),
  }),
  /** Members whose email matches an existing v2 user, and the organization's slug. */
  emailMatches: Schema.Array(EmailMatch),
  /** v1 members who do not move, by WorkOS user id: unverified, pending or inactive. */
  skippedMembers: Schema.Array(SkippedMember),
  /** The v2 slug the organization would take; null when every candidate is taken. */
  slug: Schema.NullOr(Slug),
  /**
   * The existing v2 organization the operator listed for it to move into instead of a new one, and
   * how (`notes/v1-import.md`, decision 32), with why it does not when it may not. Absent when none
   * is listed.
   */
  into: Schema.optionalKey(
    Schema.Struct({
      organization: Schema.String,
      /** The listed mode, null when the allow table names one the import does not know. */
      mode: Schema.NullOr(V1IntoMode),
      refused: Schema.optionalKey(Schema.String),
      /**
       * For `copy_selected` (decision 35): the listed integrations it copies (in a dry run, would
       * copy; nothing, when the organization is held back), the ones it leaves in v1, and the
       * listed ones it refuses, each by its v1 slug.
       */
      integrations: Schema.optionalKey(V1SelectedIntegrations),
    }),
  ),
  integrationFailures: Schema.Array(IntegrationFailure),
  /** v1 TRACE operations' tools, which are dropped and not failures (decision 16). */
  droppedTraceTools: Schema.Array(DroppedTraceTools),
  connectionFailures: Schema.Array(ConnectionFailure),
  /**
   * First-party clients the org's connections signed in with that v2 does not offer as v1's: not
   * offered, with a client ID other than v1's, or with v1's client ID unknown to this deployment.
   */
  firstPartyMismatches: Schema.Array(FirstPartyMismatch),
  /** Tool policies that match no tool v1 lists: imported, reported, not blocking. */
  unmatchedRules: Schema.Array(UnmatchedRule),
  /** Items skipped because v1 cannot run them either; they do not block the organization. */
  staleItems: Schema.Array(StaleItem),
  droppedCredentials: Schema.Array(DroppedCredential),
  memberSecretMismatches: Schema.Array(MemberSecretMismatch),
  /** The organization's own API keys, and the owner each acts as (decision 12). */
  orgApiKeys: Schema.Union([ApiKeys, Schema.Struct({ read: Schema.Literal(false) })]),
  artifacts: Schema.Array(Artifact),
  flags: Schema.Struct({
    sso: Schema.NullOr(Schema.Boolean),
    overFreeMemberLimit: Schema.Boolean,
    paidPlans: Schema.Array(Schema.String),
  }),
  /** Connections whose secret v1's Vault did not return: missing, or unavailable after retries. */
  vaultFailures: Schema.Array(VaultFailure),
  /** Integrations that move as an app per connection; absent from reports written before. */
  splitIntegrations: Schema.optionalKey(Schema.Array(SplitIntegration)),
  /** A paid organization's subscription carry-over. */
  billing: Schema.optionalKey(V1BillingCarryOver),
  /** The organization an import moved into. */
  v2Organization: Schema.optionalKey(Schema.Struct({ id: Schema.String, slug: Schema.String })),
  /** An import's cutover check, once it got that far. */
  verification: Schema.optionalKey(V1ImportVerification),
  /** Whether an import marked the organization moved in v1, which forwards it to v2. */
  cutover: Schema.optionalKey(Schema.Boolean),
  /** An import's result for every item. */
  items: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        id: Schema.String,
        label: Schema.String,
        /** The integration a connection belongs to, or a policy's action. */
        context: Schema.NullOr(Schema.String),
        status: Schema.Literals(["imported", "failed", "skipped"]),
        v2Id: Schema.optionalKey(Schema.String),
        reason: Schema.optionalKey(Schema.String),
        note: Schema.optionalKey(Schema.String),
        needsRepair: Schema.optionalKey(Schema.Literal(true)),
      }),
    ),
  ),
});
export type V1OrgReport = typeof V1OrgReport.Type;

/**
 * The operator's request to start a batch: the listed organizations, or the next page of all. At
 * most `maxInFlight` organizations run at once across every run of the deployment: a start takes
 * only as many as are free.
 */
export const V1ImportStart = Schema.Struct({
  mode: V1ImportMode,
  runId: V1ImportRunId,
  organizations: Schema.optionalKey(Schema.Array(V1OrganizationId).check(Schema.isMaxLength(100))),
  after: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  maxInFlight: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
});
export type V1ImportStart = typeof V1ImportStart.Type;

/** A started organization whose instance stopped without writing its report. */
export const V1ImportErrored = Schema.Struct({
  organization: Schema.String,
  instance: Schema.String,
  status: Schema.String,
});

export const V1ImportStarted = Schema.Struct({
  started: Schema.Array(Schema.Struct({ organization: Schema.String, instance: Schema.String })),
  /** Listed organizations this start left for later, because there was no room for them. */
  deferred: Schema.Array(Schema.String),
  /**
   * Organizations this start passed over: an id that is not a v1 organization id, or one this run
   * already has running. The walk still moves past them.
   */
  skipped: Schema.Array(
    Schema.Struct({
      organization: Schema.String,
      reason: Schema.Literals(["invalid_id", "running"]),
    }),
  ),
  /** Pass as `after` for the next batch; null once every organization has an instance. */
  next: Schema.NullOr(Schema.String),
  /** Organizations still running across every run after this start, the new ones included. */
  inFlight: Schema.Number,
  /**
   * This run's organizations whose instance stopped without a report (`errored`, `terminated`),
   * or whose state could not be read for long after it started (`unknown`). They no longer count
   * as running.
   */
  errored: Schema.Array(V1ImportErrored),
});

/** Entries of a list in the per-organization reports, each with its organization. */
const Listed = <S extends Schema.Top>(entry: S) =>
  Schema.Array(Schema.Struct({ organization: Schema.String, entry }));
const OrganizationReason = Schema.Struct({
  organization: Schema.String,
  reason: Schema.NullOr(Schema.String),
});

/** A run's reports combined: their fields summed or listed with their organization. */
export const V1ImportAggregate = Schema.Struct({
  runId: Schema.String,
  /** Every started organization has a report. */
  complete: Schema.Boolean,
  organizations: Count,
  /** Started organizations without a report whose instance is still running. */
  pending: Schema.Array(Schema.String),
  /** Started organizations whose instance stopped without a report and needs a person. */
  errored: Schema.Array(V1ImportErrored),
  statuses: Schema.Record(Schema.String, Count),
  counts: Schema.Struct({
    v1: Schema.Record(Schema.String, Count),
    v2: Schema.Record(Schema.String, Count),
  }),
  heldBack: Schema.Array(OrganizationReason),
  failed: Schema.Array(OrganizationReason),
  blocked: Schema.Array(Schema.String),
  emailMatches: Listed(EmailMatch),
  skippedMembers: Listed(SkippedMember),
  slugChanges: Schema.Array(Schema.Struct({ organization: Schema.String, ...Slug.fields })),
  integrationFailures: Listed(IntegrationFailure),
  droppedTraceTools: Listed(DroppedTraceTools),
  connectionFailures: Schema.Struct({
    byReason: Schema.Record(Schema.String, Count),
    connections: Listed(ConnectionFailure),
  }),
  firstPartyMismatches: Listed(FirstPartyMismatch),
  unmatchedRules: Listed(UnmatchedRule),
  staleItems: Schema.Struct({
    /** Skipped items by `<kind> <category>`, such as `connection missing_credential`. */
    byCategory: Schema.Record(Schema.String, Count),
    items: Listed(StaleItem),
  }),
  droppedCredentials: Listed(DroppedCredential),
  memberSecretMismatches: Listed(MemberSecretMismatch),
  orgApiKeys: Schema.Array(
    Schema.Union([
      Schema.Struct({ organization: Schema.String, ...ApiKeys.fields }),
      Schema.Struct({ organization: Schema.String, read: Schema.Literal(false) }),
    ]),
  ),
  artifacts: Listed(Artifact),
  flags: Schema.Struct({
    sso: Schema.Array(Schema.String),
    ssoUnread: Schema.Array(Schema.String),
    overFreeMemberLimit: Schema.Array(Schema.String),
    paid: Schema.Array(
      Schema.Struct({ organization: Schema.String, plans: Schema.Array(Schema.String) }),
    ),
  }),
  vaultFailures: Listed(VaultFailure),
  /** Absent from aggregates combined before integrations moved as an app per connection. */
  splitIntegrations: Schema.optionalKey(Listed(SplitIntegration)),
});
export type V1ImportAggregate = typeof V1ImportAggregate.Type;

/**
 * One page of an aggregation. Until the last page it names the `cursor` to send next and how many
 * organizations it has combined; the last page's cursor is null and it carries the aggregate,
 * which it has also written to `aggregate.json`.
 */
export const V1ImportAggregatePage = Schema.Union([
  Schema.Struct({ cursor: Schema.String, organizations: Count }),
  Schema.Struct({ cursor: Schema.Null, aggregate: V1ImportAggregate }),
]);
export type V1ImportAggregatePage = typeof V1ImportAggregatePage.Type;
