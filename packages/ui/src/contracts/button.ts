import type { ComponentProps } from "react";

/** Shared button props, including a loading state that preserves the label's footprint. */
export type ButtonProps = ComponentProps<"button"> & {
  readonly variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link" | null;
  readonly size?:
    | "default"
    | "xs"
    | "sm"
    | "lg"
    | "icon"
    | "icon-xs"
    | "icon-sm"
    | "icon-lg"
    | null;
  readonly asChild?: boolean;
  /** Disable interaction and overlay a spinner; ignored visually when composing with asChild. */
  readonly loading?: boolean;
  /** Keep a forbidden action visible and explain its restriction on hover, focus, or tap. */
  readonly disabledReason?: string | undefined;
};
