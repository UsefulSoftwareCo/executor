import { useRef, useState, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip.tsx";
import { cn } from "../lib/utils.ts";

export function DisabledTooltip({
  reason,
  children,
  className,
}: {
  readonly reason: string | undefined;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLSpanElement>(null);
  if (reason === undefined) return children;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip
        open={open}
        onOpenChange={(next) => {
          if (next || !trigger.current?.matches(":focus")) setOpen(next);
        }}
      >
        <TooltipTrigger asChild>
          <span
            ref={trigger}
            tabIndex={0}
            onBlur={() => setOpen(false)}
            aria-disabled="true"
            data-disabled-reason={reason}
            className={cn(
              "inline-flex shrink-0 min-w-0 max-w-full cursor-not-allowed rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring [&>*]:pointer-events-none",
              className,
            )}
            onClickCapture={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setOpen(true);
            }}
            onKeyDownCapture={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(true);
              }
            }}
          >
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent
          sideOffset={6}
          onEscapeKeyDown={() => setOpen(false)}
          onPointerDownOutside={() => setOpen(false)}
          className="max-w-72 leading-5"
        >
          {reason}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
