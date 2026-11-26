import type { ComponentProps } from "react";

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
  readonly loading?: boolean;
  readonly disabledReason?: string | undefined;
};
