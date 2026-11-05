import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { authWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { trackEvent } from "@executor-js/react/api/analytics";
import { Button } from "@executor-js/react/components/button";

import { AUTH_PATHS } from "../../auth/api";
import { CREATE_ORG_PATH } from "../../auth/route-paths";
import { acceptInvitation, pendingInvitationsAtom, useAuth } from "../auth";

// ---------------------------------------------------------------------------
// The page for a signed-in user with no organization who holds a pending
// invitation into an existing one. v1 creates no organizations (they are
// created in Executor v2), so this page only accepts invitations: accepting
// one opens that organization, and with none to accept the user is sent on
// to v2 through `/create-org`, which the document auth gate answers with v2's
// sign-up page.
// ---------------------------------------------------------------------------

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

export const JoinPage = () => {
  const auth = useAuth();
  const invitationsResult = useAtomValue(pendingInvitationsAtom);
  const doAccept = useAtomSet(acceptInvitation, { mode: "promiseExit" });

  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [errorByInvitationId, setErrorByInvitationId] = useState<Record<string, string>>({});
  // Set once an invitation is accepted and the page is navigating into its
  // organization, so the refetched (now empty) list cannot send the user to v2.
  const joining = useRef(false);

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
    trackEvent("org_invitation_accepted", { success: Exit.isSuccess(exit) });
    if (Exit.isSuccess(exit)) {
      joining.current = true;
      window.location.href = `/${exit.value.slug}`;
      return;
    }
    setAcceptingId(null);
    setErrorByInvitationId((prev) => ({
      ...prev,
      [invitation.id]: "Couldn't accept this invitation. Try again or ask the inviter to resend.",
    }));
  };

  const invitations = AsyncResult.isSuccess(invitationsResult)
    ? invitationsResult.value.invitations
    : null;
  const organizationSlug =
    auth.status === "authenticated" ? (auth.organization?.slug ?? null) : null;

  // Nothing to accept: a member goes back to their organization, anyone else
  // on to v2 (a document navigation, so the auth gate answers it).
  const nothingToAccept = invitations !== null && invitations.length === 0;
  useEffect(() => {
    if (!nothingToAccept || joining.current) return;
    window.location.replace(organizationSlug ? `/${organizationSlug}` : CREATE_ORG_PATH);
  }, [nothingToAccept, organizationSlug]);

  if (AsyncResult.isFailure(invitationsResult)) return <MovedNotice />;
  if (invitations === null || invitations.length === 0) {
    return <div className="h-screen bg-background" />;
  }

  const sole = invitations.length === 1 ? invitations[0]! : null;

  return (
    <JoinLayout title="You've been invited">
      {sole && (
        <SingleInvitationView
          invitation={sole}
          accepting={acceptingId === sole.id}
          error={errorByInvitationId[sole.id] ?? null}
          onAccept={() => void handleAccept(sole)}
        />
      )}

      {invitations.length > 1 && (
        <MultiInvitationsView
          invitations={invitations}
          acceptingId={acceptingId}
          errorByInvitationId={errorByInvitationId}
          onAccept={(inv) => void handleAccept(inv)}
        />
      )}

      <p className="text-center text-xs text-muted-foreground">
        New organizations are created in{" "}
        <a
          href={CREATE_ORG_PATH}
          className="underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          Executor v2
        </a>
        .
      </p>
    </JoinLayout>
  );
};

/** The invitations could not be read: say where organizations are created
 *  now, and let the user go there or sign out. */
const MovedNotice = () => (
  <JoinLayout title="Executor has moved">
    <p className="text-sm text-muted-foreground">
      New organizations are created in Executor v2. If you were invited to an organization here,
      reload this page to see the invitation.
    </p>
    <Button asChild size="sm" className="w-full">
      <a href={CREATE_ORG_PATH}>Continue to Executor v2</a>
    </Button>
  </JoinLayout>
);

const JoinLayout = (props: { title: string; children: ReactNode }) => (
  <div className="flex min-h-screen items-center justify-center bg-background px-4">
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-sans text-3xl font-semibold">{props.title}</h1>
      </header>

      {props.children}

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
