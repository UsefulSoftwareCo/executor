import type { ReactNode } from "react";
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
  icon,
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
        "empty-state mx-auto w-full max-w-lg flex-none gap-0 rounded-none border-0 px-6 py-12 text-muted-foreground md:px-8 md:py-14",
        size === "compact" && "max-w-none items-start px-0 py-4 text-left md:px-0 md:py-4",
        className,
      )}
    >
      {icon && (
        <div
          className={cn(
            "mb-4 flex size-10 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-6",
            size === "compact" && "mb-2 size-6 [&_svg]:size-5",
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
            "mt-2 max-w-sm text-sm leading-6 [&_a]:underline [&_a]:underline-offset-4 max-[740px]:[&_a]:inline-flex max-[740px]:[&_a]:min-h-11 max-[740px]:[&_a]:items-center",
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

/** Keep a full empty state near the top of its tab, with space at narrow widths. */
export function EmptyStatePanel(props: EmptyStateProps) {
  return (
    <div className="flex w-full flex-1 items-start justify-center p-7 max-[740px]:p-4">
      <EmptyState {...props} />
    </div>
  );
}
