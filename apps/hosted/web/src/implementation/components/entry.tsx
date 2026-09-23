import { PageFrame, PageHeader } from "@executor-js/ui/dashboard/page";
import type { ReactNode } from "react";
import { useId } from "react";
import { Button } from "@executor-js/ui/components/button";
import { InventoryPageSkeleton } from "@executor-js/ui/dashboard/loading";
import {
  DashboardFrame,
  DashboardNavigation,
  OrganizationSwitcherSkeleton,
} from "./dashboard-frame.tsx";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import { SessionMenu } from "./auth.tsx";

/** A shared entry frame before an organization URL is known. */
export function HostedEntry({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  const heading = useId();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center p-6">
      <section
        className="w-full max-w-[560px] rounded-2xl border bg-card p-10 max-[600px]:p-6"
        aria-labelledby={heading}
      >
        <div className="mb-8 flex items-center gap-2 font-mono text-[15px]">
          <img src="/favicon.png" alt="" className="size-5" />
          <span>executor</span>
        </div>
        <h1 id={heading} className="text-2xl font-medium tracking-[-0.04em]">
          {title}
        </h1>
        {description && (
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
        )}
        <div className="mt-6">{children}</div>
      </section>
      <div className="mt-[18px] w-full max-w-[560px]">
        <SessionMenu signOutLabel="Sign out" />
      </div>
    </main>
  );
}

/** Neutral entry content does not assume an organization count or a setup outcome. */
export function HostedEntryLoading({
  title = "Opening Executor",
  description = "Loading your organizations…",
  label = "Loading organizations",
}: {
  readonly title?: string;
  readonly description?: string;
  readonly label?: string;
}) {
  return (
    <HostedEntry title={title} description={description}>
      <div role="status" aria-label={label} className="space-y-3">
        <Skeleton className="h-12 w-full rounded-md" />
        <Skeleton className="h-3 w-2/3" />
        <span className="sr-only">{label}</span>
      </div>
    </HostedEntry>
  );
}

/** Prefer the signed-in dashboard shape while its organization is being resolved. */
export function DashboardEntryPending({
  children,
  pathname,
}: { readonly children?: ReactNode; readonly pathname?: string } = {}) {
  const pendingPage = pathname?.split("/")[3] ?? "apps";
  return (
    <DashboardFrame
      organization={<OrganizationSwitcherSkeleton />}
      navigation={<DashboardNavigation pendingPage={pendingPage} />}
      pendingPage={pendingPage}
    >
      {children ?? (
        <InventoryPageSkeleton
          kind="apps"
          action={<Skeleton className="h-9 w-22 rounded-md" aria-label="Loading app actions" />}
        />
      )}
    </DashboardFrame>
  );
}

/** An unresolved organization keeps its dashboard frame and offers an explicit retry. */
export function OrganizationLookupError({ retry }: { readonly retry: () => void }) {
  return (
    <PageFrame>
      <PageHeader title="Apps" description="Your installed apps and their selected accounts." />
      <div role="alert" className="space-y-3 rounded-lg border p-4 text-sm">
        <h2 className="font-medium">Unable to load your organizations</h2>
        <p>Try again to open your workspace.</p>
        <Button variant="outline" onClick={retry}>
          Try again
        </Button>
      </div>
    </PageFrame>
  );
}
