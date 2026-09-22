import * as React from "react";

import { DisabledTooltip } from "./disabled-tooltip.tsx";
import { cn } from "../lib/utils.ts";

/** Input primitive; accepts native props and composes caller styles. */
function Input({
  className,
  type,
  disabledReason,
  ...props
}: React.ComponentProps<"input"> & { readonly disabledReason?: string | undefined }) {
  const control = (
    // oxlint-disable-next-line react/forbid-elements
    <input
      type={type}
      data-slot="input"
      className={cn(
        "max-[740px]:min-h-11 max-[740px]:text-[16px] h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
      disabled={props.disabled || disabledReason !== undefined}
    />
  );
  return (
    <DisabledTooltip reason={disabledReason} className="w-full">
      {control}
    </DisabledTooltip>
  );
}

export { Input };
