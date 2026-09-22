import type { ButtonProps } from "../../contracts/button.ts";
import { cva } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "../lib/utils.ts";
import { DisabledTooltip } from "./disabled-tooltip.tsx";
import { Spinner } from "./spinner.tsx";

/** Shared appearance and size classes, also usable for link composition. */
const buttonVariants = cva(
  "max-[740px]:min-h-11 max-[740px]:data-[size^=icon]:min-w-11 inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      } satisfies Record<NonNullable<ButtonProps["variant"]>, string>,
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      } satisfies Record<NonNullable<ButtonProps["size"]>, string>,
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/** Button primitive; accepts native props and composes caller styles. */
function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  disabled,
  disabledReason,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  const showLoading = loading && !asChild;

  const button = (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={showLoading ? "" : undefined}
      className={cn(buttonVariants({ variant, size, className }), showLoading && "relative")}
      {...props}
      disabled={disabled || loading || disabledReason !== undefined}
      aria-disabled={disabledReason !== undefined || props["aria-disabled"]}
      tabIndex={disabledReason !== undefined ? -1 : props.tabIndex}
    >
      {showLoading ? (
        <>
          {/* Reserve the label's width so the box stays the same size; overlay
              the spinner centered on top. */}
          <span className="invisible">{children}</span>
          <span className="absolute inset-0 flex items-center justify-center">
            <Spinner className="size-3.5" />
          </span>
        </>
      ) : (
        children
      )}
    </Comp>
  );
  return disabledReason === undefined ? (
    button
  ) : (
    <DisabledTooltip reason={disabledReason}>{button}</DisabledTooltip>
  );
}

export { Button, buttonVariants };

export type { ButtonProps } from "../../contracts/button.ts";
