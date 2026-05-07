import { useReducer, useState } from "react";
import { Cause, Exit, Match, Result } from "effect";
import { Forbidden } from "../org/api";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useCustomer } from "autumn-js/react";
import { toast } from "sonner";
import {
  orgMemberWriteKeys,
  orgDomainWriteKeys,
  orgInfoWriteKeys,
} from "@executor-js/react/api/reactivity-keys";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@executor-js/react/components/dialog";
import { Button } from "@executor-js/react/components/button";
import { Badge } from "@executor-js/react/components/badge";
import { CopyButton } from "@executor-js/react/components/copy-button";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor-js/react/components/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@executor-js/react/components/dropdown-menu";
import {
  orgMembersAtom,
  orgRolesAtom,
  orgDomainsAtom,
  inviteMember,
  removeMember,
  updateMemberRole,
  getDomainVerificationLink,
  deleteDomain,
  updateOrgName,
} from "../web/org-atoms";
import { useAuth } from "../web/auth";

export const Route = createFileRoute("/org")({
  component: OrgPage,
});

type InviteState = {
  email: string;
  roleSlug: string;
  status: "idle" | "sending" | "error";
  failure: Cause.Cause<unknown> | null;
};

const initialInviteState: InviteState = {
  email: "",
  roleSlug: "member",
  status: "idle",
  failure: null,
};

type InviteAction =
  | { type: "setEmail"; email: string }
  | { type: "setRole"; roleSlug: string }
  | { type: "send" }
  | { type: "error"; cause: Cause.Cause<unknown> }
  | { type: "reset" };

function inviteReducer(state: InviteState, action: InviteAction): InviteState {
  return Match.value(action).pipe(
    Match.discriminator("type")("setEmail", (a) => ({ ...state, email: a.email })),
    Match.discriminator("type")("setRole", (a) => ({ ...state, roleSlug: a.roleSlug })),
    Match.discriminator("type")("send", () => ({
      ...state,
      status: "sending" as const,
      failure: null,
    })),
    Match.discriminator("type")("error", (a) => ({
      ...state,
      status: "error" as const,
      failure: a.cause,
    })),
    Match.discriminator("type")("reset", () => initialInviteState),
    Match.exhaustive,
  );
}

function formatLastActive(lastActiveAt: string | null): string {
  if (!lastActiveAt) return "\u2014";
  const date = new Date(lastActiveAt);
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function OrgPage() {
  const auth = useAuth();
  const orgName =
    auth.status === "authenticated" ? (auth.organization?.name ?? "Organization") : "Organization";
  const membersResult = useAtomValue(orgMembersAtom);
  const rolesResult = useAtomValue(orgRolesAtom);
  const domainsResult = useAtomValue(orgDomainsAtom);
  const doRemove = useAtomSet(removeMember, { mode: "promiseExit" });
  const doUpdateRole = useAtomSet(updateMemberRole, { mode: "promiseExit" });
  const doDeleteDomain = useAtomSet(deleteDomain, { mode: "promiseExit" });
  const doGetVerificationLink = useAtomSet(getDomainVerificationLink, { mode: "promiseExit" });
  const doUpdateOrgName = useAtomSet(updateOrgName, { mode: "promiseExit" });
  const { check, isLoading: customerLoading } = useCustomer();
  const canUseDomains = customerLoading
    ? false
    : check({ featureId: "domain-verification" }).allowed;
  const seats = AsyncResult.match(membersResult, {
    onInitial: () => null,
    onFailure: () => null,
    onSuccess: ({ value }) => value.seats ?? null,
  });
  const canInviteMember = !seats ? false : seats.unlimited || seats.used < seats.granted;
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editName, setEditName] = useState(orgName);
  const [savingName, setSavingName] = useState(false);
  const [search, setSearch] = useState("");

  const roles = AsyncResult.match(rolesResult, {
    onInitial: () => [] as readonly { slug: string; name: string }[],
    onFailure: () => [] as readonly { slug: string; name: string }[],
    onSuccess: ({ value }) => value.roles,
  });

  const handleRemove = async (membershipId: string, name: string) => {
    const exit = await doRemove({ params: { membershipId }, reactivityKeys: orgMemberWriteKeys });
    if (Exit.isSuccess(exit)) {
      toast.success(`Removed ${name}`);
    } else {
      toast.error("Failed to remove member");
    }
  };

  const handleChangeRole = async (membershipId: string, roleSlug: string, roleName: string) => {
    const exit = await doUpdateRole({
      params: { membershipId },
      payload: { roleSlug },
      reactivityKeys: orgMemberWriteKeys,
    });
    if (Exit.isSuccess(exit)) {
      toast.success(`Role changed to ${roleName}`);
    } else {
      toast.error("Failed to change role");
    }
  };

  const handleSaveName = async () => {
    const trimmed = editName.trim();
    if (!trimmed || trimmed === orgName) {
      setEditName(orgName);
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
      setEditName(orgName);
    }
    setSavingName(false);
  };

  const handleDeleteDomain = async (domainId: string, domain: string) => {
    const exit = await doDeleteDomain({
      params: { domainId },
      reactivityKeys: orgDomainWriteKeys,
    });
    if (Exit.isSuccess(exit)) {
      toast.success(`Removed ${domain}`);
    } else {
      toast.error("Failed to remove domain");
    }
  };

  const handleAddDomain = async () => {
    const exit = await doGetVerificationLink({ reactivityKeys: orgDomainWriteKeys });
    if (Exit.isSuccess(exit)) {
      window.open(exit.value.link, "_blank");
    } else {
      toast.error("Failed to generate verification link");
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10 lg:px-8 lg:py-14">
        {/* Header */}
        <div className="mb-8">
          <h1 className="font-display text-[2rem] tracking-tight text-foreground">Organization</h1>
        </div>

        {/* Settings */}
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
            {editName.trim() !== orgName && editName.trim() !== "" && (
              <Button size="sm" onClick={handleSaveName} disabled={savingName}>
                {savingName ? "Saving\u2026" : "Save"}
              </Button>
            )}
          </div>
        </section>

        {/* Domains */}
        <section className="mb-10">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-medium text-foreground">Domains</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Verify a domain to let anyone with a matching email join automatically.
              </p>
            </div>
            <Button
              size="sm"
              className="min-w-32"
              disabled={!canUseDomains}
              onClick={handleAddDomain}
            >
              Add domain
            </Button>
          </div>

          {!canUseDomains && (
            <div className="mb-3 flex items-center justify-between rounded-lg border border-border px-4 py-3">
              <p className="text-sm text-muted-foreground">
                Join by domain is available on the Team plan.
              </p>
              <Link to="/billing/plans">
                <Button size="sm" variant="outline">
                  Upgrade
                </Button>
              </Link>
            </div>
          )}

          {AsyncResult.match(domainsResult, {
            onInitial: () => (
              <div className="space-y-3">
                {[1, 2].map((i) => (
                  <div key={i} className="h-16 animate-pulse rounded-lg bg-muted/50" />
                ))}
              </div>
            ),
            onFailure: () => (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
                <p className="text-sm text-destructive">Failed to load domains</p>
              </div>
            ),
            onSuccess: ({ value }) => {
              if (value.domains.length === 0) {
                if (!canUseDomains) return null;
                return (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No domains yet. Add your company domain so members can join without an invite.
                  </p>
                );
              }

              return (
                <div className="space-y-2">
                  {value.domains.map((d: DomainData) => (
                    <DomainCard
                      key={d.id}
                      domain={d}
                      onDelete={() => handleDeleteDomain(d.id, d.domain)}
                    />
                  ))}
                </div>
              );
            },
          })}
        </section>

        {/* Members */}
        <section className="mb-10">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-medium text-foreground">Members</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Free organizations can include up to 3 members.
              </p>
            </div>
            {canInviteMember ? (
              <Button size="sm" className="min-w-32" onClick={() => setInviteOpen(true)}>
                Invite member
              </Button>
            ) : (
              <Link to="/billing/plans">
                <Button size="sm" className="min-w-32">
                  Upgrade
                </Button>
              </Link>
            )}
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
                      {/* Avatar */}
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

                      {/* Name + email */}
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

                      {/* Role */}
                      <p className="text-sm text-muted-foreground capitalize leading-none">
                        {member.role}
                      </p>

                      {/* Last active */}
                      <p className="text-xs text-muted-foreground leading-none">
                        {formatLastActive(member.lastActiveAt)}
                      </p>

                      {/* Actions */}
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
                                        {role.slug === member.role && (
                                          <span className="ml-auto text-muted-foreground">
                                            <svg viewBox="0 0 16 16" fill="none" className="size-3">
                                              <path
                                                d="M3.5 8.5L6.5 11.5L12.5 5"
                                                stroke="currentColor"
                                                strokeWidth="1.5"
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                              />
                                            </svg>
                                          </span>
                                        )}
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

type DomainData = {
  id: string;
  domain: string;
  state: string;
  verificationToken?: string;
  verificationPrefix?: string;
};

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

type RoleData = {
  slug: string;
  name: string;
};

function DomainCard({ domain: d, onDelete }: { domain: DomainData; onDelete: () => void }) {
  const isVerified = d.state === "verified";
  const isPending = d.state === "pending";

  const recordValue = d.verificationPrefix
    ? `${d.verificationPrefix}=${d.verificationToken}`
    : (d.verificationToken ?? "");

  const copyPromptValue = `Add a DNS TXT record for domain verification:\n\nDomain: ${d.domain}\nRecord name: @\nRecord value: ${recordValue}\n\nPlease add this TXT record to my DNS configuration.`;

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-foreground">{d.domain}</p>
            <Badge
              className={
                isVerified
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : isPending
                    ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    : "bg-destructive/10 text-destructive"
              }
            >
              {isVerified ? "Verified" : isPending ? "Pending" : "Failed"}
            </Badge>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7">
                <svg viewBox="0 0 16 16" className="size-3">
                  <circle cx="8" cy="3" r="1.2" fill="currentColor" />
                  <circle cx="8" cy="8" r="1.2" fill="currentColor" />
                  <circle cx="8" cy="13" r="1.2" fill="currentColor" />
                </svg>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                className="text-destructive focus:text-destructive text-sm"
                onClick={onDelete}
              >
                Remove domain
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {!isVerified && d.verificationToken && (
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Add this TXT record to your DNS provider to verify ownership.
            </p>
            <CopyButton value={copyPromptValue} label="Copy prompt" />
          </div>
          <div className="mt-3 grid grid-cols-[4rem_3.5rem_1fr] items-center gap-y-2">
            <p className="text-xs font-medium text-muted-foreground">Type</p>
            <p className="text-xs font-medium text-muted-foreground">Name</p>
            <p className="text-xs font-medium text-muted-foreground">Value</p>
            <p className="text-sm font-mono text-foreground">TXT</p>
            <p className="text-sm font-mono text-foreground">@</p>
            <span className="inline-flex min-w-0 items-center gap-1">
              <code className="truncate text-sm font-mono text-foreground">{recordValue}</code>
              <CopyButton value={recordValue} />
            </span>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            DNS changes can take up to 72 hours to propagate, but usually complete within a few
            minutes.
          </p>
        </div>
      )}
    </div>
  );
}

function InviteErrorAlert({ cause }: { cause: Cause.Cause<unknown> }) {
  const failure = Cause.findError(cause);
  const error = Result.isSuccess(failure) ? failure.success : null;

  if (error instanceof Forbidden) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
        <p className="text-sm text-destructive">
          You've reached your member limit. Upgrade to Team to invite more.
        </p>
        <Link to="/billing/plans">
          <Button size="sm" variant="outline">
            Upgrade
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
      <p className="text-sm text-destructive">Failed to send invitation. Please try again.</p>
    </div>
  );
}

function InviteDialog(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  roles: readonly { slug: string; name: string }[];
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
    dispatch({ type: "error", cause: exit.cause });
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

          {state.status === "error" && state.failure && <InviteErrorAlert cause={state.failure} />}
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
