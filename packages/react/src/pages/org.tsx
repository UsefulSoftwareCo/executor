import { useReducer, useState } from "react";
import { Exit, Match } from "effect";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { toast } from "sonner";
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
import { Input } from "../components/input";
import { Label } from "../components/label";
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

type InviteState = {
  email: string;
  roleSlug: string;
  status: "idle" | "sending" | "error";
};

const initialInviteState: InviteState = { email: "", roleSlug: "member", status: "idle" };

type InviteAction =
  | { type: "setEmail"; email: string }
  | { type: "setRole"; roleSlug: string }
  | { type: "send" }
  | { type: "error" }
  | { type: "reset" };

function inviteReducer(state: InviteState, action: InviteAction): InviteState {
  return Match.value(action).pipe(
    Match.discriminator("type")("setEmail", (a) => ({ ...state, email: a.email })),
    Match.discriminator("type")("setRole", (a) => ({ ...state, roleSlug: a.roleSlug })),
    Match.discriminator("type")("send", () => ({ ...state, status: "sending" as const })),
    Match.discriminator("type")("error", () => ({ ...state, status: "error" as const })),
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

export function OrgPage() {
  const auth = useAuth();
  const organizationName =
    auth.status === "authenticated" ? (auth.organization?.name ?? "Organization") : "Organization";
  const membersResult = useAtomValue(orgMembersAtom);
  const rolesResult = useAtomValue(orgRolesAtom);
  const doRemove = useAtomSet(removeMember, { mode: "promiseExit" });
  const doUpdateRole = useAtomSet(updateMemberRole, { mode: "promiseExit" });
  const doUpdateOrgName = useAtomSet(updateOrgName, { mode: "promiseExit" });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editName, setEditName] = useState(organizationName);
  const [savingName, setSavingName] = useState(false);
  const [search, setSearch] = useState("");

  const roles = AsyncResult.match(rolesResult, {
    onInitial: () => [] as readonly RoleData[],
    onFailure: () => [] as readonly RoleData[],
    onSuccess: ({ value }) => value.roles,
  });

  const handleRemove = async (membershipId: string, name: string) => {
    const exit = await doRemove({ params: { membershipId }, reactivityKeys: orgMemberWriteKeys });
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
    toast[Exit.isSuccess(exit) ? "success" : "error"](
      Exit.isSuccess(exit) ? `Role changed to ${roleName}` : "Failed to change role",
    );
  };

  const handleSaveName = async () => {
    const trimmed = editName.trim();
    if (!trimmed || trimmed === organizationName) {
      setEditName(organizationName);
      return;
    }
    setSavingName(true);
    const exit = await doUpdateOrgName({
      payload: { name: trimmed },
      reactivityKeys: orgInfoWriteKeys,
    });
    if (Exit.isSuccess(exit)) {
      toast.success("Organization name updated");
    } else {
      toast.error("Failed to update organization name");
      setEditName(organizationName);
    }
    setSavingName(false);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10 lg:px-8 lg:py-14">
        <div className="mb-8">
          <h1 className="font-display text-[2rem] tracking-tight text-foreground">Organization</h1>
        </div>

        <section className="mb-10">
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <Label htmlFor="org-name" className="text-sm font-medium text-foreground">
                Organization name
              </Label>
              <Input
                id="org-name"
                value={editName}
                onChange={(e) => setEditName((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveName();
                }}
                className="mt-1.5 h-9 text-sm"
              />
            </div>
            {editName.trim() !== organizationName && editName.trim() !== "" && (
              <Button size="sm" onClick={handleSaveName} disabled={savingName}>
                {savingName ? "Saving…" : "Save"}
              </Button>
            )}
          </div>
        </section>

        <section className="mb-10">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-medium text-foreground">Members</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                People with access to this Executor instance.
              </p>
            </div>
            <Button size="sm" className="min-w-32" onClick={() => setInviteOpen(true)}>
              Invite member
            </Button>
          </div>
          <Input
            type="text"
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => setSearch((e.target as HTMLInputElement).value)}
            className="mb-3 h-9 text-sm"
          />

          {AsyncResult.match(membersResult, {
            onInitial: () => (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-14 animate-pulse rounded-lg bg-muted" />
                ))}
              </div>
            ),
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

                      {!member.isCurrentUser ? (
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
          })}
        </section>

        <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} roles={roles} />
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
                dispatch({ type: "setEmail", email: (e.target as HTMLInputElement).value })
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
