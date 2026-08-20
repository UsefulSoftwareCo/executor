"use client";

import type { ReactNode } from "react";
import { Button } from "./button";
import { cn } from "../lib/utils";

export interface FilterTab<T extends string = string> {
  label: ReactNode;
  value: T;
  count?: number;
}

interface FilterTabsProps<T extends string = string> {
  tabs: FilterTab<T>[];
  value: T;
  onChange: (value: T) => void;
  /** For callers that need the row to behave differently when it runs out of
   *  width — e.g. scroll instead of wrap in a narrow dialog. */
  className?: string;
}

export function FilterTabs<T extends string = string>({
  tabs,
  value,
  onChange,
  className,
}: FilterTabsProps<T>) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {tabs.map((tab) => {
        const isActive = value === tab.value;
        return (
          <Button
            variant="outline"
            size="sm"
            key={tab.value}
            onClick={() => onChange(tab.value)}
            className={cn(
              // 32px is a fine mouse target and a poor thumb one, so phones get the
              // 44px the touch guidelines ask for.
              "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-medium shadow-none transition-transform duration-100 active:scale-[0.98] sm:min-h-0",
              isActive
                ? "border-border bg-background text-foreground"
                : "border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={cn(
                  "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-xs tabular-nums",
                  isActive ? "bg-muted text-foreground" : "bg-muted/60 text-muted-foreground",
                )}
              >
                {tab.count}
              </span>
            )}
          </Button>
        );
      })}
    </div>
  );
}
