import type { ComponentProps } from "react";
import { DisabledTooltip } from "./disabled-tooltip.tsx";
import { cn } from "../lib/utils.ts";

/** Multiline input using the same field styles and focus treatment as Input. */
export function Textarea({
  className,
  disabledReason,
  ...props
}: ComponentProps<"textarea"> & { readonly disabledReason?: string | undefined }) {
  const control = (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-24 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive",
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
