"use client";

import type * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "../lib/utils.ts";

/** A non-modal anchored surface with outside-click and Escape dismissal. */
export function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root {...props} />;
}

/** The caller supplies the accessible trigger, commonly a Button through asChild. */
export function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

/** Portal content stays within the viewport and returns focus to its trigger on close. */
export function PopoverContent({
  className,
  align = "end",
  sideOffset = 8,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn(
          "z-50 w-96 max-w-[calc(100vw-24px)] max-h-(--radix-popover-content-available-height) overflow-auto rounded-lg border bg-popover p-4 text-popover-foreground shadow-md outline-hidden",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
