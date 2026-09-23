import { OrganizationMembersPending } from "./organization-members.tsx";
import type { ReactNode } from "react";
import { Button } from "@executor-js/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@executor-js/ui/components/card";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import { PageFrame, PageHeader } from "@executor-js/ui/dashboard/page";
import { organizationSlugMaxLength } from "@executor-js/hosted-server/organization";

/** Keep form geometry identical before and after the organization values arrive. */
export const organizationSettingClass =
  "organization-setting border border-border rounded-[10px] bg-background shadow-none flex flex-col gap-0 p-0 [&_[data-slot='card-header']]:gap-1 [&_[data-slot='card-header']]:[padding:14px_16px_10px] [&_[data-slot='card-title']_h2]:text-[14px] [&_[data-slot='card-title']_h2]:leading-[1.4] [&_[data-slot='card-title']_h2]:font-medium [&_[data-slot='card-description']]:text-[12px] [&_[data-slot='card-description']]:leading-[1.5] [&_[data-slot='card-content']]:min-w-0 [&_[data-slot='card-content']]:[padding:0_16px_10px] [&_[data-slot='card-footer']]:justify-between [&_[data-slot='card-footer']]:gap-3 [&_[data-slot='card-footer']]:[padding:0_16px_12px] [&_[data-slot='card-footer']]:border-0 [&_[data-slot='card-footer']_>_p]:text-muted-foreground [&_[data-slot='card-footer']_>_p]:text-[11px] max-[640px]:[&_[data-slot='card-header']]:[padding:12px_12px_10px] max-[640px]:[&_[data-slot='card-content']]:[padding:0_12px_12px] max-[640px]:[&_[data-slot='card-footer']]:[padding:0_12px_10px]";

/** Render known settings copy and controls, with placeholders only for server values. */
export function OrganizationSettingsPending({ children }: { readonly children?: ReactNode }) {
  return (
    <PageFrame>
      <PageHeader
        title={<Skeleton className="h-[29.7px] w-44" aria-label="Loading organization name" />}
      />
      <div
        className="organization-settings flex flex-col gap-3"
        role="status"
        aria-label="Loading organization settings"
      >
        <Card className={organizationSettingClass}>
          <CardHeader>
            <CardTitle>
              <h2>Organization name</h2>
            </CardTitle>
            <CardDescription>Shown across Executor.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex h-9 w-[min(100%,_520px)] items-center rounded-[6px] border border-input px-3 max-[740px]:min-h-11 max-[640px]:h-10">
              <Skeleton className="h-3.5 w-36" aria-label="Loading name" />
            </div>
          </CardContent>
          <CardFooter>
            <p>Up to 120 characters</p>
            <div className="flex items-center [&_>_button]:h-7.5 [&_>_button]:px-3 [&_>_button]:text-xs max-[640px]:[&_>_button]:min-h-10">
              <Button variant="outline" disabled>
                Save
              </Button>
            </div>
          </CardFooter>
        </Card>
        <Card className="organization-setting gap-0 py-0">
          <CardHeader className="gap-1.5 px-4 pt-4 pb-3">
            <CardTitle>
              <h2>Organization icon</h2>
            </CardTitle>
            <CardDescription>Shown in the organization menu.</CardDescription>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <Skeleton className="size-11 rounded-[10px]" aria-label="Loading organization icon" />
          </CardContent>
          <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
            <p>PNG, JPG, or WebP · up to 2 MB</p>
            <Button variant="outline" disabled>
              Save
            </Button>
          </CardFooter>
        </Card>
        <Card className={organizationSettingClass}>
          <CardHeader>
            <CardTitle>
              <h2>Organization URL</h2>
            </CardTitle>
            <CardDescription>Changing this replaces your organization’s URL.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex w-[min(100%,_520px)] min-w-0 items-center overflow-hidden rounded-[6px] border border-input">
              <span className="max-w-[50%] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap border-r border-input px-[10px] py-[7px] text-xs text-muted-foreground">
                {window.location.host}/org/
              </span>
              <div className="flex h-8.5 min-w-0 flex-1 items-center px-3 max-[740px]:min-h-11 max-[640px]:h-9.5">
                <Skeleton className="h-3.5 w-24 max-w-full" aria-label="Loading organization URL" />
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <p>Lowercase letters, numbers, hyphens · {organizationSlugMaxLength} characters max</p>
            <div className="flex items-center [&_>_button]:h-7.5 [&_>_button]:px-3 [&_>_button]:text-xs max-[640px]:[&_>_button]:min-h-10">
              <Button variant="outline" disabled>
                Save
              </Button>
            </div>
          </CardFooter>
        </Card>
        {children}
        <span className="sr-only">Loading organization settings…</span>
      </div>
      <OrganizationMembersPending />
    </PageFrame>
  );
}
