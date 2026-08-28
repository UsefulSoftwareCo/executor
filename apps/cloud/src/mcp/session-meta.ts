// ---------------------------------------------------------------------------
// Where an MCP session's organization identity comes from.
//
// Three sources, in the order they are preferred:
//
//   props    — the org record the worker resolved while authorizing THIS
//              request, carried in the session props. Free, and always the
//              freshest answer available.
//   stored   — the meta this session Durable Object already persisted for the
//              same organization on an earlier init. Free, and correct for a
//              session that already exists.
//   database — an actual read of the `organizations` row.
//
// Only the third can fail, and it is the one that used to run unconditionally.
// Every cold DO init opened a brand-new Postgres connection through Hyperdrive
// purely to re-read a row the worker had loaded microseconds earlier on the
// same request and then discarded; when that connection could not be
// established the read hung for the full connect budget and the failure was
// turned into a defect, killing `initialize` on a database that was, at that
// same moment, answering the worker's own queries in milliseconds.
//
// So: prefer what the request already knows, and when the database genuinely is
// the only source, give it a bounded retry and a CLASSIFIED failure — the same
// transient-vs-definitive split the WorkOS membership check already uses in
// `auth-provider.ts` — instead of an unclassified defect.
// ---------------------------------------------------------------------------

import { Data, Effect, Predicate, Result, Schedule } from "effect";

import type { McpSessionInit, SessionMeta } from "@executor-js/cloudflare/mcp/agent-durable-object";

import { UserStoreService } from "../auth/context";
import { WorkOSClient } from "../auth/workos";
import {
  isDefinitiveWorkOSDenial,
  isTransientUserStoreReason,
  type UserStoreError,
} from "../auth/errors";
import { resolveOrganization } from "../auth/organization";

export type SessionMetaSource = "props" | "stored" | "database";

export const SESSION_META_SOURCE_ATTRIBUTE = "mcp.session.meta_source";

/**
 * The wire marker for "the organization directory was unreachable, try again".
 *
 * A Durable Object's `init` can only reject its Promise, so this travels to the
 * worker as an ordinary error message across the DO boundary — the same
 * mechanism the condemned-session `"destroyed"` abort already uses. The worker
 * matches on it to answer a retryable 503 instead of letting an unclassified
 * 500 (and the agents SDK's own DO-operation retry on top of it) turn a
 * transient blip into a half-minute client hang.
 */
export const MCP_SESSION_META_UNAVAILABLE = "mcp_session_meta_unavailable";

export class McpSessionMetaUnavailableError extends Data.TaggedError(
  "McpSessionMetaUnavailableError",
)<{
  readonly reason: string;
  readonly attempts: number;
}> {
  override get message(): string {
    return `${MCP_SESSION_META_UNAVAILABLE}: organization directory unavailable (${this.reason}) after ${this.attempts} attempts`;
  }
}

export class OrganizationNotFoundError extends Data.TaggedError("OrganizationNotFoundError")<{
  readonly organizationId: string;
}> {}

/** Does this failure, seen at the worker, mean "the session DO could not reach
 *  the organization directory"? Matches on the message because that is what
 *  survives the Durable Object RPC boundary. */
export const isMcpSessionMetaUnavailable = (error: unknown): boolean =>
  // oxlint-disable-next-line executor/no-unknown-error-message -- adapter boundary: a Durable Object rejection reaches the worker as a plain Error whose message IS the signal (same mechanism as the "destroyed" abort)
  Predicate.isError(error) && error.message.includes(MCP_SESSION_META_UNAVAILABLE);

/**
 * Retries for the database path. Deliberately small: the point is to ride out a
 * single bad connection attempt, not to sit on a client's `initialize` while a
 * database stays down. Exhausting them answers the client quickly and
 * retryably, which is strictly better than hanging.
 */
export const SESSION_META_DB_RETRIES = 2;

const RETRY_SCHEDULE = Schedule.both(
  Schedule.exponential("200 millis"),
  Schedule.recurs(SESSION_META_DB_RETRIES),
);

const isUserStoreError = Predicate.isTagged("UserStoreError") as (
  error: unknown,
) => error is UserStoreError;

/**
 * Is this org-lookup failure worth another attempt? A connection that never
 * opened is; a query the server answered with an error, or a WorkOS denial, is
 * not — retrying those only burns the client's init budget.
 */
export const isRetryableOrganizationLookupFailure = (failure: unknown): boolean => {
  if (isUserStoreError(failure)) return isTransientUserStoreReason(failure.reason);
  if (isDefinitiveWorkOSDenial(failure)) return false;
  // A WorkOS blip (429/5xx/timeout/network) — the same class the MCP auth path
  // already treats as retryable.
  return Predicate.isTagged(failure, "WorkOSError");
};

const failureReason = (failure: unknown): string =>
  isUserStoreError(failure) ? failure.reason : "upstream";

const metaFromIdentity = (
  token: McpSessionInit,
  organization: {
    readonly name: string;
    readonly slug?: string;
    readonly orgRole?: "admin" | "member";
  },
): SessionMeta => {
  const orgRole = token.orgRole ?? organization.orgRole;
  return {
    organizationId: token.organizationId,
    organizationName: organization.name,
    ...(organization.slug === undefined ? {} : { organizationSlug: organization.slug }),
    ...(orgRole === undefined ? {} : { orgRole }),
    userId: token.userId,
    resource: token.resource,
    elicitationMode: token.elicitationMode,
    artifactsEnabled: token.artifactsEnabled,
    searchToolsEnabled: token.searchToolsEnabled,
  };
};

/**
 * Read the organization row, retrying only failures a retry can clear, and
 * surfacing an exhausted retry as a typed, retryable failure rather than a
 * defect.
 */
const organizationFromDatabase = (
  organizationId: string,
): Effect.Effect<
  { readonly id: string; readonly name: string; readonly slug?: string },
  McpSessionMetaUnavailableError | OrganizationNotFoundError,
  UserStoreService | WorkOSClient
> =>
  Effect.gen(function* () {
    let attempts = 0;
    // `Effect.retry` retries every failure it sees, so definitive failures are
    // lifted OUT of the error channel before the schedule ever runs and only
    // the retryable ones are left in it.
    const attempt = Effect.suspend(() => {
      attempts += 1;
      return resolveOrganization(organizationId).pipe(
        Effect.result,
        Effect.flatMap((outcome) =>
          Result.isFailure(outcome) && isRetryableOrganizationLookupFailure(outcome.failure)
            ? Effect.fail(outcome.failure)
            : Effect.succeed(outcome),
        ),
      );
    });

    // Two nested Results: the outer one is "the retries ran out", the inner one
    // is "the lookup failed definitively on the first look". Both mean the same
    // thing to the caller.
    const retried = yield* attempt.pipe(Effect.retry(RETRY_SCHEDULE), Effect.result);
    const outcome = Result.isFailure(retried) ? Result.fail(retried.failure) : retried.success;

    if (Result.isFailure(outcome)) {
      return yield* new McpSessionMetaUnavailableError({
        reason: failureReason(outcome.failure),
        attempts,
      });
    }
    const organization = outcome.success;
    if (!organization) return yield* new OrganizationNotFoundError({ organizationId });
    return organization;
  }).pipe(
    Effect.withSpan("mcp.session.resolve_organization", {
      attributes: { "mcp.auth.organization_id": organizationId },
    }),
  );

/**
 * Build the session meta for an init, preferring the org identity the request
 * already carries over any read of the organization directory.
 *
 * `storedMeta` is this DO's own persisted meta for the SAME organization (the
 * base Durable Object only offers a matching one), or `null`.
 */
export const resolveSessionMetaForToken = (
  token: McpSessionInit,
  storedMeta: SessionMeta | null,
): Effect.Effect<
  SessionMeta,
  McpSessionMetaUnavailableError | OrganizationNotFoundError,
  UserStoreService | WorkOSClient
> =>
  Effect.gen(function* () {
    const fromProps = token.organizationName;
    if (fromProps) {
      yield* Effect.annotateCurrentSpan(SESSION_META_SOURCE_ATTRIBUTE, "props");
      return metaFromIdentity(token, { name: fromProps, slug: token.organizationSlug });
    }

    if (storedMeta?.organizationName) {
      yield* Effect.annotateCurrentSpan(SESSION_META_SOURCE_ATTRIBUTE, "stored");
      return metaFromIdentity(token, {
        name: storedMeta.organizationName,
        slug: storedMeta.organizationSlug,
        orgRole: storedMeta.orgRole,
      });
    }

    yield* Effect.annotateCurrentSpan(SESSION_META_SOURCE_ATTRIBUTE, "database");
    const organization = yield* organizationFromDatabase(token.organizationId);
    return metaFromIdentity(token, organization);
  });
