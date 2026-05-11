import { useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { authWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { Button } from "@executor-js/react/components/button";
import { Skeleton } from "@executor-js/react/components/skeleton";

import { AUTH_PATHS } from "../../auth/api";
import { acceptInvitation, pendingInvitationsAtom, useAuth } from "../auth";
import {
  CreateOrganizationFields,
  useCreateOrganizationForm,
} from "../components/create-organization-form";

type PendingInvitation = {
  id: string;
  organizationId: string;
  organizationName: string;
  createdAt: string;
  inviter: { email: string; name: string | null } | null;
};

const formatRelativeTime = (iso: string): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

export const CreateOrgPage = () => {
  const auth = useAuth();
  const navigate = useNavigate();
  const invitationsResult = useAtomValue(pendingInvitationsAtom);
  const doAccept = useAtomSet(acceptInvitation, { mode: "promiseExit" });

  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [errorByInvitationId, setErrorByInvitationId] = useState<Record<string, string>>({});

  const handleAccept = async (invitation: PendingInvitation) => {
    setAcceptingId(invitation.id);
    setErrorByInvitationId((prev) => {
      if (!(invitation.id in prev)) return prev;
      const next = { ...prev };
      delete next[invitation.id];
      return next;
    });
    const exit = await doAccept({
      payload: { invitationId: invitation.id },
      reactivityKeys: authWriteKeys,
    });
    setAcceptingId(null);
    if (!Exit.isSuccess(exit)) {
      setErrorByInvitationId((prev) => ({
        ...prev,
        [invitation.id]: "Couldn't accept this invitation. Try again or ask the inviter to resend.",
      }));
    }
  };

  const suggestedName =
    auth.status === "authenticated" && auth.user.name != null && auth.user.name.trim() !== ""
      ? `${auth.user.name}'s Organization`
      : "";

  const form = useCreateOrganizationForm({
    defaultName: suggestedName,
    onSuccess: () => {
      void navigate({ to: "/setup-mcp" });
    },
  });

  const isLoading =
    AsyncResult.isInitial(invitationsResult) || AsyncResult.isWaiting(invitationsResult);
  const invitations = AsyncResult.match(invitationsResult, {
    onInitial: () => [] as readonly PendingInvitation[],
    onFailure: () => [] as readonly PendingInvitation[],
    onSuccess: ({ value }) => value.invitations,
  });

  const count = invitations.length;
  const sole = count === 1 ? invitations[0]! : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="mx-auto flex w-full max-w-sm flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Step 1 of 2
          </p>
          <h1 className="font-serif text-3xl">
            {isLoading
              ? "Loading"
              : count === 0
                ? "Create your organization"
                : "You've been invited"}
          </h1>
          {!isLoading && count === 0 && (
            <p className="text-sm text-muted-foreground">
              Organizations group your sources, secrets, and teammates. You can invite others once
              it's set up.
            </p>
          )}
        </header>

        {isLoading && <InvitationsSkeleton />}

        {!isLoading && sole && (
          <SingleInvitationView
            invitation={sole}
            accepting={acceptingId === sole.id}
            error={errorByInvitationId[sole.id] ?? null}
            onAccept={() => void handleAccept(sole)}
          />
        )}

        {!isLoading && count > 1 && (
          <MultiInvitationsView
            invitations={invitations}
            acceptingId={acceptingId}
            errorByInvitationId={errorByInvitationId}
            onAccept={(inv) => void handleAccept(inv)}
          />
        )}

        {!isLoading && (count === 0 || sole || count > 1) && (
          <CreateOrgSection isPrimary={count === 0} form={form} />
        )}

        <footer className="flex items-center justify-center">
          {/* oxlint-disable-next-line react/forbid-elements */}
          <button
            type="button"
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={async () => {
              await fetch(AUTH_PATHS.logout, { method: "POST" });
              window.location.href = "/";
            }}
          >
            Sign out
          </button>
        </footer>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------

const InvitationsSkeleton = () => (
  <div className="flex flex-col gap-2.5">
    <InvitationRowSkeleton />
    <InvitationRowSkeleton />
  </div>
);

const InvitationRowSkeleton = () => (
  <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5">
    <div className="flex flex-1 flex-col gap-1.5">
      <Skeleton className="h-3.5 w-2/5" />
      <Skeleton className="h-3 w-3/5" />
    </div>
    <Skeleton className="h-8 w-16 rounded-md" />
  </div>
);

// ---------------------------------------------------------------------------

const InviterAttribution = ({ invitation }: { invitation: PendingInvitation }) => {
  const inviterLabel = invitation.inviter
    ? invitation.inviter.name && invitation.inviter.name.length > 0
      ? `${invitation.inviter.name} (${invitation.inviter.email})`
      : invitation.inviter.email
    : null;
  const time = formatRelativeTime(invitation.createdAt);
  return (
    <p className="truncate text-xs text-muted-foreground">
      {inviterLabel ? (
        <>
          Invited by <span className="text-foreground/80">{inviterLabel}</span>
          {time && <span> · {time}</span>}
        </>
      ) : (
        <>Invited{time ? ` ${time}` : ""}</>
      )}
    </p>
  );
};

// ---------------------------------------------------------------------------

const SingleInvitationView = ({
  invitation,
  accepting,
  error,
  onAccept,
}: {
  invitation: PendingInvitation;
  accepting: boolean;
  error: string | null;
  onAccept: () => void;
}) => (
  <section aria-label="Invitation" className="flex flex-col gap-3">
    <div className="flex flex-col gap-0.5 rounded-md border border-border px-3 py-2.5">
      <p className="truncate text-sm font-medium leading-tight">{invitation.organizationName}</p>
      <InviterAttribution invitation={invitation} />
    </div>

    {error && <p className="text-xs text-destructive">{error}</p>}

    <Button onClick={onAccept} disabled={accepting} className="w-full" size="sm">
      {accepting ? "Joining…" : "Accept invitation"}
    </Button>
  </section>
);

// ---------------------------------------------------------------------------

const MultiInvitationsView = ({
  invitations,
  acceptingId,
  errorByInvitationId,
  onAccept,
}: {
  invitations: readonly PendingInvitation[];
  acceptingId: string | null;
  errorByInvitationId: Record<string, string>;
  onAccept: (invitation: PendingInvitation) => void;
}) => (
  <section aria-label="Invitations" className="flex flex-col gap-2">
    <ul className="flex flex-col gap-2">
      {invitations.map((invitation) => {
        const isAccepting = acceptingId === invitation.id;
        const isOtherAccepting = acceptingId !== null && !isAccepting;
        const error = errorByInvitationId[invitation.id] ?? null;
        return (
          <li key={invitation.id} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium leading-tight">
                  {invitation.organizationName}
                </p>
                <InviterAttribution invitation={invitation} />
              </div>
              <Button
                size="sm"
                onClick={() => onAccept(invitation)}
                disabled={isAccepting || isOtherAccepting}
              >
                {isAccepting ? "Joining…" : "Accept"}
              </Button>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </li>
        );
      })}
    </ul>
  </section>
);

// ---------------------------------------------------------------------------

const CreateOrgSection = ({
  isPrimary,
  form,
}: {
  isPrimary: boolean;
  form: ReturnType<typeof useCreateOrganizationForm>;
}) => {
  const [expanded, setExpanded] = useState(isPrimary);

  if (!isPrimary && !expanded) {
    return (
      <div className="text-center text-xs text-muted-foreground">
        {/* oxlint-disable-next-line react/forbid-elements */}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          Or create a new organization
        </button>
      </div>
    );
  }

  return (
    <section aria-label="Create organization" className="flex flex-col gap-3">
      <CreateOrganizationFields
        name={form.name}
        onNameChange={(name) => {
          form.setName(name);
          if (form.error) form.setError(null);
        }}
        error={form.error}
        onSubmit={() => void form.submit()}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => void form.submit()}
          disabled={!form.canSubmit || form.creating}
        >
          {form.creating ? "Creating…" : "Create organization"}
        </Button>
      </div>
    </section>
  );
};
