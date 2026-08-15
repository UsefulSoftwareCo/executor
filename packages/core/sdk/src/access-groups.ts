// ---------------------------------------------------------------------------
// Access groups — named audiences of org members that gate org-owned
// connections. A connection carrying `access_group` is a HARD visibility
// boundary: to a non-member it does not exist on any read or invoke surface
// (no distinguishable error, no existence oracle). Groups are tenant-scoped
// first-class rows here; the hosts stay authoritative for who the members ARE
// (names, emails) — `subject` values are the same host-auth principal ids the
// owned tables partition by.
//
// Management is an ADMIN surface: these inputs are consumed by
// `executor.accessGroups`, which hosts expose only behind their own admin
// gates — never through the any-member `ExecutorApi`.
// ---------------------------------------------------------------------------

import type { AccessGroupMemberRow, AccessGroupRow } from "./core-schema";
import { AccessGroupId, type ConnectionName, type IntegrationSlug } from "./ids";

export interface AccessGroup {
  readonly id: AccessGroupId;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AccessGroupMember {
  readonly groupId: AccessGroupId;
  /** The host-auth principal id (cloud: the WorkOS accountId). Opaque. */
  readonly subject: string;
  readonly createdAt: Date;
}

export interface CreateAccessGroupInput {
  readonly name: string;
}

export interface UpdateAccessGroupInput {
  readonly id: string;
  readonly name: string;
}

export interface RemoveAccessGroupInput {
  readonly id: string;
}

export interface AccessGroupMemberInput {
  readonly id: string;
  /** The member's host-auth principal id (the org member's account id). */
  readonly subject: string;
}

/** Restriction targets are always org-owned connections — restricting a
 *  personal connection is rejected (it is already invisible to everyone
 *  else), so the ref carries no owner. */
export interface RestrictConnectionInput {
  readonly integration: IntegrationSlug;
  readonly name: ConnectionName;
  readonly group: string;
}

export interface UnrestrictConnectionInput {
  readonly integration: IntegrationSlug;
  readonly name: ConnectionName;
}

/** One restricted org connection, as the management surface reports it. */
export interface RestrictedConnection {
  readonly integration: IntegrationSlug;
  readonly name: ConnectionName;
  readonly group: AccessGroupId;
}

export const rowToAccessGroup = (row: AccessGroupRow): AccessGroup => ({
  id: AccessGroupId.make(row.id),
  name: row.name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const rowToAccessGroupMember = (row: AccessGroupMemberRow): AccessGroupMember => ({
  groupId: AccessGroupId.make(row.group_id),
  subject: row.subject,
  createdAt: row.created_at,
});
