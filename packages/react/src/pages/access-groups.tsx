import { useState } from "react";
import { Exit } from "effect";
import { useAtomRefresh, useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { toast } from "sonner";

import {
  accessGroupMembersAtom,
  accessGroupRestrictionsAtom,
  accessGroupToolkitRestrictionsAtom,
  accessGroupWriteKeys,
  accessGroupsAtom,
  addAccessGroupMember,
  createAccessGroup,
  deleteAccessGroup,
  removeAccessGroupMember,
  renameAccessGroup,
  restrictConnectionToGroup,
  unrestrictConnectionFromGroup,
  unrestrictToolkitFromGroup,
} from "../api/access-groups-atoms";
import { connectionsAtom } from "../api/atoms";
import { orgMembersAtom } from "../api/account-atoms";
import { messageFromExit } from "../api/error-reporting";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/dialog";
import { ErrorState } from "../components/error-state";
import { Input } from "../components/input";
import { Label } from "../components/label";
import { PageContainer, PageHeader } from "../components/page";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/sheet";
import { isAsyncResultLoading } from "../lib/async-result";
import { useExecutorDocumentTitle } from "../lib/document-title";

// ---------------------------------------------------------------------------
// Admin · Access groups — who may see which org connection or toolkit.
//
// Reads and writes ONLY the admin plane (`/admin/access-groups*`), never the
// product plane: an admin's own product listings are group-filtered like
// everyone's, so this page's restriction lists come from the unfiltered admin
// endpoints. The one product-plane read here is the org connections list that
// feeds the "restrict a connection" picker — it shows the connections the
// admin can currently see, which is exactly the set that can still be newly
// restricted (already-restricted ones appear in the restrictions list below).
//
// ACCESS: the server is the gate. A plain member's request comes back 403 and
// the page renders an explicit denial rather than empty lists; the nav item
// is separately hidden from non-admins (see lib/admin-access), but that is
// convenience — this is the surface that actually refuses.
//
// The member roster names people by their host account id (the same id
// `/admin/users` reports); the display identity is joined client-side from
// `/account/members` (`userId`), so a member who left the org still renders —
// as the bare id — instead of disappearing from the roster.
// ---------------------------------------------------------------------------

type GroupRow = {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
};

type MemberIdentity = {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
};

const GENERIC_WRITE_ERROR = "The change was refused. Please try again.";

/** 401/403 from the admin plane — both mean "not an operator here". */
const isAccessDenied = (cause: Cause.Cause<unknown>): boolean =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => false,
    onSome: (error) =>
      Predicate.isTagged(error, "AccessGroupsForbidden") ||
      Predicate.isTagged(error, "AccessGroupsUnauthorized"),
  });

function AccessDenied() {
  return (
    <div className="rounded-lg border border-border bg-card p-8">
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        Admin only
      </p>
      <h2 className="mt-2 text-base font-semibold text-foreground">
        You don&apos;t have access to this workspace&apos;s access groups
      </h2>
      <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
        Managing who may use restricted connections requires an admin role. Ask an admin of this
        workspace if you need it.
      </p>
    </div>
  );
}

function SectionSkeleton() {
  return (
    <div className="space-y-2">
      {[1, 2].map((i) => (
        <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
      ))}
    </div>
  );
}

export function AccessGroupsPage() {
  useExecutorDocumentTitle("Access groups");
  const groupsResult = useAtomValue(accessGroupsAtom);
  const refreshGroups = useAtomRefresh(accessGroupsAtom);
  const restrictionsResult = useAtomValue(accessGroupRestrictionsAtom);
  const refreshRestrictions = useAtomRefresh(accessGroupRestrictionsAtom);
  const toolkitRestrictionsResult = useAtomValue(accessGroupToolkitRestrictionsAtom);
  const membersResult = useAtomValue(orgMembersAtom);

  const doCreate = useAtomSet(createAccessGroup, { mode: "promiseExit" });
  const doDelete = useAtomSet(deleteAccessGroup, { mode: "promiseExit" });
  const doUnrestrict = useAtomSet(unrestrictConnectionFromGroup, { mode: "promiseExit" });
  const doUnrestrictToolkit = useAtomSet(unrestrictToolkitFromGroup, { mode: "promiseExit" });

  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [openGroup, setOpenGroup] = useState<GroupRow | null>(null);
  const [renameTarget, setRenameTarget] = useState<GroupRow | null>(null);
  const [restrictOpen, setRestrictOpen] = useState(false);

  // The org member directory, for joining opaque account ids to identities in
  // rosters and for the add-member picker. An unreadable directory degrades to
  // bare ids rather than blocking the page.
  const identities: readonly MemberIdentity[] = AsyncResult.match(membersResult, {
    onInitial: () => [],
    onFailure: () => [],
    onSuccess: ({ value }) =>
      value.members.map((member) => ({
        userId: member.userId,
        email: member.email,
        name: member.name,
      })),
  });
  const identityOf = (subject: string): MemberIdentity | undefined =>
    identities.find((identity) => identity.userId === subject);

  const groups = AsyncResult.match(groupsResult, {
    onInitial: () => [] as readonly GroupRow[],
    onFailure: () => [] as readonly GroupRow[],
    onSuccess: ({ value }) => value.groups,
  });
  const groupName = (id: string): string => groups.find((group) => group.id === id)?.name ?? id;

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    const exit = await doCreate({ payload: { name }, reactivityKeys: accessGroupWriteKeys });
    setCreating(false);
    if (Exit.isSuccess(exit)) {
      setNewName("");
      toast.success(`Created group "${name}"`);
    } else {
      toast.error(messageFromExit(exit, GENERIC_WRITE_ERROR));
    }
  };

  const handleDelete = async (group: GroupRow) => {
    const exit = await doDelete({
      params: { groupId: group.id },
      reactivityKeys: accessGroupWriteKeys,
    });
    // Deletion is refused while a connection or toolkit still references the
    // group — surface the engine's message, which names the blocker.
    toast[Exit.isSuccess(exit) ? "success" : "error"](
      Exit.isSuccess(exit) ? `Deleted "${group.name}"` : messageFromExit(exit, GENERIC_WRITE_ERROR),
    );
  };

  const handleUnrestrict = async (integration: string, name: string) => {
    const exit = await doUnrestrict({
      params: { integration, name },
      reactivityKeys: accessGroupWriteKeys,
    });
    toast[Exit.isSuccess(exit) ? "success" : "error"](
      Exit.isSuccess(exit)
        ? `${integration}/${name} is visible to everyone again`
        : messageFromExit(exit, GENERIC_WRITE_ERROR),
    );
  };

  const handleUnrestrictToolkit = async (toolkitId: string, slug: string) => {
    const exit = await doUnrestrictToolkit({
      params: { toolkitId },
      reactivityKeys: accessGroupWriteKeys,
    });
    toast[Exit.isSuccess(exit) ? "success" : "error"](
      Exit.isSuccess(exit)
        ? `Toolkit "${slug}" is visible to everyone again`
        : messageFromExit(exit, GENERIC_WRITE_ERROR),
    );
  };

  return (
    <PageContainer>
      <PageHeader title="Access groups" />

      {AsyncResult.match(groupsResult, {
        onInitial: () => <SectionSkeleton />,
        onFailure: (failure) =>
          isAccessDenied(failure.cause) ? (
            <AccessDenied />
          ) : (
            <ErrorState message="Failed to load access groups" onRetry={refreshGroups} />
          ),
        onSuccess: () => (
          <>
            <section className="mb-10">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Groups</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  A group names the members who may use the connections and toolkits restricted to
                  it. Everything unrestricted stays visible to the whole workspace.
                </p>
              </div>

              <div className="mb-3 flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Label htmlFor="new-group-name" className="text-sm font-medium text-foreground">
                    New group
                  </Label>
                  <Input
                    id="new-group-name"
                    placeholder="finance-leads"
                    value={newName}
                    onChange={(e) => setNewName((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreate();
                    }}
                    className="mt-1.5 h-9 text-sm"
                  />
                </div>
                <Button size="sm" onClick={handleCreate} disabled={!newName.trim() || creating}>
                  {creating ? "Creating…" : "Create group"}
                </Button>
              </div>

              {groups.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No groups yet. Create one, add members, then restrict a connection to it.
                </p>
              ) : (
                <div className="space-y-px">
                  {groups.map((group) => (
                    <div
                      key={group.id}
                      className="group relative flex items-center gap-3 rounded-lg border border-transparent px-4 py-3 transition-all hover:bg-muted/30"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground leading-none">
                          {group.name}
                        </p>
                        <p className="mt-1 truncate text-xs text-muted-foreground leading-none">
                          {group.id}
                        </p>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => setOpenGroup(group)}>
                        Members
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRenameTarget(group)}>
                        Rename
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => handleDelete(group)}
                      >
                        Delete
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="mb-10">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-medium text-foreground">Restricted connections</h2>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    A restricted workspace connection is invisible to everyone outside its group —
                    it disappears from their catalogs, tools, and MCP sessions.
                  </p>
                </div>
                <Button
                  size="sm"
                  className="min-w-32"
                  onClick={() => setRestrictOpen(true)}
                  disabled={groups.length === 0}
                >
                  Restrict connection
                </Button>
              </div>

              {isAsyncResultLoading(restrictionsResult) ? (
                <SectionSkeleton />
              ) : (
                AsyncResult.match(restrictionsResult, {
                  onInitial: () => <SectionSkeleton />,
                  onFailure: () => (
                    <ErrorState
                      message="Failed to load restrictions"
                      onRetry={refreshRestrictions}
                    />
                  ),
                  onSuccess: ({ value }) =>
                    value.restrictions.length === 0 ? (
                      <p className="py-6 text-center text-sm text-muted-foreground">
                        No connections are restricted.
                      </p>
                    ) : (
                      <div className="space-y-px">
                        {value.restrictions.map((restriction) => (
                          <div
                            key={`${restriction.integration}/${restriction.name}`}
                            className="flex items-center gap-3 rounded-lg border border-transparent px-4 py-3 transition-all hover:bg-muted/30"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium text-foreground leading-none">
                                {restriction.integration}/{restriction.name}
                              </p>
                            </div>
                            <Badge className="bg-muted text-muted-foreground">
                              {groupName(restriction.group)}
                            </Badge>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                handleUnrestrict(restriction.integration, restriction.name)
                              }
                            >
                              Remove
                            </Button>
                          </div>
                        ))}
                      </div>
                    ),
                })
              )}
            </section>

            <section className="mb-10">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Restricted toolkits</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  A restricted toolkit&apos;s URL resolves to nothing for anyone outside its group.
                </p>
              </div>
              {AsyncResult.match(toolkitRestrictionsResult, {
                onInitial: () => <SectionSkeleton />,
                onFailure: () => null,
                onSuccess: ({ value }) =>
                  value.restrictions.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                      No toolkits are restricted.
                    </p>
                  ) : (
                    <div className="space-y-px">
                      {value.restrictions.map((restriction) => (
                        <div
                          key={restriction.toolkitId}
                          className="flex items-center gap-3 rounded-lg border border-transparent px-4 py-3 transition-all hover:bg-muted/30"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-foreground leading-none">
                              {restriction.slug}
                            </p>
                            <p className="mt-1 truncate text-xs text-muted-foreground leading-none">
                              {restriction.toolkitId}
                            </p>
                          </div>
                          <Badge className="bg-muted text-muted-foreground">
                            {groupName(restriction.group)}
                          </Badge>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              handleUnrestrictToolkit(restriction.toolkitId, restriction.slug)
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                    </div>
                  ),
              })}
            </section>
          </>
        ),
      })}

      {openGroup && (
        <GroupMembersSheet
          group={openGroup}
          identities={identities}
          identityOf={identityOf}
          onOpenChange={(open) => {
            if (!open) setOpenGroup(null);
          }}
        />
      )}
      {renameTarget && (
        <RenameGroupDialog
          group={renameTarget}
          onOpenChange={(open) => {
            if (!open) setRenameTarget(null);
          }}
        />
      )}
      <RestrictConnectionDialog
        open={restrictOpen}
        onOpenChange={setRestrictOpen}
        groups={groups}
      />
    </PageContainer>
  );
}

// ── Group members ───────────────────────────────────────────────────────────

function GroupMembersSheet(props: {
  group: GroupRow;
  identities: readonly MemberIdentity[];
  identityOf: (subject: string) => MemberIdentity | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const membersResult = useAtomValue(accessGroupMembersAtom(props.group.id));
  const refresh = useAtomRefresh(accessGroupMembersAtom(props.group.id));
  const doAdd = useAtomSet(addAccessGroupMember, { mode: "promiseExit" });
  const doRemove = useAtomSet(removeAccessGroupMember, { mode: "promiseExit" });
  const [picked, setPicked] = useState("");

  const roster = AsyncResult.match(membersResult, {
    onInitial: () => [] as readonly { subject: string }[],
    onFailure: () => [] as readonly { subject: string }[],
    onSuccess: ({ value }) => value.members,
  });
  const inRoster = new Set(roster.map((member) => member.subject));
  const candidates = props.identities.filter((identity) => !inRoster.has(identity.userId));

  const handleAdd = async () => {
    if (!picked) return;
    const exit = await doAdd({
      params: { groupId: props.group.id },
      payload: { subject: picked },
      reactivityKeys: accessGroupWriteKeys,
    });
    if (Exit.isSuccess(exit)) {
      setPicked("");
      refresh();
    } else {
      toast.error(messageFromExit(exit, GENERIC_WRITE_ERROR));
    }
  };

  const handleRemove = async (subject: string) => {
    const exit = await doRemove({
      params: { groupId: props.group.id, subject },
      reactivityKeys: accessGroupWriteKeys,
    });
    if (Exit.isSuccess(exit)) {
      refresh();
    } else {
      toast.error(messageFromExit(exit, GENERIC_WRITE_ERROR));
    }
  };

  return (
    <Sheet open onOpenChange={props.onOpenChange}>
      <SheetContent className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{props.group.name}</SheetTitle>
          <SheetDescription>
            Members of this group. Changes apply on their next call — even to sessions that are
            already open.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Label className="text-sm font-medium text-foreground">Add member</Label>
            <Select value={picked} onValueChange={setPicked}>
              <SelectTrigger className="mt-1.5 h-9 text-sm">
                <SelectValue placeholder="Pick a workspace member" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((identity) => (
                  <SelectItem key={identity.userId} value={identity.userId}>
                    {identity.name ?? identity.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" onClick={handleAdd} disabled={!picked}>
            Add
          </Button>
        </div>

        <div className="mt-6 space-y-px">
          {roster.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No members yet.</p>
          ) : (
            roster.map((member) => {
              const identity = props.identityOf(member.subject);
              return (
                <div
                  key={member.subject}
                  className="flex items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 transition-all hover:bg-muted/30"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground leading-none">
                      {identity?.name ?? identity?.email ?? member.subject}
                    </p>
                    {identity?.name && (
                      <p className="mt-1 truncate text-xs text-muted-foreground leading-none">
                        {identity.email}
                      </p>
                    )}
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => handleRemove(member.subject)}>
                    Remove
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Rename ──────────────────────────────────────────────────────────────────

function RenameGroupDialog(props: { group: GroupRow; onOpenChange: (open: boolean) => void }) {
  const doRename = useAtomSet(renameAccessGroup, { mode: "promiseExit" });
  const [name, setName] = useState(props.group.name);
  const [saving, setSaving] = useState(false);

  const handleRename = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    const exit = await doRename({
      params: { groupId: props.group.id },
      payload: { name: trimmed },
      reactivityKeys: accessGroupWriteKeys,
    });
    setSaving(false);
    if (Exit.isSuccess(exit)) {
      props.onOpenChange(false);
    } else {
      toast.error(messageFromExit(exit, GENERIC_WRITE_ERROR));
    }
  };

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Rename group</DialogTitle>
        </DialogHeader>
        <div className="py-3">
          <Label htmlFor="rename-group" className="text-sm font-medium text-foreground">
            Name
          </Label>
          <Input
            id="rename-group"
            value={name}
            onChange={(e) => setName((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRename();
            }}
            className="mt-1.5 h-9 text-sm"
          />
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button size="sm" onClick={handleRename} disabled={!name.trim() || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Restrict a connection ───────────────────────────────────────────────────

function RestrictConnectionDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: readonly GroupRow[];
}) {
  // The admin's OWN (group-filtered) view of workspace connections — exactly
  // the set that can still be newly restricted; already-restricted ones live
  // in the restrictions list.
  const connectionsResult = useAtomValue(connectionsAtom("org"));
  const doRestrict = useAtomSet(restrictConnectionToGroup, { mode: "promiseExit" });
  const [pickedConnection, setPickedConnection] = useState("");
  const [pickedGroup, setPickedGroup] = useState("");
  const [saving, setSaving] = useState(false);

  const connections = AsyncResult.match(connectionsResult, {
    onInitial: () => [] as readonly { integration: string; name: string }[],
    onFailure: () => [] as readonly { integration: string; name: string }[],
    onSuccess: ({ value }) =>
      value.map((connection) => ({
        integration: String(connection.integration),
        name: String(connection.name),
      })),
  });

  const handleRestrict = async () => {
    const [integration, name] = pickedConnection.split("/");
    if (!integration || !name || !pickedGroup) return;
    setSaving(true);
    const exit = await doRestrict({
      payload: { integration, name, group: pickedGroup },
      reactivityKeys: accessGroupWriteKeys,
    });
    setSaving(false);
    if (Exit.isSuccess(exit)) {
      setPickedConnection("");
      setPickedGroup("");
      props.onOpenChange(false);
      toast.success("Connection restricted");
    } else {
      toast.error(messageFromExit(exit, GENERIC_WRITE_ERROR));
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Restrict a connection</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            Only members of the chosen group will see or use this workspace connection. It
            disappears for everyone else — catalogs, tools, and open MCP sessions included.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-3">
          <div className="grid gap-1.5">
            <Label className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Connection
            </Label>
            <Select value={pickedConnection} onValueChange={setPickedConnection}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="Pick a workspace connection" />
              </SelectTrigger>
              <SelectContent>
                {connections.map((connection) => (
                  <SelectItem
                    key={`${connection.integration}/${connection.name}`}
                    value={`${connection.integration}/${connection.name}`}
                  >
                    {connection.integration}/{connection.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Group
            </Label>
            <Select value={pickedGroup} onValueChange={setPickedGroup}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="Pick a group" />
              </SelectTrigger>
              <SelectContent>
                {props.groups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button
            size="sm"
            onClick={handleRestrict}
            disabled={!pickedConnection || !pickedGroup || saving}
          >
            {saving ? "Restricting…" : "Restrict"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
