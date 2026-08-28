import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Exit } from "effect";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { toast } from "@executor-js/react/components/sonner";

import { Button } from "@executor-js/react/components/button";
import { CopyButton } from "@executor-js/react/components/copy-button";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import { NativeSelect, NativeSelectOption } from "@executor-js/react/components/native-select";
import { PageContainer, PageHeader } from "@executor-js/react/components/page";
import { Skeleton } from "@executor-js/react/components/skeleton";
import { useExecutorDocumentTitle } from "@executor-js/react/lib/document-title";
import {
  orgMembersAtom,
  removeMember,
  updateMemberRole,
} from "@executor-js/react/api/account-atoms";
import { orgMemberWriteKeys } from "@executor-js/react/api/reactivity-keys";

import { createInvite, invitesAtom, inviteWriteKeys, revokeInvite } from "../../admin-atoms";

export const Route = createFileRoute("/{-$orgSlug}/admin")({
  component: AdminPage,
});

const ROLES = ["member", "admin"] as const;

// Instance admin console. Members reuse the shared account atoms; invite codes
// are the self-host join mechanism. The API gates to owner/admin, so a
// non-admin who opens this just sees load failures.
function AdminPage() {
  useExecutorDocumentTitle("Admin");
  return (
    <PageContainer>
      <PageHeader title="Admin" description="Manage members and invite links for this instance." />
      <div className="space-y-10">
        <MembersSection />
        <InvitesSection />
      </div>
    </PageContainer>
  );
}

function MembersSection() {
  const result = useAtomValue(orgMembersAtom);
  const [roleState, doUpdateRole] = useAtom(updateMemberRole, { mode: "promiseExit" });
  const [removeState, doRemove] = useAtom(removeMember, { mode: "promiseExit" });
  // The mutation atoms carry their own in-flight state — no manual busy tracking.
  const busy = AsyncResult.isWaiting(roleState) || AsyncResult.isWaiting(removeState);

  const changeRole = async (membershipId: string, roleSlug: string) => {
    const exit = await doUpdateRole({
      params: { membershipId },
      payload: { roleSlug },
      reactivityKeys: orgMemberWriteKeys,
    });
    toast[Exit.isSuccess(exit) ? "success" : "error"](
      Exit.isSuccess(exit) ? "Role updated" : "Failed to update role",
    );
  };

  const remove = async (membershipId: string, label: string) => {
    const exit = await doRemove({ params: { membershipId }, reactivityKeys: orgMemberWriteKeys });
    toast[Exit.isSuccess(exit) ? "success" : "error"](
      Exit.isSuccess(exit) ? `Removed ${label}` : "Failed to remove member",
    );
  };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-foreground">Members</h2>
      {AsyncResult.match(result, {
        onInitial: () => <MembersSkeleton />,
        onFailure: () => <Notice tone="destructive">Admin access required.</Notice>,
        onSuccess: ({ value }) => (
          <div className="divide-y divide-border rounded-lg border border-border">
            {value.members.map((member) => {
              const isOwner = member.role === "owner";
              return (
                <div key={member.id} className="flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">
                      {member.name ?? member.email}
                      {member.isCurrentUser ? " (you)" : ""}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                  </div>
                  {isOwner || member.isCurrentUser ? (
                    <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                      {member.role}
                    </span>
                  ) : (
                    <>
                      <NativeSelect
                        className="text-xs"
                        value={member.role === "admin" ? "admin" : "member"}
                        disabled={busy}
                        onChange={(e) => changeRole(member.id, e.target.value)}
                      >
                        {ROLES.map((role) => (
                          <NativeSelectOption key={role} value={role}>
                            {role}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => remove(member.id, member.name ?? member.email)}
                      >
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ),
      })}
    </section>
  );
}

function InvitesSection() {
  const result = useAtomValue(invitesAtom);
  const [createState, doCreate] = useAtom(createInvite, { mode: "promiseExit" });
  const [, doRevoke] = useAtom(revokeInvite, { mode: "promiseExit" });
  const [role, setRole] = useState<string>("member");
  const [label, setLabel] = useState("");
  const creating = AsyncResult.isWaiting(createState);

  const create = async () => {
    const exit = await doCreate({
      payload: { role, label: label.trim() || undefined },
      reactivityKeys: inviteWriteKeys,
    });
    if (Exit.isSuccess(exit)) {
      setLabel("");
      setRole("member");
      toast.success("Invite link created");
      return;
    }
    toast.error("Failed to create invite");
  };

  const revoke = async (inviteId: string) => {
    const exit = await doRevoke({ params: { inviteId }, reactivityKeys: inviteWriteKeys });
    toast[Exit.isSuccess(exit) ? "success" : "error"](
      Exit.isSuccess(exit) ? "Invite revoked" : "Failed to revoke invite",
    );
  };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-foreground">Invite links</h2>
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-3">
        <div className="space-y-1.5">
          <Label htmlFor="invite-label">Label (optional)</Label>
          <Input
            id="invite-label"
            placeholder="e.g. Alex"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="invite-role">Role</Label>
          <NativeSelect id="invite-role" value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => (
              <NativeSelectOption key={r} value={r}>
                {r}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Button onClick={create} disabled={creating}>
          {creating ? "Creating…" : "Create invite"}
        </Button>
      </div>

      {AsyncResult.match(result, {
        onInitial: () => <InvitesSkeleton />,
        onFailure: () => <Notice tone="destructive">Admin access required.</Notice>,
        onSuccess: ({ value }) => {
          const pending = value.invites.filter((i) => !i.usedAt);
          const used = value.invites.filter((i) => i.usedAt);
          return (
            <div className="space-y-4">
              {pending.length > 0 && (
                <div className="divide-y divide-border rounded-lg border border-border">
                  {pending.map((invite) => (
                    <div key={invite.id} className="flex items-center gap-3 p-3 text-sm">
                      <span className="font-mono text-xs">{invite.code}</span>
                      <span className="flex-1 truncate text-muted-foreground">
                        {invite.label ? `${invite.label} · ` : ""}
                        {invite.role}
                      </span>
                      <CopyButton value={`${window.location.origin}/join/${invite.code}`} />
                      <Button variant="ghost" size="sm" onClick={() => revoke(invite.id)}>
                        Revoke
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {used.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Redeemed</p>
                  <div className="divide-y divide-border rounded-lg border border-border">
                    {used.map((invite) => (
                      <div key={invite.id} className="flex items-center gap-3 p-3 text-sm">
                        <span className="font-mono text-xs text-muted-foreground">
                          {invite.code}
                        </span>
                        <span className="flex-1 truncate text-muted-foreground">
                          {invite.label ? `${invite.label} · ` : ""}
                          used by {invite.usedByEmail}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {pending.length === 0 && used.length === 0 && (
                <Notice>No invite links yet — create one to add someone.</Notice>
              )}
            </div>
          );
        },
      })}
    </section>
  );
}

function MembersSkeleton() {
  return (
    <div className="divide-y divide-border rounded-lg border border-border">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-3 p-3">
          <Skeleton className="size-8 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-14 rounded-md" />
        </div>
      ))}
    </div>
  );
}

function InvitesSkeleton() {
  return (
    <div className="divide-y divide-border rounded-lg border border-border">
      <div className="flex items-center gap-3 p-3">
        <Skeleton className="h-3.5 w-28" />
        <Skeleton className="h-3.5 w-32 flex-1" />
        <Skeleton className="size-8 rounded-md" />
        <Skeleton className="h-8 w-14 rounded-md" />
      </div>
    </div>
  );
}

function Notice({ children, tone }: { children: React.ReactNode; tone?: "destructive" }) {
  return (
    <div
      className={`rounded-md border border-border bg-card p-4 text-sm ${
        tone === "destructive" ? "text-destructive" : "text-muted-foreground"
      }`}
    >
      {children}
    </div>
  );
}
