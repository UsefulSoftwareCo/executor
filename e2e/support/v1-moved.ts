/**
 * A v1 organization that moved to v2, as the v1 import recorded it in Cloud's database before it
 * was removed (`notes/v1-import.md`). MCP forwarding, the session handoff and the WorkOS API key
 * check still read these records, so scenarios write them directly for synthetic WorkOS ids.
 */
import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { writeRows, type RowStatement } from "./cloud-rows.ts";

/** A synthetic WorkOS organization id. */
export const v1OrganizationId = () => `org_${randomBytes(13).toString("hex").toUpperCase()}`;
/** A synthetic WorkOS user id. */
export const v1UserId = () => `user_${randomBytes(13).toString("hex").toUpperCase()}`;

/** One import map row of an imported item: the v1 item and the v2 resource it became. */
const imported = (
  v1Organization: string,
  kind: "organization" | "user" | "toolkit",
  v1: string,
  v2Kind: string,
  v2: string,
): RowStatement => ({
  sql: `insert into private_v1_import_map
    (v1_org_id, v1_kind, v1_id, v2_kind, v2_id, status, source_hash)
    values ($1, $2, $3, $4, $5, 'imported', 'e2e')`,
  params: [v1Organization, kind, v1, v2Kind, v2],
});

/**
 * Record `v1Organization` as imported into the v2 organization `v2Organization`, each of `users`
 * (a WorkOS user and its v2 user) as imported, and each of `toolkits` as a member's copy: the
 * scoped connection the import made for that member of the v1 toolkit's row.
 */
export const recordMovedV1Organization = (input: {
  readonly v1Organization: string;
  readonly v2Organization: string;
  readonly users: ReadonlyArray<{ readonly v1: string; readonly v2: string }>;
  readonly toolkits?: ReadonlyArray<{
    readonly row: string;
    readonly member: string;
    readonly connection: string;
  }>;
}) =>
  writeRows("sso-database.json", [
    imported(
      input.v1Organization,
      "organization",
      input.v1Organization,
      "organization",
      input.v2Organization,
    ),
    ...input.users.map((user) => imported(input.v1Organization, "user", user.v1, "user", user.v2)),
    ...(input.toolkits ?? []).map((toolkit) =>
      imported(
        input.v1Organization,
        "toolkit",
        `${toolkit.row}:${toolkit.member}`,
        "mcp_connection",
        toolkit.connection,
      ),
    ),
  ]).pipe(Effect.asVoid);
