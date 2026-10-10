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
import { organizationSettingClass } from "./organization-settings-pending.tsx";

/** The page headings and copy are the same on every visit. */
export const profileTitle = "Profile";
export const profileDescription = "How you appear across every organization.";
export const securityTitle = "Security";
export const securityDescription = "How you sign in, and where you are signed in.";

/** Account forms share the organization settings geometry. */
export const accountSettingClass = organizationSettingClass;

/** A locked value must not look like a field waiting for input. */
export const readOnlyInputClass =
  "w-[min(100%,_520px)] h-9 rounded-[6px] border-dashed bg-transparent text-muted-foreground shadow-none cursor-default focus-visible:ring-0 max-[640px]:h-10 max-[640px]:text-[16px]";

/** A settings card whose copy is known; only the stored value is a placeholder. */
export function AccountSettingPending({
  title,
  description,
  hint,
  action,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly hint?: string;
  readonly action?: string;
  readonly children?: ReactNode;
}) {
  return (
    <Card className={accountSettingClass}>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {children ?? (
          <div className="flex h-9 w-[min(100%,_520px)] items-center rounded-[6px] border border-input px-3 max-[640px]:h-10">
            <Skeleton className="h-3.5 w-36" aria-label={`Loading ${title.toLowerCase()}`} />
          </div>
        )}
      </CardContent>
      {(hint !== undefined || action !== undefined) && (
        <CardFooter>
          <p>{hint}</p>
          {action !== undefined && (
            <div className="flex items-center [&_>_button]:h-7.5 [&_>_button]:px-3 [&_>_button]:text-xs max-[640px]:[&_>_button]:min-h-10">
              <Button variant="outline" disabled>
                {action}
              </Button>
            </div>
          )}
        </CardFooter>
      )}
    </Card>
  );
}

/** Lazy route loading keeps the profile page identity and its static controls. */
export function ProfilePending() {
  return (
    <PageFrame>
      <PageHeader title={profileTitle} description={profileDescription} />
      <div className="flex flex-col gap-3" role="status" aria-label="Loading profile">
        <AccountSettingPending
          title="Name"
          description="Shown to members of your organizations."
          hint="Up to 120 characters"
          action="Save"
        />
        <AccountSettingPending title="Email" description="Used for sign-in and invitations." />
        <AccountSettingPending
          title="Organizations"
          description="Where you are a member. Everything else in Executor lives inside one of these."
        >
          <Skeleton className="h-9 w-full" aria-label="Loading organizations" />
        </AccountSettingPending>
      </div>
    </PageFrame>
  );
}

/** The sessions card while the list loads; host sign-in sections render their own copy. */
export function SessionsPending() {
  return (
    <AccountSettingPending
      title="Active sessions"
      description="Browsers and clients signed in as you."
      action="Sign out other sessions"
    >
      <Skeleton className="h-12 w-full" aria-label="Loading sessions" />
    </AccountSettingPending>
  );
}

/** Lazy route loading keeps the security page identity and its static controls. */
export function SecurityPending({ children }: { readonly children?: ReactNode }) {
  return (
    <PageFrame>
      <PageHeader title={securityTitle} description={securityDescription} />
      <div className="flex flex-col gap-3" role="status" aria-label="Loading security settings">
        {children}
        <SessionsPending />
      </div>
    </PageFrame>
  );
}
