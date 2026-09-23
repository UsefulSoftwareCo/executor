import type * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { LoaderCircleIcon } from "@hugeicons/core-free-icons";

import { cn } from "../lib/utils.ts";

/** Animated loading icon; forwards SVG props and refs with a numeric stroke width. */
function Spinner({
  className,
  strokeWidth = 2,
  ...props
}: Omit<React.ComponentProps<typeof HugeiconsIcon>, "icon">) {
  return (
    <HugeiconsIcon
      icon={LoaderCircleIcon}
      strokeWidth={strokeWidth}
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
