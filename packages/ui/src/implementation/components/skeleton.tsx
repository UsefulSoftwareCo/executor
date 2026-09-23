import type * as React from "react";
import { cn } from "../lib/utils.ts";

/** Skeleton primitive; accepts native props and composes caller styles. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-accent", className)}
      {...props}
    />
  );
}

export { Skeleton };
