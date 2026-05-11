import { InfoIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { Button } from "./button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

export function HelpTooltip(props: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`${props.label} help`}
          >
            <InfoIcon className="size-3.5" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent className={cn("w-max max-w-72 text-left text-wrap", props.className)}>
          {props.children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
