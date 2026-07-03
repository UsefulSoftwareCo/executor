"use client";

import { Loader2 } from "lucide-react";

export default function Loading() {
  return (
    <div className="flex h-full flex-col">
      {/* Messages area with centered spinner */}
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>

      {/* Input area shell pinned to bottom */}
      <div className="shrink-0 p-4 pb-2 sm:pb-8">
        <div className="mx-auto max-w-4xl">
          <div className="overflow-hidden rounded-2xl bg-muted">
            <div className="px-4 pb-2 pt-3">
              <textarea
                disabled
                rows={1}
                placeholder="Request changes or ask a question..."
                className="w-full resize-none overflow-y-auto bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none"
                style={{ minHeight: "24px" }}
              />
            </div>
            <div className="flex items-center justify-between px-3 pb-2">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-full bg-muted-foreground/10" />
              </div>
              <div className="flex items-center gap-1">
                <div className="h-8 w-8 rounded-full bg-muted-foreground/10" />
                <div className="h-8 w-8 rounded-full bg-muted-foreground/10" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
