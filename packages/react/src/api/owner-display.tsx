import type { Owner } from "@executor-js/sdk/shared";

import { useOrganizationId } from "./organization-context";

// ---------------------------------------------------------------------------
// Owner display (v2) — Personal vs Workspace in cloud, Local in single-player.
//
// v1's scope stack (personal → org) collapsed to a single `Owner` axis: a
// connection / policy is owned by the `org` (tenant-shared) or by the acting
// `user`. The global "active owner" toggle has been retired: views no longer
// filter by a single ambient owner. Instead, read surfaces merge BOTH owners
// (atoms omit `owner`), and each row carries its own `owner` for grouping +
// badges. Owner stays real only at WRITE surfaces (policy writes, the run-panel
// address, create-target choices), where it is chosen explicitly per call.
//
// These helpers are display-only. Write paths must still resolve owners through
// the connection-owner helpers so local hosts clamp to one Local owner.
// ---------------------------------------------------------------------------

/** Human label for an owner, for badges and toggles. */
export function ownerLabel(owner: Owner): string {
  return owner === "user" ? "Personal" : "Workspace";
}

/** Local/desktop are single-player hosts. The real partition there is the
 *  cwd-derived local workspace, so do not expose Personal/Workspace language. */
export function ownerLabelForHost(owner: Owner, organizationId: string | null): string {
  if (organizationId === null) return owner === "org" ? "Local" : "Personal";
  return ownerLabel(owner);
}

export function useOwnerDisplay(): {
  readonly isSinglePlayerHost: boolean;
  readonly showOwnerLabels: boolean;
  readonly label: (owner: Owner) => string;
} {
  const organizationId = useOrganizationId();
  const isSinglePlayerHost = organizationId === null;
  return {
    isSinglePlayerHost,
    showOwnerLabels: !isSinglePlayerHost,
    label: (owner) => ownerLabelForHost(owner, organizationId),
  };
}
