import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

/** Explain a disabled workspace action on hover or keyboard focus. */
export function WorkspaceAdminHint(props: {
  readonly allowed: boolean;
  readonly children: ReactNode;
}) {
  if (props.allowed) return props.children;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            role="group"
            aria-label="Requires a workspace admin"
            className="inline-flex"
          >
            {props.children}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          Requires a workspace admin
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
