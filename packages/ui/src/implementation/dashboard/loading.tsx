import { Skeleton } from "../components/skeleton.tsx";
import type { ReactNode } from "react";
import { PageFrame, PageHeader } from "./page.tsx";

/** One placeholder shares the footprint of an installed app card. */
export function AppCardSkeleton() {
  return (
    <div aria-hidden className="flex min-h-[137px] flex-col rounded-lg border p-4">
      <div className="flex items-center gap-3">
        <Skeleton className="size-8.5 shrink-0 rounded-md" />
        <Skeleton className="h-3.5 w-28 max-w-[60%]" />
      </div>
      <Skeleton className="mt-auto h-3 w-36 max-w-[80%]" />
    </div>
  );
}

/** Card-shaped placeholders use the same grid and footprint as installed apps. */
export function AppCardsSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading apps"
      className="grid grid-cols-3 gap-4 max-[1100px]:grid-cols-2 max-[600px]:grid-cols-1"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <AppCardSkeleton key={index} />
      ))}
      <span className="sr-only">Loading apps…</span>
    </div>
  );
}

/** Account placeholders retain the real table's header, columns and responsive row spacing. */
export function AccountRowsSkeleton() {
  return (
    <div role="status" aria-label="Loading accounts" className="overflow-hidden rounded-lg border">
      <div
        aria-hidden
        className="grid grid-cols-[minmax(200px,_1.5fr)_minmax(130px,_0.8fr)_minmax(170px,_1fr)] items-center gap-6.25 bg-muted px-4 py-[9px] text-[11px] text-muted-foreground max-[1000px]:grid-cols-[minmax(0,_1.3fr)_minmax(0,_1fr)] max-[1000px]:gap-4 max-[740px]:hidden"
      >
        <span>Account</span>
        <span className="max-[1000px]:hidden">Added</span>
        <span>Apps</span>
      </div>
      {Array.from({ length: 5 }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="grid min-h-16 grid-cols-[minmax(200px,_1.5fr)_minmax(130px,_0.8fr)_minmax(170px,_1fr)] items-center gap-6.25 border-t px-4 py-3 max-[1000px]:grid-cols-[minmax(0,_1.3fr)_minmax(0,_1fr)] max-[1000px]:gap-4 max-[740px]:grid-cols-1 max-[740px]:gap-3 max-[740px]:first:border-t-0"
        >
          <div className="flex items-center gap-3">
            <Skeleton className="size-8.5 shrink-0 rounded-md" />
            <div className="space-y-2">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-2.5 w-20" />
            </div>
          </div>
          <Skeleton className="h-3 w-20 max-[1000px]:hidden" />
          <Skeleton className="h-5 w-28" />
        </div>
      ))}
      <span className="sr-only">Loading accounts…</span>
    </div>
  );
}

/** A neutral content panel for details whose data shape is not yet known. */
export function DetailSkeleton({ label = "Loading details" }: { readonly label?: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-6 rounded-lg border p-5">
      <div aria-hidden className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-56 max-w-[50vw]" />
        </div>
      </div>
      <div aria-hidden className="space-y-3 border-t pt-5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-9 w-full max-w-100" />
        <Skeleton className="h-3 w-3/5" />
      </div>
      <span className="sr-only">{label}…</span>
    </div>
  );
}

/** A route can show its real heading while its code or data is still arriving. */
export function PageSkeleton({
  title,
  description,
}: {
  readonly title: string;
  readonly description?: string;
}) {
  return (
    <PageFrame>
      <PageHeader title={title} description={description} />
      <DetailSkeleton label={`Loading ${title.toLowerCase()}`} />
    </PageFrame>
  );
}

/** Match the list frame even while its route bundle has not arrived. */
export function InventoryPageSkeleton({
  kind,
  action,
}: {
  readonly kind: "apps" | "accounts";
  readonly action?: ReactNode;
}) {
  const apps = kind === "apps";
  return (
    <PageFrame>
      <PageHeader
        title={apps ? "Apps" : "Accounts"}
        description={
          apps
            ? "Your installed apps and their selected accounts."
            : "Saved sign-ins, available to your apps."
        }
      >
        {action}
      </PageHeader>
      <div
        className={
          apps
            ? "mb-4 grid grid-cols-3 gap-4 max-[1100px]:grid-cols-2 max-[600px]:grid-cols-1"
            : "mb-4"
        }
      >
        <Skeleton
          aria-label={apps ? "Loading app search" : "Loading account search"}
          className={
            apps
              ? "h-8.75 w-full max-[740px]:h-11"
              : "h-8.75 w-full max-w-85 max-[740px]:h-11 max-[740px]:max-w-none"
          }
        />
      </div>
      {apps ? <AppCardsSkeleton /> : <AccountRowsSkeleton />}
    </PageFrame>
  );
}
