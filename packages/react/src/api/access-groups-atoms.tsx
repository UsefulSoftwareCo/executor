import * as Atom from "effect/unstable/reactivity/Atom";

import { AccessGroupsApiClient } from "./access-groups-client";
import { ReactivityKey } from "./reactivity-keys";

// ---------------------------------------------------------------------------
// Access-groups atoms — the admin-only group/membership/restriction plane
// behind `/admin/access-groups*`. Every read carries the one shared key, and
// every mutation publishes it: the lists are small and interdependent (a
// restriction names a group; group deletion is refused while referenced), so
// refreshing the whole surface together is the correct default.
// ---------------------------------------------------------------------------

export const accessGroupWriteKeys = [ReactivityKey.accessGroups] as const;

export const accessGroupsAtom = Atom.refreshOnWindowFocus(
  AccessGroupsApiClient.query("accessGroups", "listGroups", {
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.accessGroups],
  }),
);

/** One group's roster. `Atom.family` so each open group caches its own read. */
export const accessGroupMembersAtom = Atom.family((groupId: string) =>
  AccessGroupsApiClient.query("accessGroups", "listMembers", {
    params: { groupId },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.accessGroups],
  }),
);

export const accessGroupRestrictionsAtom = AccessGroupsApiClient.query(
  "accessGroups",
  "listRestrictions",
  {
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.accessGroups],
  },
);

export const accessGroupToolkitRestrictionsAtom = AccessGroupsApiClient.query(
  "accessGroups",
  "listToolkitRestrictions",
  {
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.accessGroups],
  },
);

export const createAccessGroup = AccessGroupsApiClient.mutation("accessGroups", "createGroup");
export const renameAccessGroup = AccessGroupsApiClient.mutation("accessGroups", "renameGroup");
export const deleteAccessGroup = AccessGroupsApiClient.mutation("accessGroups", "deleteGroup");
export const addAccessGroupMember = AccessGroupsApiClient.mutation("accessGroups", "addMember");
export const removeAccessGroupMember = AccessGroupsApiClient.mutation(
  "accessGroups",
  "removeMember",
);
export const restrictConnectionToGroup = AccessGroupsApiClient.mutation(
  "accessGroups",
  "restrictConnection",
);
export const unrestrictConnectionFromGroup = AccessGroupsApiClient.mutation(
  "accessGroups",
  "unrestrictConnection",
);
export const restrictToolkitToGroup = AccessGroupsApiClient.mutation(
  "accessGroups",
  "restrictToolkit",
);
export const unrestrictToolkitFromGroup = AccessGroupsApiClient.mutation(
  "accessGroups",
  "unrestrictToolkit",
);
