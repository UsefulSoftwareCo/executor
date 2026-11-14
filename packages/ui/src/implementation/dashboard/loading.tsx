import { Skeleton } from "../components/skeleton.tsx";
import { Spinner } from "../components/spinner.tsx";
import type { ReactNode } from "react";
import { LoadingRows } from "./context.tsx";
import { PageFrame, PageHeader } from "./page.tsx";

/** One placeholder shares the footprint of an installed app card. */
export function AppCardSkeleton() {
  return (
    <div
      aria-hidden
      className="flex min-h-[137px] flex-col rounded-lg border p-4 max-[600px]:grid max-[600px]:min-h-0 max-[600px]:grid-cols-[auto_minmax(0,1fr)] max-[600px]:items-center max-[600px]:gap-x-3 max-[600px]:gap-y-1.5 max-[600px]:px-3.5 max-[600px]:py-3"
    >
      <div className="flex items-center gap-3 max-[600px]:contents">
        <Skeleton className="size-8.5 shrink-0 rounded-md max-[600px]:row-span-2" />
        <Skeleton className="h-3.5 w-28 max-w-[60%] max-[600px]:self-end" />
      </div>
      <Skeleton className="mt-auto h-3 w-36 max-w-[80%] max-[600px]:col-start-2 max-[600px]:mt-0 max-[600px]:self-start" />
    </div>
  );
}

/** Card-shaped placeholders use the same grid and footprint as installed apps. */
export function AppCardsSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading apps"
      className="grid grid-cols-3 gap-4 max-[1100px]:grid-cols-2 max-[600px]:grid-cols-1 max-[600px]:gap-2"
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
        className="grid grid-cols-[minmax(200px,_1.5fr)_minmax(130px,_0.8fr)_minmax(170px,_1fr)_auto] items-center gap-6.25 bg-muted px-4 py-[9px] text-[11px] text-muted-foreground max-[1000px]:grid-cols-[minmax(0,_1.3fr)_minmax(0,_1fr)_auto] max-[1000px]:gap-4 max-[740px]:hidden"
      >
        <span>Account</span>
        <span className="max-[1000px]:hidden">Added</span>
        <span>Apps</span>
        <span className="size-8" />
      </div>
      {Array.from({ length: 5 }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="grid min-h-16 grid-cols-[minmax(200px,_1.5fr)_minmax(130px,_0.8fr)_minmax(170px,_1fr)_auto] items-center gap-6.25 border-t px-4 py-3 max-[1000px]:grid-cols-[minmax(0,_1.3fr)_minmax(0,_1fr)_auto] max-[1000px]:gap-4 max-[740px]:grid-cols-[minmax(0,_1fr)_auto] max-[740px]:gap-3 max-[740px]:first:border-t-0"
        >
          <div className="flex items-center gap-3">
            <Skeleton className="size-8.5 shrink-0 rounded-md" />
            <div className="space-y-2">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-2.5 w-20" />
            </div>
          </div>
          <Skeleton className="h-3 w-20 max-[1000px]:hidden" />
          <Skeleton className="h-5 w-28 max-[740px]:col-span-2" />
          <Skeleton className="size-8 rounded-md max-[740px]:col-start-2 max-[740px]:row-start-1" />
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
            ? "Your installed apps and their linked accounts."
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

/**
 * Add app's back link, heading, action and search row. The page and its pending view share it, so
 * the catalog replaces the pending view without moving.
 */
export function CatalogPageFrame({
  back,
  action,
  toolbar,
  children,
}: {
  readonly back: ReactNode;
  readonly action?: ReactNode;
  readonly toolbar: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="page w-full shrink-0 max-w-315 [padding:24px_24px_48px] my-0 mx-auto max-[1000px]:[padding:20px_20px_40px] max-[740px]:[padding:18px_max(16px,_env(safe-area-inset-right))_max(32px,_env(safe-area-inset-bottom))_max(16px,_env(safe-area-inset-left))]">
      {back}
      <div className="page-heading gap-4 flex justify-between items-center min-h-12 mb-4.5 [&_p]:text-muted-foreground [&_p]:text-[13px] [&_p]:mt-1.25 [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere max-[740px]:items-start max-[740px]:mb-4.5 max-[740px]:[&_p]:leading-[1.6] max-[740px]:[&_>_[data-slot='button']]:mt-0.25">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35]">
            App catalog
          </h1>
          <p>Ready-made apps for the services you use.</p>
        </div>
        {action}
      </div>
      <div className="list-toolbar flex flex-wrap items-center gap-[10px_16px] mb-4">{toolbar}</div>
      {children}
    </div>
  );
}

/** The catalog's app count before the feed arrives, as wide as the loaded count. */
export function CatalogCountSkeleton() {
  return (
    <span aria-hidden className="inline-flex items-center">
      <Skeleton className="h-4 w-20" />
      {"\u200b"}
    </span>
  );
}

/** Placeholder catalog rows with the loaded rows' spacing, icon, text and button sizes. */
export function CatalogRowsSkeleton({ count = 10 }: { readonly count?: number }) {
  return (
    <div role="status" aria-label="Loading apps" className="border-t border-t-border">
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="flex min-h-18.5 w-full items-center gap-4 border-b border-b-border px-[12px] py-[15px] max-[740px]:grid max-[740px]:grid-cols-[34px_minmax(0,_1fr)_auto] max-[740px]:gap-[4px_12px] max-[740px]:px-0"
        >
          <Skeleton className="size-8.5 shrink-0 rounded-[7px] max-[740px]:row-[1_/_3]" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.25 max-[740px]:col-[2]">
            <div className="flex h-[19.5px] items-center">
              <Skeleton className="h-3.5 w-32 max-w-[60%]" />
            </div>
            <div className="flex h-4.5 items-center">
              <Skeleton className="h-3 w-[min(420px,_80%)]" />
            </div>
          </div>
          <Skeleton className="h-8 w-21 rounded-md max-[740px]:col-[3] max-[740px]:row-[1_/_3] max-[740px]:h-11" />
        </div>
      ))}
      <span className="sr-only">Loading apps…</span>
    </div>
  );
}

/** The app catalog while its code or the catalog feed loads. */
export function CatalogPageSkeleton({ back }: { readonly back: ReactNode }) {
  return (
    <CatalogPageFrame
      back={back}
      action={<Skeleton aria-hidden className="h-9 w-37 shrink-0 rounded-md" />}
      toolbar={
        <>
          <Skeleton
            aria-label="Loading app search"
            className="h-8.75 w-[min(100%,_340px)] max-[740px]:h-11 max-[740px]:w-full"
          />
          <CatalogCountSkeleton />
        </>
      }
    >
      <CatalogRowsSkeleton />
    </CatalogPageFrame>
  );
}

export const approvalsTitle = "Approvals";
export const approvalsDescription = "Review scheduled runs before they continue.";

/** The approvals list while its code or the pending runs load. */
export function ApprovalsPending() {
  return (
    <PageFrame>
      <PageHeader title={approvalsTitle} description={approvalsDescription} />
      <LoadingRows />
    </PageFrame>
  );
}

/** The card a browser approval renders in, from loading through its result. */
export function ApprovalCard({ children }: { readonly children: ReactNode }) {
  return <section className="rounded-xl border bg-card p-6 shadow-sm sm:p-8">{children}</section>;
}

/** An approval request that has not loaded yet. */
export function ApprovalCardPending() {
  return (
    <ApprovalCard>
      <Spinner />
    </ApprovalCard>
  );
}

/** The column webhook setup renders in, from loading through its form. */
export function WebhookSetupFrame({ children }: { readonly children: ReactNode }) {
  return <section className="page mx-auto w-full max-w-xl gap-4">{children}</section>;
}

export function WebhookSetupLoading() {
  return <p className="muted">Loading webhook setup…</p>;
}
