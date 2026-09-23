import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState, type ReactNode } from "react";
import { InventoryPageSkeleton } from "@executor-js/ui/dashboard/loading";
import { McpConsentLoading } from "@executor-js/ui/dashboard/mcp-consent";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import { DashboardEntryPending, OrganizationLookupError } from "./entry.tsx";
import { PagePending } from "./page-pending.tsx";
import { Spinner } from "@executor-js/ui/components/spinner";
import { sessionAtom } from "../../contracts/auth.ts";
import { organizationsAtom } from "../../contracts/organization.ts";
import { readLastOrganization } from "../session-hint.ts";

function SignInPending() {
  return (
    <div
      className="auth-pending min-h-dvh flex items-center justify-center gap-4"
      role="status"
      aria-label="Completing sign-in"
    >
      <Spinner />
      <span className="sr-only">Completing sign-in</span>
    </div>
  );
}

function ReplaceAfterSignIn({
  destination,
  verified,
  children,
}: {
  readonly destination: string;
  readonly verified: boolean;
  readonly children?: ReactNode;
}) {
  // A fresh document drops prior session state and preserves signed return URLs verbatim.
  useEffect(() => {
    if (verified) window.location.replace(destination);
  }, [destination, verified]);
  if (children !== undefined) return children;
  const pathname = new URL(destination, window.location.origin).pathname;
  if (pathname.startsWith("/org/"))
    return (
      <DashboardEntryPending pathname={pathname}>
        <PagePending pathname={pathname} />
      </DashboardEntryPending>
    );
  if (pathname === "/mcp/authorize") return <McpConsentLoading />;
  return <SignInPending />;
}

function PendingApps() {
  return (
    <InventoryPageSkeleton
      kind="apps"
      action={<Skeleton className="h-9 w-22 rounded-md" aria-label="Loading app actions" />}
    />
  );
}

function FirstOrganizationDestination({ verified }: { readonly verified: boolean }) {
  const organizations = useAtomValue(organizationsAtom);
  const refresh = useAtomRefresh(organizationsAtom);
  return (
    <DashboardEntryPending>
      {AsyncResult.builder(organizations)
        .onInitialOrWaiting(() => <PendingApps />)
        .onFailure(() => <OrganizationLookupError retry={refresh} />)
        .onSuccess((items) => {
          const only = items.length === 1 ? items[0] : undefined;
          return (
            <ReplaceAfterSignIn
              verified={verified}
              destination={only ? `/org/${encodeURIComponent(only.slug)}/apps` : "/"}
            >
              <PendingApps />
            </ReplaceAfterSignIn>
          );
        })
        .exhaustive()}
    </DashboardEntryPending>
  );
}

/** Finish a confirmed sign-in before entering the product; explicit return links stay intact. */
export function ContinueAfterSignIn({
  redirect,
  userId,
}: {
  readonly redirect: string;
  readonly userId: string;
}) {
  const [recent] = useState(() => readLastOrganization(userId));
  const session = useAtomValue(sessionAtom);
  const verified =
    AsyncResult.isSuccess(session) && !session.waiting && session.value?.user.id === userId;
  if (redirect !== "/") return <ReplaceAfterSignIn verified={verified} destination={redirect} />;
  if (recent !== undefined)
    return (
      <ReplaceAfterSignIn
        verified={verified}
        destination={`/org/${encodeURIComponent(recent)}/apps`}
      />
    );
  return <FirstOrganizationDestination verified={verified} />;
}
