import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";

/** One compact row for app section labels, metadata, and actions. */
export function AppSectionHeader({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <header
      className={cn(
        "flex min-h-12 min-w-0 shrink-0 items-center justify-between gap-3 border-b px-4 py-[7.5px] text-[13px] max-md:px-3",
        className,
      )}
    >
      {children}
    </header>
  );
}

/** Section labels keep the same hierarchy beside ordinary text and split-pane inspectors. */
export function AppSectionTitle({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <h2 className={cn("min-w-0 text-[13px] font-medium", className)}>{children}</h2>;
}
