import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Avatar, AvatarFallback, AvatarImage } from "@executor-js/ui/components/avatar";
import { DisabledTooltip } from "@executor-js/ui/components/disabled-tooltip";
import { Button } from "@executor-js/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "@executor-js/ui/components/dialog";
import { Input } from "@executor-js/ui/components/input";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor-js/ui/components/select";
import { SearchInput } from "@executor-js/ui/dashboard/common";
import { ArrowDown01Icon, ArrowUp01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Exit, Option, type Schema } from "effect";
import { QueryResult } from "@executor-js/ui/dashboard/context";
import type { FailureProps } from "@executor-js/ui/contracts/dashboard";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { sessionAtom } from "../../contracts/auth.ts";
import {
  inviteAtom,
  membersAtom,
  removeMemberAtom,
  revokeInvitationAtom,
  updateMemberRoleAtom,
  type OrganizationFailed,
} from "../../contracts/organization.ts";
import { organizationError, useOrganization } from "./organization.tsx";

/** The table geometry is shared by the members table and its loading skeleton. */
const membershipPanelClass =
  "membership-panel border border-border rounded-[10px] bg-background shadow-none overflow-hidden";

const membershipTableClass =
  "membership-table w-full [table-layout:fixed] [border-collapse:collapse] text-left text-[13px] [&_th]:h-10.5 [&_th]:py-[7px] [&_th]:px-[16px] [&_th]:text-[12px] [&_th]:font-normal [&_th]:text-muted-foreground [&_td]:h-15 [&_td]:py-[10px] [&_td]:px-[16px] [&_td]:wrap-anywhere [&_tbody_tr]:[transition:background_120ms] [&_tbody_tr:hover]:[background:color-mix(in_srgb,_var(--foreground)_3%,_transparent)] [&_tbody_tr_+_tr]:border-t [&_tbody_tr_+_tr]:border-t-border [&_.membership-email]:w-[32%] [&_.membership-email]:text-muted-foreground [&_.membership-role]:w-45 [&_.membership-actions]:w-15 [&_.membership-actions]:pl-1 [&_.membership-actions]:pr-4 [&_.membership-actions]:text-right max-[800px]:[&_.membership-email]:hidden max-[800px]:[&_.membership-role]:w-35 max-[480px]:[&_th]:py-[10px] max-[480px]:[&_th]:px-[12px] max-[480px]:[&_td]:py-[10px] max-[480px]:[&_td]:px-[12px] max-[480px]:[&_.membership-role]:w-31 max-[480px]:[&_.membership-role]:pl-1 max-[480px]:[&_.membership-role]:pr-1 max-[480px]:[&_.membership-actions]:w-10.5 max-[480px]:[&_.membership-actions]:py-0 max-[480px]:[&_.membership-actions]:px-[4px]";

const membershipInvitationsClass =
  "membership-has-invitations [&_.membership-actions]:w-48 max-[480px]:[&_.membership-actions]:w-25.5 max-[480px]:[&_.membership-actions]:pr-1.5 max-[480px]:[&_.membership-actions_button]:py-0 max-[480px]:[&_.membership-actions_button]:px-[6px] max-[480px]:[&_.membership-actions_button]:text-[12px] max-[480px]:[&_.membership-actions_button]:min-h-10";

function MembersFailure({ cause, retry }: FailureProps<OrganizationFailed | Schema.SchemaError>) {
  return (
    <EmptyState
      size="compact"
      title="Members unavailable"
      role="alert"
      action={
        <Button variant="outline" onClick={retry}>
          Try again
        </Button>
      }
    >
      {organizationError(cause)}
    </EmptyState>
  );
}

/** Shared hosted membership view; the product's access and invitation delivery remain authoritative. */
export function OrganizationMembers({ emailInvitations }: { readonly emailInvitations: boolean }) {
  const organization = useOrganization();
  const members = useAtomValue(membersAtom(organization.organization));
  const retry = useAtomRefresh(membersAtom(organization.organization));
  const session = useAtomValue(sessionAtom);
  const userId = AsyncResult.isSuccess(session) ? session.value?.user.id : undefined;
  const invite = useAtomSet(inviteAtom(organization.organization), { mode: "promiseExit" });
  const remove = useAtomSet(removeMemberAtom(organization.organization), { mode: "promiseExit" });
  const revoke = useAtomSet(revokeInvitationAtom(organization.organization), {
    mode: "promiseExit",
  });
  const changeRole = useAtomSet(updateMemberRoleAtom(organization.organization), {
    mode: "promiseExit",
  });
  const inviting = useAtomValue(inviteAtom(organization.organization));
  const removing = useAtomValue(removeMemberAtom(organization.organization));
  const revoking = useAtomValue(revokeInvitationAtom(organization.organization));
  const changingRole = useAtomValue(updateMemberRoleAtom(organization.organization));
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [descending, setDescending] = useState(false);
  const [invitationOpen, setInvitationOpen] = useState(false);
  const [removal, setRemoval] = useState<{ id: string; name: string }>();
  const [revocation, setRevocation] = useState<{ id: string; email: string }>();
  const admin = organization.role !== "member";
  const loaded = Option.getOrUndefined(AsyncResult.value(members));
  const pending = loaded?.invitations.filter((invitation) => invitation.status === "pending");
  const matches = (value: string) => value.toLowerCase().includes(search.trim().toLowerCase());
  const rows = loaded
    ? [
        ...loaded.members.map((member) => ({
          id: `member:${member.id}`,
          member,
          name: member.user.name || member.user.email,
          email: member.user.email,
          role: member.role,
        })),
        ...(admin
          ? (pending ?? []).map((invitation) => ({
              id: `invitation:${invitation.id}`,
              invitation,
              name: invitation.email,
              email: invitation.email,
              role: invitation.role,
            }))
          : []),
      ]
        .filter((row) => matches(`${row.name} ${row.email}`))
        .sort((a, b) => a.name.localeCompare(b.name) * (descending ? -1 : 1))
    : [];
  const sendInvite = async (email: string, role: "admin" | "member") => {
    setError(null);
    setLink(null);
    const result = await invite({ email, role });
    if (Exit.isFailure(result)) setError(organizationError(result.cause));
    else if (result.value !== null)
      setLink(
        new URL(`/invite?invitation=${encodeURIComponent(result.value.id)}`, location.origin).href,
      );
  };

  return (
    <section
      className="organization-members mt-6 [&_>_.auth-error]:mt-4"
      aria-label="Organization members"
    >
      <div className="membership-list flex flex-col gap-3">
        <h2 className="membership-heading flex items-baseline gap-2 text-[14px] font-medium">
          Members
          {loaded && (
            <span className="membership-count text-muted-foreground text-[12px] font-normal tabular-nums">
              {loaded.members.length}
            </span>
          )}
          {admin && pending !== undefined && pending.length > 0 && (
            <span className="membership-count text-muted-foreground text-[12px] font-normal tabular-nums">
              · {pending.length} invited
            </span>
          )}
        </h2>
        <div className="membership-toolbar flex items-center justify-between gap-4 [&_.search-input]:flex-1 [&_.search-input]:max-w-130 [&_.search-input]:w-auto [&_.search-input_input]:h-9 [&_.search-input_input]:border-input [&_.search-input_input]:rounded-[6px] [&_.search-input_input]:bg-transparent [&_.search-input_>_svg]:top-2.75 [&_>_button]:h-9 [&_>_button]:rounded-[6px] [&_>_button]:text-[12px] [&_>_button]:bg-transparent [&_>_button]:shadow-none max-[480px]:gap-2.5 max-[480px]:[&_.search-input_input]:h-10.5 max-[480px]:[&_.search-input_input]:text-[14px] max-[480px]:[&_.search-input_>_svg]:top-3.5 max-[480px]:[&_>_button]:min-h-10.5 max-[480px]:[&_>_button]:py-0 max-[480px]:[&_>_button]:px-[12px]">
          <SearchInput placeholder="Search by name or email…" value={search} onChange={setSearch} />
          {admin ? (
            <Dialog
              open={invitationOpen}
              onOpenChange={(open) => {
                if (inviting.waiting) return;
                setInvitationOpen(open);
                setError(null);
                setLink(null);
              }}
            >
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  Add member
                </Button>
              </DialogTrigger>
              <DialogContent className="membership-invite-dialog max-h-[calc(100dvh_-_32px)] overflow-y-auto [&_.settings-form]:[margin:4px_0_0] [&_.settings-form]:max-w-none">
                <DialogTitle>Add member</DialogTitle>
                <DialogDescription>Invite someone to {organization.name}.</DialogDescription>
                <form
                  className="settings-form [&_h2]:text-[15px] [&_h2]:font-medium flex flex-col gap-4 w-full max-w-100 mt-7 [&_label]:flex [&_label]:flex-col [&_label]:gap-1.5 [&_label]:text-[13px] [&_>_button]:self-start"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    await sendInvite(
                      String(form.get("email")).trim(),
                      form.get("role") === "admin" ? "admin" : "member",
                    );
                  }}
                >
                  <label>
                    Email
                    <Input
                      name="email"
                      type="email"
                      placeholder="name@example.com"
                      required
                      disabled={inviting.waiting}
                    />
                  </label>
                  <label>
                    Role
                    <Select name="role" defaultValue="member" disabled={inviting.waiting}>
                      <SelectTrigger aria-label="Invitation role" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  {link && <InvitationLink link={link} emailInvitations={emailInvitations} />}
                  {error && (
                    <p className="auth-error text-destructive text-[13px]" role="alert">
                      {error}
                    </p>
                  )}
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={inviting.waiting}
                      onClick={() => {
                        setInvitationOpen(false);
                        setError(null);
                        setLink(null);
                      }}
                    >
                      {link ? "Done" : "Cancel"}
                    </Button>
                    <Button loading={inviting.waiting}>
                      {emailInvitations ? "Send invitation" : "Create invite link"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabledReason="Only organization owners and admins can invite members."
            >
              Add member
            </Button>
          )}
        </div>

        <QueryResult
          result={members}
          Failure={MembersFailure}
          retry={retry}
          pending={<MembersSkeleton />}
        >
          {() => (
            <div className={membershipPanelClass}>
              <table
                className={`${membershipTableClass}${admin && pending?.length ? ` ${membershipInvitationsClass}` : ""}`}
                aria-label="Members"
              >
                <thead>
                  <tr>
                    <th scope="col" aria-sort={descending ? "descending" : "ascending"}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="membership-sort -ml-2.5 py-0 px-[10px] text-foreground text-[12px] font-normal bg-transparent"
                        onClick={() => setDescending((value) => !value)}
                      >
                        Name
                        <HugeiconsIcon
                          icon={descending ? ArrowDown01Icon : ArrowUp01Icon}
                          size={14}
                          aria-hidden
                        />
                      </Button>
                    </th>
                    <th scope="col" className="membership-email">
                      Email
                    </th>
                    <th
                      scope="col"
                      className="membership-role [&_[data-slot='select-trigger']]:w-full [&_[data-slot='select-trigger']]:border-input [&_[data-slot='select-trigger']]:rounded-[6px] [&_[data-slot='select-trigger']]:bg-transparent [&_[data-slot='select-trigger']]:shadow-none max-[480px]:[&_[data-slot='select-trigger']]:min-h-10"
                    >
                      Role
                    </th>
                    <th scope="col" className="membership-actions">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const member = "member" in row ? row.member : undefined;
                    const invitation = "invitation" in row ? row.invitation : undefined;
                    return (
                      <tr key={row.id}>
                        <td>
                          <div className="membership-person flex items-center gap-2.5 min-w-0 [&_[data-slot='avatar']]:w-7 [&_[data-slot='avatar']]:h-7 [&_[data-slot='avatar']]:shrink-0 [&_[data-slot='avatar-fallback']]:bg-input [&_[data-slot='avatar-fallback']]:text-[10px] max-[480px]:items-start max-[480px]:gap-2 max-[480px]:[&_[data-slot='avatar']]:w-6 max-[480px]:[&_[data-slot='avatar']]:h-6">
                            <MemberAvatar name={row.name} image={member?.user.image ?? null} />
                            <div className="membership-identity min-w-0">
                              <div className="membership-person-name flex flex-wrap items-center gap-[6px_8px]">
                                {invitation ? (
                                  <span className="membership-invitation-status py-[2px] px-[6px] border border-border rounded-[4px] text-muted-foreground text-[11px]">
                                    {/* oxlint-disable-next-line react/purity -- expiry is compared against the render time */}
                                    {new Date(invitation.expiresAt).getTime() <= Date.now()
                                      ? "Expired invite"
                                      : "Invited"}
                                  </span>
                                ) : (
                                  <span>{row.name}</span>
                                )}
                                {member && member.userId === userId && (
                                  <span className="membership-you text-muted-foreground text-[11px]">
                                    You
                                  </span>
                                )}
                              </div>
                              <span className="membership-mobile-email hidden max-[800px]:block max-[800px]:mt-0.75 max-[800px]:text-[12px] max-[800px]:text-muted-foreground max-[800px]:wrap-anywhere">
                                {row.email}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td className="membership-email">{row.email}</td>
                        <td className="membership-role [&_[data-slot='select-trigger']]:w-full [&_[data-slot='select-trigger']]:border-input [&_[data-slot='select-trigger']]:rounded-[6px] [&_[data-slot='select-trigger']]:bg-transparent [&_[data-slot='select-trigger']]:shadow-none max-[480px]:[&_[data-slot='select-trigger']]:min-h-10">
                          {admin && member && member.role !== "owner" ? (
                            <Select
                              value={member.role}
                              disabled={changingRole.waiting}
                              onValueChange={async (role) => {
                                if (role !== "admin" && role !== "member") return;
                                setError(null);
                                const result = await changeRole({ memberId: member.id, role });
                                if (Exit.isFailure(result))
                                  setError(organizationError(result.cause));
                              }}
                            >
                              <SelectTrigger aria-label={`Role for ${member.user.email}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="member">Member</SelectItem>
                                <SelectItem value="admin">Admin</SelectItem>
                              </SelectContent>
                            </Select>
                          ) : member ? (
                            <DisabledTooltip
                              className="w-full"
                              reason={
                                member.role === "owner"
                                  ? "The organization owner’s role cannot be changed here."
                                  : "Only organization owners and admins can change member roles."
                              }
                            >
                              <Select value={member.role} disabled>
                                <SelectTrigger
                                  className="w-full"
                                  aria-label={`Role for ${member.user.email}`}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="member">Member</SelectItem>
                                  <SelectItem value="admin">Admin</SelectItem>
                                  <SelectItem value="owner">Owner</SelectItem>
                                </SelectContent>
                              </Select>
                            </DisabledTooltip>
                          ) : (
                            <span className="capitalize text-muted-foreground">{row.role}</span>
                          )}
                        </td>
                        <td className="membership-actions">
                          {invitation ? (
                            <div className="membership-invite-actions flex items-center justify-end flex-wrap gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={inviting.waiting || revoking.waiting}
                                onClick={async () => {
                                  if (invitation.role === "admin" || invitation.role === "member")
                                    await sendInvite(invitation.email, invitation.role);
                                }}
                              >
                                {emailInvitations ? "Resend" : "Get invite link"}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                disabled={inviting.waiting || revoking.waiting}
                                aria-label={`Revoke invitation to ${invitation.email}`}
                                title="Revoke invitation"
                                className="membership-remove text-muted-foreground hover:text-destructive hover:[background:color-mix(in_srgb,_var(--destructive)_8%,_transparent)] max-[480px]:min-h-10"
                                onClick={() => {
                                  setError(null);
                                  setRevocation({ id: invitation.id, email: invitation.email });
                                }}
                              >
                                <HugeiconsIcon icon={Delete02Icon} size={17} aria-hidden />
                              </Button>
                            </div>
                          ) : (
                            member && (
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Remove ${member.user.name || member.user.email}`}
                                title="Remove member"
                                disabledReason={
                                  !admin
                                    ? "Only organization owners and admins can remove members."
                                    : member.role === "owner"
                                      ? "The organization owner cannot be removed here."
                                      : member.userId === userId
                                        ? "You cannot remove yourself here."
                                        : undefined
                                }
                                className="membership-remove text-muted-foreground hover:text-destructive hover:[background:color-mix(in_srgb,_var(--destructive)_8%,_transparent)] max-[480px]:min-h-10"
                                onClick={() => {
                                  setError(null);
                                  setRemoval({
                                    id: member.id,
                                    name: member.user.name || member.user.email,
                                  });
                                }}
                              >
                                <HugeiconsIcon icon={Delete02Icon} size={17} aria-hidden />
                              </Button>
                            )
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {rows.length === 0 && (
                <div className="p-4">
                  <EmptyState
                    size="compact"
                    title={search ? "No matching members" : "No members yet"}
                  >
                    {search
                      ? "No members or invitations match your search."
                      : "Invite someone to join this organization."}
                  </EmptyState>
                </div>
              )}
            </div>
          )}
        </QueryResult>
      </div>
      {error && !removal && !revocation && !invitationOpen && (
        <p className="auth-error text-destructive text-[13px]" role="alert">
          {error}
        </p>
      )}
      {link && !invitationOpen && (
        <div className="membership-invite-result max-w-140 mt-4">
          <InvitationLink link={link} emailInvitations={emailInvitations} />
        </div>
      )}
      <Dialog
        open={revocation !== undefined}
        onOpenChange={(open) => {
          if (!open && !revoking.waiting) {
            setRevocation(undefined);
            setError(null);
          }
        }}
      >
        <DialogContent>
          <DialogTitle>Revoke invitation?</DialogTitle>
          <DialogDescription>
            {revocation?.email} will no longer be able to join {organization.name} with this
            invitation. You can invite them again later.
          </DialogDescription>
          {error && (
            <p className="auth-error text-destructive text-[13px]" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={revoking.waiting}
              onClick={() => {
                setRevocation(undefined);
                setError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={revoking.waiting}
              onClick={async () => {
                if (!revocation || revoking.waiting) return;
                setError(null);
                const result = await revoke(revocation.id);
                if (Exit.isFailure(result)) setError(organizationError(result.cause));
                else {
                  setRevocation(undefined);
                  setLink(null);
                }
              }}
            >
              Revoke invitation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={removal !== undefined}
        onOpenChange={(open) => {
          if (!open && !removing.waiting) {
            setRemoval(undefined);
            setError(null);
          }
        }}
      >
        <DialogContent>
          <DialogTitle>Remove {removal?.name}?</DialogTitle>
          <DialogDescription>
            They will lose access to {organization.name}. You can invite them again later.
          </DialogDescription>
          {error && (
            <p className="auth-error text-destructive text-[13px]" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={removing.waiting}
              onClick={() => {
                setRemoval(undefined);
                setError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={removing.waiting}
              onClick={async () => {
                if (!removal) return;
                setError(null);
                const result = await remove(removal.id);
                if (Exit.isFailure(result)) setError(organizationError(result.cause));
                else setRemoval(undefined);
              }}
            >
              Remove member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** Placeholder widths vary per row so the loading table does not look like a grid. */
const membershipSkeletonRows = [
  { name: "w-28", email: "w-40" },
  { name: "w-22", email: "w-32" },
  { name: "w-32", email: "w-45" },
  { name: "w-24", email: "w-36" },
  { name: "w-30", email: "w-42" },
];

/** Placeholder rows keep the members table's columns and row height while it loads. */
function MembersSkeleton() {
  return (
    <div className={membershipPanelClass} role="status" aria-label="Loading members">
      <table className={membershipTableClass} aria-hidden>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col" className="membership-email">
              Email
            </th>
            <th scope="col" className="membership-role">
              Role
            </th>
            <th scope="col" className="membership-actions">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {membershipSkeletonRows.map((row, index) => (
            <tr key={index}>
              <td>
                <div className="membership-person flex items-center gap-2.5 min-w-0 max-[480px]:gap-2">
                  <Skeleton className="w-7 h-7 shrink-0 rounded-full max-[480px]:w-6 max-[480px]:h-6" />
                  <Skeleton className={`h-3 max-w-full ${row.name}`} />
                </div>
              </td>
              <td className="membership-email">
                <Skeleton className={`h-3 max-w-full ${row.email}`} />
              </td>
              <td className="membership-role">
                <Skeleton className="h-8.75 w-full rounded-[6px] max-[480px]:h-10" />
              </td>
              <td className="membership-actions">
                <Skeleton className="w-8 h-8 ml-auto rounded-[6px]" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <span className="sr-only">Loading members…</span>
    </div>
  );
}

function InvitationLink({
  link,
  emailInvitations,
}: {
  readonly link: string;
  readonly emailInvitations: boolean;
}) {
  return (
    <label className="membership-invite-link flex flex-col gap-2 text-[13px]">
      <span role="status">
        {emailInvitations ? "Invitation sent. You can also share this link" : "Share this link"}
      </span>
      <Input
        aria-label="Invitation link"
        readOnly
        value={link}
        onFocus={(event) => event.target.select()}
      />
      <span className="muted text-muted-foreground">
        The recipient must sign in with the invited email.
      </span>
    </label>
  );
}

function MemberAvatar({ name, image }: { readonly name: string; readonly image: string | null }) {
  const initials = name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <Avatar size="sm" aria-hidden>
      <AvatarImage src={image ?? undefined} alt="" />
      <AvatarFallback>{initials || "?"}</AvatarFallback>
    </Avatar>
  );
}
