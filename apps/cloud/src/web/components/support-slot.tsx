import { useState } from "react";
import { trackEvent } from "@executor-js/react/api/analytics";
import { Button } from "@executor-js/react/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@executor-js/react/components/dialog";
import { SupportOptions } from "./support-options";

// ---------------------------------------------------------------------------
// Cloud-only "Get support" button for the shared shell's `supportSlot`.
// ---------------------------------------------------------------------------

function HelpIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M6.25 6.25c.25-1 1-1.5 1.85-1.5 1 0 1.9.7 1.9 1.7 0 .8-.5 1.2-1.1 1.6-.55.4-.9.7-.9 1.45M8 11.25v.05"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SupportSlot() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          trackEvent("support_opened");
          setOpen(true);
        }}
        className="flex h-auto w-full items-center justify-start gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-normal text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground"
      >
        <HelpIcon className="size-3.5 text-muted-foreground" />
        Get support
      </Button>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Get support</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            Reach out through any of the channels below.
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <SupportOptions />
        </div>
      </DialogContent>
    </Dialog>
  );
}
