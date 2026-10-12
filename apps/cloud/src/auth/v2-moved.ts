// ---------------------------------------------------------------------------
// Whether the selected organization has moved to Executor v2.
//
// When a user finishes importing a v1 organization, v2 writes two keys onto
// the v1 WorkOS organization's metadata:
//   executor_v2_org_slug  the v2 organization's slug (its `/org/<slug>` URL)
//   executor_v2_moved_at  when the import finished, as an ISO 8601 timestamp
// Both must be present and well formed; anything else, and every failure to
// read the organization, answers "not moved". The answer only drives a notice:
// a moved organization keeps working in v1.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import { WorkOSClient } from "./workos";

export const V2_MOVED_SLUG_KEY = "executor_v2_org_slug";
export const V2_MOVED_AT_KEY = "executor_v2_moved_at";

/** v2's organization slug rule (`OrganizationSlug` in v2's hosted contracts). */
const V2_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const V2_SLUG_MAX_LENGTH = 45;

/** An ISO 8601 date and time with an explicit offset, as `Date#toISOString`
 *  writes it. A bare date or a local time is ambiguous, so it is refused. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface V2Moved {
  /** The v2 organization's page: `<v2 origin>/org/<slug>`. */
  readonly v2Url: string;
  readonly v2Slug: string;
  /** When the import finished, normalized to `Date#toISOString`. */
  readonly movedAt: string;
  /** v2's MCP server, `<v2 MCP origin>/mcp`, for the moved org's agents. Not
   *  the org-pinned `/org/<slug>/mcp`: that path only accepts personal access
   *  tokens, since v2's OAuth resource is `/mcp` and the organization is chosen
   *  on its consent screen (as `v2Slug`). Absent where v1 does not know v2's
   *  MCP origin (`V2_MCP_ORIGIN` unset). */
  readonly v2McpUrl?: string;
}

/** The move recorded in an organization's metadata, or `null` when there is
 *  none or it is malformed. */
export const parseV2Moved = (
  metadata: Readonly<Record<string, unknown>>,
  v2Origin: URL,
  v2McpOrigin: URL | null,
): V2Moved | null => {
  const slug = metadata[V2_MOVED_SLUG_KEY];
  const movedAt = metadata[V2_MOVED_AT_KEY];
  if (typeof slug !== "string" || slug.length > V2_SLUG_MAX_LENGTH || !V2_SLUG.test(slug)) {
    return null;
  }
  if (typeof movedAt !== "string" || !ISO_TIMESTAMP.test(movedAt)) return null;
  const time = Date.parse(movedAt);
  if (!Number.isFinite(time)) return null;
  return {
    v2Url: new URL(`/org/${slug}`, v2Origin).href,
    v2Slug: slug,
    movedAt: new Date(time).toISOString(),
    ...(v2McpOrigin === null ? {} : { v2McpUrl: new URL("/mcp", v2McpOrigin).href }),
  };
};

/** The read the check makes. */
export interface V2MovedSource {
  readonly organizationMetadata: (
    organizationId: string,
  ) => Effect.Effect<Readonly<Record<string, unknown>>, unknown>;
}

/** Whether the organization has moved to v2. Never fails: an unavailable
 *  read answers `null`, so a WorkOS outage shows no notice. */
export const v2Moved = (
  source: V2MovedSource,
  organizationId: string,
  v2Origin: URL,
  v2McpOrigin: URL | null,
): Effect.Effect<V2Moved | null> =>
  source.organizationMetadata(organizationId).pipe(
    Effect.map((metadata) => parseV2Moved(metadata, v2Origin, v2McpOrigin)),
    Effect.orElseSucceed(() => null),
    Effect.withSpan("v2Moved.read"),
  );

/** The organization's metadata, read live from WorkOS (where v2 writes it). */
export const liveV2MovedSource = Effect.gen(function* () {
  const workos = yield* WorkOSClient;
  return {
    organizationMetadata: (organizationId) =>
      workos
        .getOrganization(organizationId)
        .pipe(Effect.map((organization) => organization.metadata)),
  } satisfies V2MovedSource;
});
