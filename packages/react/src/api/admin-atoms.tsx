import * as Atom from "effect/unstable/reactivity/Atom";

import { AdminApiClient } from "./admin-client";
import { ReactivityKey } from "./reactivity-keys";

// ---------------------------------------------------------------------------
// Admin atoms — the tenant-wide users view behind `/admin/users*`.
//
// Read-only by construction: the admin plane serves GETs only (the owner policy
// rejects writes at tenant reach), so there are no mutations here and every
// atom carries the same reactivity key.
//
// Paging is part of the atom identity, so each page is its own cache entry and
// stepping back to a visited page is instant. `Atom.family` (not a bare arrow)
// because the page component re-derives the key object on every render — a
// fresh atom per render would refetch in a loop.
// ---------------------------------------------------------------------------

/** How many users one page of the list shows. Well inside the contract's
 *  1..500 bound; the joined endpoint reads per-user connections, so a modest
 *  page keeps that join cheap. */
export const ADMIN_USERS_PAGE_SIZE = 25;

export interface AdminUsersPage {
  readonly limit: number;
  readonly offset: number;
}

/**
 * One page of users joined with their connections — what the list renders.
 *
 * Asks for one row MORE than the page size so the pager can tell "there is a
 * next page" from "this is the last one" without a count endpoint (the contract
 * returns no total). The page component drops the extra row.
 */
export const adminUsersWithConnectionsAtom = Atom.family((page: AdminUsersPage) =>
  AdminApiClient.query("adminUsers", "listUsersWithConnections", {
    query: { limit: page.limit + 1, offset: page.offset },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.adminUsers],
  }),
);

/** One user's connections, for the detail pane. A separate read rather than a
 *  slice of the list so opening a user is correct even when the list page it
 *  came from has since gone stale. */
export const adminUserConnectionsAtom = Atom.family((externalId: string) =>
  AdminApiClient.query("adminUsers", "listUserConnections", {
    params: { externalId },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.adminUsers],
  }),
);
