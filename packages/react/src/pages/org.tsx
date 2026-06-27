import { useEffect, useReducer, useState } from "react";
import { Exit, Match } from "effect";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { toast } from "sonner";
import { trackEvent } from "../api/analytics";
import { orgMemberWriteKeys, orgInfoWriteKeys } from "../api/reactivity-keys";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "../components/dialog";
import { Button } from "../components/button";
import { Badge } from "../components/badge";
import { Alert, AlertDescription, AlertTitle } from "../components/alert";
import { Info, InfoDescription, InfoTitle } from "../components/info";
import { Input } from "../components/input";
import { Label } from "../components/label";
import { Skeleton } from "../components/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "../components/dropdown-menu";
import {
  orgMembersAtom,
  orgRolesAtom,
  inviteMember,
  removeMember,
  updateMemberRole,
  updateOrgName,
} from "../api/account-atoms";
import { useAuth } from "../multiplayer/auth-context";

// ---------------------------------------------------------------------------
// Shared organization page — members + roles + invites + org name, over the
// provider-neutral `/account/*` surface. Cloud-only surfaces (domain
// verification, seat/billing gating) are NOT here; cloud composes those
// alongside this page as its own additions.
// ---------------------------------------------------------------------------

type MemberData = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: string;
  status: string;
  lastActiveAt: string | null;
  isCurrentUser: boolean;
};

type RoleData = { slug: string; name: string };

type OrganizationNameDraft = {
  readonly organizationId: string | null;
  readonly sourceName: string;
  readonly value: string;
};

export type OrgPageAccess =
  | { readonly status: "loading"; readonly canManageOrganization: false }
  | { readonly status: "allowed"; readonly canManageOrganization: true }
  | { readonly status: "denied"; readonly canManageOrganization: false }
  | { readonly status: "failed"; readonly canManageOrganization: false };

type OrgPageAccessSource =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "resolved"; readonly role: string | null | undefined };

export const canManageOrganizationRole = (role: string | null | undefined) =>
  role === "admin" || role === "owner";

export const resolveOrgPageAccess = (source: OrgPageAccessSource) => {
  if (source.status === "loading") {
    return { status: "loading", canManageOrganization: false } satisfies OrgPageAccess;
  }
  if (source.status === "failed" || source.role == null) {
    return { status: "failed", canManageOrganization: false } satisfies OrgPageAccess;
  }
  if (canManageOrganizationRole(source.role)) {
    return { status: "allowed", canManageOrganization: true } satisfies OrgPageAccess;
  }
  return { status: "denied", canManageOrganization: false } satisfies OrgPageAccess;
};

export const resolveOrgPageAccessResult = (
  result:
    | AsyncResult.Initial<unknown, unknown>
    | AsyncResult.Failure<unknown, unknown>
    | AsyncResult.Success<
        {
          readonly members: ReadonlyArray<Pick<MemberData, "isCurrentUser" | "role">>;
        },
        unknown
      >,
) => {
  if (AsyncResult.isWaiting(result) && AsyncResult.isFailure(result)) {
    return resolveOrgPageAccess({ status: "loading" });
  }
  if (AsyncResult.isInitial(result)) {
    return resolveOrgPageAccess({ status: "loading" });
  }
  if (AsyncResult.isFailure(result)) {
    return resolveOrgPageAccess({ status: "failed" });
  }
  return resolveOrgPageAccess({
    status: "resolved",
    role: result.value.members.find((member) => member.isCurrentUser)?.role,
  });
};

const organizationNameDraft = (
  organizationId: string | null,
  sourceName: string,
): OrganizationNameDraft => ({
  organizationId,
  sourceName,
  value: sourceName,
});

type InviteState = {
  email: string;
  roleSlug: string;
  status: "idle" | "sending" | "error";
};

const initialInviteState: InviteState = {
  email: "",
  roleSlug: "member",
  status: "idle",
};

type InviteAction =
  | { type: "setEmail"; email: string }
  | { type: "setRole"; roleSlug: string }
  | { type: "send" }
  | { type: "error" }
  | { type: "reset" };

function inviteReducer(state: InviteState, action: InviteAction): InviteState {
  return Match.value(action).pipe(
    Match.discriminator("type")("setEmail", (a) => ({
      ...state,
      email: a.email,
    })),
    Match.discriminator("type")("setRole", (a) => ({
      ...state,
      roleSlug: a.roleSlug,
    })),
    Match.discriminator("type")("send", () => ({
      ...state,
      status: "sending" as const,
    })),
    Match.discriminator("type")("error", () => ({
      ...state,
      status: "error" as const,
    })),
    Match.discriminator("type")("reset", () => initialInviteState),
    Match.exhaustive,
  );
}

function formatLastActive(lastActiveAt: string | null): string {
  if (!lastActiveAt) return "—";
  const date = new Date(lastActiveAt);
  const diffMins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function OrganizationPermissionNotice(props: { access: OrgPageAccess; onRetry: () => void }) {
  if (props.access.status === "denied") {
    return (
      <Info className="mb-8" data-testid="organization-permission-read-only">
        <InfoTitle>Read-only organization access</InfoTitle>
        <InfoDescription>
          An organization administrator manages names, domains, invitations, and member roles.
        </InfoDescription>
      </Info>
    );
  }

  if (props.access.status === "failed") {
    return (
      <Alert variant="destructive" className="mb-8" data-testid="organization-permission-failed">
        <AlertTitle>Organization permissions unavailable</AlertTitle>
        <AlertDescription>
          <p>
            Management controls are unavailable because your organization permissions could not be
            determined.
          </p>
          <Button size="sm" variant="outline" onClick={props.onRetry}>
            Retry permissions
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return null;
}

function OrganizationMembersSkeleton() {
  return (
    <div className="space-y-2" data-testid="organization-members-loading">
      {[1, 2, 3].map((index) => (
        <Skeleton key={index} className="h-14" />
      ))}
    </div>
  );
}

export function OrgPage(props: {
  domainsSection?: React.ReactNode | ((access: OrgPageAccess) => React.ReactNode);
}) {
  const auth = useAuth();
  const organizationId = auth.status === "authenticated" ? (auth.organization?.id ?? null) : null;
  const organizationName =
    auth.status === "authenticated" ? (auth.organization?.name ?? "Organization") : "Organization";
  const membersResult = useAtomValue(orgMembersAtom);
  const rolesResult = useAtomValue(orgRolesAtom);
  const refreshMembers = useAtomRefresh(orgMembersAtom);
  const doRemove = useAtomSet(removeMember, { mode: "promiseExit" });
  const doUpdateRole = useAtomSet(updateMemberRole, { mode: "promiseExit" });
  const doUpdateOrgName = useAtomSet(updateOrgName, { mode: "promiseExit" });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(() =>
    organizationNameDraft(organizationId, organizationName),
  );
  const [savingOrganizationId, setSavingOrganizationId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // A URL-driven organization switch can replace auth while this page remains
  // mounted. Associate the draft with its organization so stale text from the
  // previous workspace is never rendered or submitted during that transition.
  const activeNameDraft =
    nameDraft.organizationId === organizationId
      ? nameDraft
      : organizationNameDraft(organizationId, organizationName);
  const editName = activeNameDraft.value;
  const savingName = savingOrganizationId === organizationId;

  useEffect(() => {
    setNameDraft((current) => {
      if (current.organizationId !== organizationId) {
        return organizationNameDraft(organizationId, organizationName);
      }
      if (current.sourceName === organizationName) return current;
      return {
        organizationId,
        sourceName: organizationName,
        value: current.value === current.sourceName ? organizationName : current.value,
      };
    });
  }, [organizationId, organizationName]);

  const access = resolveOrgPageAccessResult(membersResult);
  const canManageOrganization = access.canManageOrganization;

  const roles = AsyncResult.match(rolesResult, {
    onInitial: () => [] as readonly RoleData[],
    onFailure: () => [] as readonly RoleData[],
    onSuccess: ({ value }) => value.roles,
  });

  const handleRemove = async (membershipId: string, name: string) => {
    const exit = await doRemove({
      params: { membershipId },
      reactivityKeys: orgMemberWriteKeys,
    });
    trackEvent("org_member_removed", { success: Exit.isSuccess(exit) });
    toast[Exit.isSuccess(exit) ? "success" : "error"](
      Exit.isSuccess(exit) ? `Removed ${name}` : "Failed to remove member",
    );
  };

  const handleChangeRole = async (membershipId: string, roleSlug: string, roleName: string) => {
    const exit = await doUpdateRole({
      params: { membershipId },
      payload: { roleSlug },
      reactivityKeys: orgMemberWriteKeys,
    });
    trackEvent("org_member_role_changed", { role: roleSlug, success: Exit.isSuccess(exit) });
    toast[Exit.isSuccess(exit) ? "success" : "error"](
      Exit.isSuccess(exit) ? `Role changed to ${roleName}` : "Failed to change role",
    );
  };

  const handleSaveName = async () => {
    if (!canManageOrganization || !organizationId) return;
    const trimmed = editName.trim();
    if (!trimmed || trimmed === organizationName) {
      setNameDraft(organizationNameDraft(organizationId, organizationName));
      return;
    }
    const targetOrganizationId = organizationId;
    setSavingOrganizationId(targetOrganizationId);
    const exit = await doUpdateOrgName({
      payload: { name: trimmed },
      reactivityKeys: orgInfoWriteKeys,
    });
    trackEvent("org_renamed", { success: Exit.isSuccess(exit) });
    if (Exit.isSuccess(exit)) {
      toast.success("Organization name updated");
    } else {
      toast.error("Failed to update organization name");
      setNameDraft((current) =>
        current.organizationId === targetOrganizationId
          ? organizationNameDraft(targetOrganizationId, organizationName)
          : current,
      );
    }
    setSavingOrganizationId((current) => (current === targetOrganizationId ? null : current));
  };

  const domainsSection =
    typeof props.domainsSection === "function"
      ? props.domainsSection(access)
      : props.domainsSection;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10 lg:px-8 lg:py-14">
        <div className="mb-8">
          <h1 className="font-display text-[2rem] tracking-tight text-foreground">Organization</h1>
        </div>

        <OrganizationPermissionNotice access={access} onRetry={refreshMembers} />

        <section className="mb-10">
          <Label
            htmlFor={canManageOrganization ? "org-name" : undefined}
            className="text-sm font-medium text-foreground"
          >
            Organization name
          </Label>
          {access.status === "loading" ? (
            <div
              role="status"
              className="mt-1.5"
              data-testid="organization-name-permission-loading"
            >
              <span className="sr-only">Checking organization permissions</span>
              <Skeleton className="h-9 w-full" />
            </div>
          ) : canManageOrganization ? (
            <div className="mt-1.5 flex items-end gap-3">
              <div className="min-w-0 flex-1">
                <Input
                  id="org-name"
                  value={editName}
                  onChange={(e) =>
                    setNameDraft({
                      organizationId,
                      sourceName: organizationName,
                      value: (e.target as HTMLInputElement).value,
                    })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSaveName();
                  }}
                  className="h-9 text-sm"
                />
              </div>
              {editName.trim() !== organizationName && editName.trim() !== "" && (
                <Button size="sm" onClick={() => void handleSaveName()} disabled={savingName}>
                  {savingName ? "Saving…" : "Save"}
                </Button>
              )}
            </div>
          ) : (
            <p className="mt-1.5 text-sm text-foreground">{organizationName}</p>
          )}
        </section>
        {domainsSection}

        <section className="mb-10">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-medium text-foreground">Members</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                People with access to this Executor instance.
              </p>
            </div>
            {access.status === "loading" ? (
              <Skeleton className="h-8 w-32" data-testid="organization-member-actions-loading" />
            ) : canManageOrganization ? (
              <Button size="sm" className="min-w-32" onClick={() => setInviteOpen(true)}>
                Invite member
              </Button>
            ) : null}
          </div>
          <Input
            type="text"
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => setSearch((e.target as HTMLInputElement).value)}
            className="mb-3 h-9 text-sm"
          />

          {access.status === "loading" ? (
            <OrganizationMembersSkeleton />
          ) : (
            AsyncResult.match(membersResult, {
              onInitial: () => <OrganizationMembersSkeleton />,
              onFailure: () => (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
                  <p className="text-sm text-destructive">Failed to load members</p>
                </div>
              ),
              onSuccess: ({ value }) => {
                const members = value.members;
                const filtered = search
                  ? members.filter(
                      (m: MemberData) =>
                        m.email.toLowerCase().includes(search.toLowerCase()) ||
                        (m.name?.toLowerCase().includes(search.toLowerCase()) ?? false),
                    )
                  : members;

                if (filtered.length === 0) {
                  return (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      {search ? "No matching members" : "No members yet"}
                    </p>
                  );
                }

                return (
                  <div className="space-y-px">
                    {filtered.map((member: MemberData) => (
                      <div
                        key={member.id}
                        className="group relative grid grid-cols-[2rem_1fr_6rem_5rem_2rem] items-center gap-3 rounded-lg border border-transparent px-4 py-3 transition-all hover:bg-muted/30"
                      >
                        {member.avatarUrl ? (
                          <img src={member.avatarUrl} alt="" className="size-8 rounded-full" />
                        ) : (
                          <div className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                            {member.name
                              ? member.name
                                  .split(" ")
                                  .map((n: string) => n[0])
                                  .join("")
                                  .slice(0, 2)
                                  .toUpperCase()
                              : member.email[0]!.toUpperCase()}
                          </div>
                        )}

                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-medium text-foreground leading-none">
                              {member.name ?? member.email}
                            </p>
                            {member.isCurrentUser && (
                              <Badge className="bg-muted text-muted-foreground">You</Badge>
                            )}
                            {member.status === "pending" && (
                              <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
                                Invited
                              </Badge>
                            )}
                          </div>
                          {member.name && (
                            <p className="mt-0.5 truncate text-xs text-muted-foreground leading-none">
                              {member.email}
                            </p>
                          )}
                        </div>

                        <p className="text-sm text-muted-foreground capitalize leading-none">
                          {member.role}
                        </p>

                        <p className="text-xs text-muted-foreground leading-none">
                          {formatLastActive(member.lastActiveAt)}
                        </p>

                        {canManageOrganization && !member.isCurrentUser ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7 opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                <svg viewBox="0 0 16 16" className="size-3">
                                  <circle cx="8" cy="3" r="1.2" fill="currentColor" />
                                  <circle cx="8" cy="8" r="1.2" fill="currentColor" />
                                  <circle cx="8" cy="13" r="1.2" fill="currentColor" />
                                </svg>
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44">
                              {roles.length > 0 && (
                                <>
                                  <DropdownMenuSub>
                                    <DropdownMenuSubTrigger className="text-xs">
                                      Change role
                                    </DropdownMenuSubTrigger>
                                    <DropdownMenuSubContent>
                                      {roles.map((role: RoleData) => (
                                        <DropdownMenuItem
                                          key={role.slug}
                                          className="text-xs"
                                          disabled={role.slug === member.role}
                                          onClick={() =>
                                            handleChangeRole(member.id, role.slug, role.name)
                                          }
                                        >
                                          {role.name}
                                        </DropdownMenuItem>
                                      ))}
                                    </DropdownMenuSubContent>
                                  </DropdownMenuSub>
                                  <DropdownMenuSeparator />
                                </>
                              )}
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive text-sm"
                                onClick={() => handleRemove(member.id, member.name ?? member.email)}
                              >
                                Remove member
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : (
                          <div />
                        )}
                      </div>
                    ))}
                  </div>
                );
              },
            })
          )}
        </section>

        {canManageOrganization && (
          <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} roles={roles} />
        )}
      </div>
    </div>
  );
}

function InviteDialog(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  roles: readonly RoleData[];
}) {
  const [state, dispatch] = useReducer(inviteReducer, initialInviteState);
  const doInvite = useAtomSet(inviteMember, { mode: "promiseExit" });

  const handleInvite = async () => {
    if (!state.email.trim()) return;
    dispatch({ type: "send" });
    const exit = await doInvite({
      payload: {
        email: state.email.trim(),
        ...(state.roleSlug ? { roleSlug: state.roleSlug } : {}),
      },
      reactivityKeys: orgMemberWriteKeys,
    });
    trackEvent("org_member_invited", { role: state.roleSlug, success: Exit.isSuccess(exit) });
    if (Exit.isSuccess(exit)) {
      toast.success(`Invitation sent to ${state.email.trim()}`);
      dispatch({ type: "reset" });
      props.onOpenChange(false);
      return;
    }
    dispatch({ type: "error" });
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(v) => {
        if (!v) dispatch({ type: "reset" });
        props.onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Invite member</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            Send an email invitation to join your organization.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-3">
          <div className="grid gap-1.5">
            <Label
              htmlFor="invite-email"
              className="text-sm font-medium uppercase tracking-wider text-muted-foreground"
            >
              Email
            </Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="colleague@company.com"
              value={state.email}
              onChange={(e) =>
                dispatch({
                  type: "setEmail",
                  email: (e.target as HTMLInputElement).value,
                })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") handleInvite();
              }}
              className="text-sm h-9"
            />
          </div>

          {props.roles.length > 0 && (
            <div className="grid gap-1.5">
              <Label
                htmlFor="invite-role"
                className="text-sm font-medium uppercase tracking-wider text-muted-foreground"
              >
                Role
              </Label>
              <Select
                value={state.roleSlug}
                onValueChange={(v) => dispatch({ type: "setRole", roleSlug: v })}
              >
                <SelectTrigger id="invite-role" className="h-9 text-sm">
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {props.roles.map((role) => (
                    <SelectItem key={role.slug} value={role.slug}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {state.status === "error" && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="text-sm text-destructive">
                Failed to send invitation. Please try again.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button
            size="sm"
            onClick={handleInvite}
            disabled={!state.email.trim() || state.status === "sending"}
          >
            {state.status === "sending" ? "Sending…" : "Send invite"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
