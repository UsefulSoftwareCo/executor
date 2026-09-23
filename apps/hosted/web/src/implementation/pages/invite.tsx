import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { OrganizationId } from "@executor-js/hosted-server/organization";
import { Exit } from "effect";
import { useState } from "react";
import { acceptInvitationAtom } from "../../contracts/organization.ts";
import { organizationError, OrganizationDestination } from "../components/organization.tsx";
import { Button } from "@executor-js/ui/components/button";

/** Invitation IDs are untrusted; Better Auth verifies recipient email and expiry. */
export const inviteSearch = (search: Record<string, unknown>) => ({
  invitation: typeof search.invitation === "string" ? search.invitation : "",
});
/** Accept after authentication, including users who have no organization yet. */
export function InvitePage({ invitation }: { readonly invitation: string }) {
  const accept = useAtomSet(acceptInvitationAtom, { mode: "promiseExit" });
  const state = useAtomValue(acceptInvitationAtom);
  const [joined, setJoined] = useState<OrganizationId>();
  const [error, setError] = useState<string | null>(null);
  if (joined) return <OrganizationDestination organization={joined} />;
  return (
    <section className="page w-full shrink-0 max-w-315 [padding:24px_24px_48px] my-0 mx-auto max-[1000px]:[padding:20px_20px_40px] max-[740px]:[padding:18px_max(16px,_env(safe-area-inset-right))_max(32px,_env(safe-area-inset-bottom))_max(16px,_env(safe-area-inset-left))]">
      <EmptyState
        title="Join an organization"
        heading="h1"
        icon={null}
        action={
          <Button
            disabled={!invitation || state.waiting}
            onClick={async () => {
              setError(null);
              const result = await accept(invitation);
              if (Exit.isFailure(result)) setError(organizationError(result.cause));
              else setJoined(result.value);
            }}
          >
            Accept invitation
          </Button>
        }
      >
        <p>
          {invitation
            ? "Accept this invitation with the email it was sent to."
            : "This invitation link is incomplete."}
        </p>
        {error && (
          <p className="auth-error text-destructive text-[13px]" role="alert">
            {error}
          </p>
        )}
      </EmptyState>
    </section>
  );
}
