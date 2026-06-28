import * as React from "react";
import { InfoIcon, TriangleAlertIcon } from "lucide-react";

import { cn } from "../lib/utils";

type InfoVariant = "default" | "warning";

const variantClassName: Record<
  InfoVariant,
  {
    readonly root: string;
    readonly icon: string;
  }
> = {
  default: {
    root: "border-border/70 bg-card/50 text-foreground",
    icon: "text-muted-foreground",
  },
  warning: {
    root: "border-border/70 border-l-foreground/40 bg-card text-foreground shadow-xs dark:border-border/70 dark:border-l-foreground/30 dark:bg-card/70",
    icon: "text-muted-foreground",
  },
};

function Info({
  className,
  variant = "default",
  children,
  ...props
}: React.ComponentProps<"section"> & {
  readonly variant?: InfoVariant;
}) {
  const Icon = variant === "warning" ? TriangleAlertIcon : InfoIcon;
  const variantClass = variantClassName[variant];
  return (
    <section
      data-slot="info"
      className={cn(
        "grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-1 rounded-md border px-3 py-2.5 text-sm",
        variant === "warning" ? "border-l-[3px]" : null,
        variantClass.root,
        className,
      )}
      {...props}
    >
      <Icon className={cn("mt-0.5 size-4", variantClass.icon)} aria-hidden />
      <div className="min-w-0 space-y-1.5">{children}</div>
    </section>
  );
}

function InfoTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="info-title"
      className={cn("text-[13px] font-medium leading-5 text-current", className)}
      {...props}
    />
  );
}

function InfoDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="info-description"
      className={cn("text-[12px] leading-5 text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Info, InfoTitle, InfoDescription };
