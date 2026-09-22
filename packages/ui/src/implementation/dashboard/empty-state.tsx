import type { ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PackageIcon } from "@hugeicons/core-free-icons";
import { Empty } from "../components/empty.tsx";
import { cn } from "../lib/utils.ts";

type EmptyStateProps = {
  readonly title: string;
  readonly children?: ReactNode;
  readonly icon?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly size?: "default" | "compact";
  readonly heading?: "h1" | "h2" | "h3";
  readonly role?: "alert" | "status";
};

/** A shared empty view with explanatory copy, an optional icon and a next action. */
export function EmptyState({
  title,
  children,
  icon = <HugeiconsIcon icon={PackageIcon} aria-hidden size={26} strokeWidth={1.3} />,
  action,
  className,
  size = "default",
  heading: Heading = "h2",
  role,
}: EmptyStateProps) {
  return (
    <Empty
      role={role}
      className={cn(
        "empty-state mx-auto min-h-72 w-full max-w-md flex-none gap-0 rounded-2xl border-2 border-dotted border-border bg-muted/40 p-8 text-muted-foreground md:p-10",
        size === "compact" && "min-h-0 max-w-none rounded-xl p-5 md:p-5",
        className,
      )}
    >
      {icon && (
        <div
          className={cn(
            "mb-5 flex size-12 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-foreground shadow-xs [&_svg]:size-6",
            size === "compact" && "mb-3 size-9 rounded-lg [&_svg]:size-5",
          )}
        >
          {icon}
        </div>
      )}
      <Heading
        className={cn(
          "text-lg font-semibold tracking-tight text-foreground",
          size === "compact" && "text-sm",
        )}
      >
        {title}
      </Heading>
      {children && (
        <div
          className={cn(
            "mt-2 max-w-72 text-sm leading-6 [&_a]:underline [&_a]:underline-offset-4 max-[740px]:[&_a]:inline-flex max-[740px]:[&_a]:min-h-11 max-[740px]:[&_a]:items-center",
            size === "compact" && "text-xs leading-5",
          )}
        >
          {children}
        </div>
      )}
      {action && (
        <div className={cn("mt-6 text-foreground", size === "compact" && "mt-4")}>{action}</div>
      )}
    </Empty>
  );
}

/** Center a full empty state within a tab or page while retaining space at narrow widths. */
export function EmptyStatePanel(props: EmptyStateProps) {
  return (
    <div className="flex min-h-full w-full flex-1 items-center justify-center p-7 max-[740px]:p-4">
      <EmptyState {...props} />
    </div>
  );
}
