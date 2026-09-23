import { useId, type ReactNode } from "react";
import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { UserFacingError } from "@executor-js/utils/user-facing-error";
import { Alert, AlertDescription, AlertTitle } from "../components/alert.tsx";
import { Button } from "../components/button.tsx";
import { Spinner } from "../components/spinner.tsx";
import { CopyButton } from "./code.tsx";
import { cn } from "../lib/utils.ts";

/** Explain the failure and recovery inline; retain the card while a retry is pending. */
export function ErrorNotice({
  error,
  action,
  context,
  retry,
  retrying = false,
  layout = "inline",
  retryStatus = "Checking connection",
}: {
  readonly error: UserFacingError;
  /** Product navigation or recovery controls; error contracts remain independent of routing. */
  readonly action?: ReactNode;
  /** The operation supplies task context without changing the error's reusable explanation. */
  readonly context: string;
  readonly retry?: (() => void) | undefined;
  readonly retrying?: boolean | undefined;
  readonly layout?: "inline" | "panel";
  readonly retryStatus?: string;
}) {
  const title = useId();
  return (
    <Alert
      aria-labelledby={title}
      aria-busy={retrying}
      className={cn(
        "border-destructive/20 bg-destructive/5 p-4 [&>svg]:text-destructive",
        layout === "panel" &&
          "rounded-xl border-border bg-muted/15 p-6 shadow-xs has-[>svg]:grid-cols-[20px_1fr] has-[>svg]:gap-x-3 [&>svg]:size-5 [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400",
      )}
    >
      <HugeiconsIcon icon={AlertCircleIcon} size={16} aria-hidden />
      <AlertTitle
        id={title}
        role="heading"
        aria-level={3}
        className={cn("line-clamp-none leading-5", layout === "panel" && "text-base leading-6")}
      >
        {error.title}
      </AlertTitle>
      <AlertDescription
        className={cn(
          "col-span-2 col-start-1 gap-3 pt-2 text-[13px] text-foreground/85",
          layout === "panel" && "gap-2 pt-4 text-muted-foreground",
        )}
      >
        <p>{error.description}</p>
        <p>{error.recovery.action}</p>
      </AlertDescription>
      <div
        className={cn(
          "col-span-2 col-start-1 mt-4 flex flex-col gap-3 border-t border-destructive/10 pt-3",
          layout === "panel" && "mt-5 gap-4 border-border pt-5",
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          {action}
          {error.retryable && retry && (
            <Button
              type="button"
              size="sm"
              variant={layout === "panel" ? "default" : "outline"}
              className="min-w-28 text-xs max-[740px]:min-h-11"
              disabled={retrying}
              onClick={retry}
            >
              {retrying && <Spinner className="size-3.5" aria-hidden />}
              {retrying ? "Checking…" : "Try again"}
            </Button>
          )}
          <CopyButton
            code={`${context}\n\n${error.fixPrompt}`}
            label="Copy fix prompt"
            text="Copy fix prompt"
            size="sm"
            variant={layout === "panel" ? "outline" : "ghost"}
            inline
          />
        </div>
        <code className="text-[11px] leading-relaxed break-all text-muted-foreground">
          {error.code}
        </code>
      </div>
      {retrying && (
        <span role="status" aria-label={retryStatus} className="sr-only">
          {retryStatus}…
        </span>
      )}
    </Alert>
  );
}
