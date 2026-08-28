import * as React from "react";
import { ChevronDownIcon } from "lucide-react";

import { useIsDark } from "../hooks/use-is-dark";
import { cn } from "../lib/utils";

function NativeSelect({
  className,
  size = "default",
  style,
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & { size?: "sm" | "default" }) {
  const isDark = useIsDark();
  return (
    <div
      className="group/native-select relative w-fit has-[select:disabled]:opacity-50"
      data-slot="native-select-wrapper"
    >
      {/* The native option popup follows the select's opaque background and
          color-scheme, not option-level styles. Give it a solid themed surface
          and pin color-scheme so options stay readable in dark mode, which is
          driven by prefers-color-scheme (no .dark class in this app). */}
      {/* oxlint-disable-next-line react/forbid-elements */}
      <select
        data-slot="native-select"
        data-size={size}
        style={{ colorScheme: isDark ? "dark" : "light", ...style }}
        className={cn(
          "h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-popover text-popover-foreground px-3 py-2 pr-9 text-sm shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground hover:bg-accent disabled:pointer-events-none disabled:cursor-not-allowed data-[size=sm]:h-8 data-[size=sm]:py-1",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
          className,
        )}
        {...props}
      />
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-muted-foreground opacity-50 select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  );
}

function NativeSelectOption({ ...props }: React.ComponentProps<"option">) {
  return <option data-slot="native-select-option" {...props} />;
}

function NativeSelectOptGroup({ className, ...props }: React.ComponentProps<"optgroup">) {
  return <optgroup data-slot="native-select-optgroup" className={cn(className)} {...props} />;
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
