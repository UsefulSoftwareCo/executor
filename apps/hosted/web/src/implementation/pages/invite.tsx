import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { OrganizationId } from "@executor-js/hosted-server/organization";
import { Exit } from "effect";
import { useState } from "react";
import { acceptInvitationAtom } from "../../contracts/organization.ts";
import { organizationError, OrganizationDestination } from "../components/organization.tsx";
import { Button } from "@executor-js/ui/components/button";
import { LoginFrame } from "./login-frame.tsx";
import { useProductBrand } from "@executor-js/ui/hooks/product-brand";

/** Invitation IDs are untrusted; Better Auth verifies recipient email and expiry. */
export const inviteSearch = (search: Record<string, unknown>) => ({
  invitation: typeof search.invitation === "string" ? search.invitation : "",
});
/** Accept after authentication, including users who have no organization yet. */
export function InvitePage({ invitation }: { readonly invitation: string }) {
  const brand = useProductBrand();
  const accept = useAtomSet(acceptInvitationAtom, { mode: "promiseExit" });
  const state = useAtomValue(acceptInvitationAtom);
  const [joined, setJoined] = useState<{
    readonly organization: OrganizationId;
    readonly alreadyMember?: { readonly name: string } | undefined;
  }>();
  const [error, setError] = useState<string | null>(null);
  if (joined?.alreadyMember)
    return (
      <AlreadyMember
        name={joined.alreadyMember.name}
        onContinue={() => setJoined({ organization: joined.organization })}
      />
    );
  if (joined) return <OrganizationDestination organization={joined.organization} />;
  return (
    <LoginFrame title="Join an organization">
      <div className="flex flex-col gap-6 text-center">
        <p className="text-sm leading-6 text-balance text-muted-foreground">
          {invitation
            ? `You've been invited to an organization on ${brand.name}. Accept with the email this invitation was sent to.`
            : "This invitation link is incomplete. Ask for a new link."}
        </p>
        <Button
          className="min-h-10 w-full"
          disabled={!invitation || state.waiting}
          onClick={async () => {
            setError(null);
            const result = await accept(invitation);
            if (Exit.isFailure(result)) setError(organizationError(result.cause));
            else setJoined(result.value);
          }}
        >
          {state.waiting ? "Joining…" : "Accept invitation"}
        </Button>
        {error && (
          <p className="auth-error text-destructive text-[13px]" role="alert">
            {error}
          </p>
        )}
      </div>
    </LoginFrame>
  );
}

/** The invitation was accepted earlier; say so instead of joining again. */
function AlreadyMember({
  name,
  onContinue,
}: {
  readonly name: string;
  readonly onContinue: () => void;
}) {
  return (
    <LoginFrame title="You're already in this organization">
      <div className="flex flex-col gap-6 text-center">
        <p className="text-sm leading-6 text-balance text-muted-foreground">
          You've already joined {name} with this invitation.
        </p>
        <Button className="min-h-10 w-full" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </LoginFrame>
  );
}
