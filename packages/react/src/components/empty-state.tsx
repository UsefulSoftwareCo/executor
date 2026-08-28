import type { ReactNode } from "react";

import { cn } from "../lib/utils";

export function EmptyState(props: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn("rounded-md border border-dashed border-border bg-card p-8", props.className)}
    >
      <h3 className="text-base font-semibold text-foreground">{props.title}</h3>
      <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{props.description}</p>
      {props.action ? <div className="mt-4">{props.action}</div> : null}
    </div>
  );
}
