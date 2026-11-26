import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { writeRows, type RowStatement } from "./cloud-rows.ts";

export const v1OrganizationId = () => `org_${randomBytes(13).toString("hex").toUpperCase()}`;
export const v1UserId = () => `user_${randomBytes(13).toString("hex").toUpperCase()}`;

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
