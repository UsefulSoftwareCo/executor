import { useId, type ReactNode } from "react";
import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { UserFacingError } from "@executor-js/utils/user-facing-error";
import { Alert, AlertDescription, AlertTitle } from "../components/alert.tsx";
import { Button } from "../components/button.tsx";
import { Spinner } from "../components/spinner.tsx";
import { CopyButton } from "./code.tsx";
import { ErrorTrackedNote } from "./error-tracking.tsx";
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
          "col-span-2 col-start-1 gap-1 pt-1.5 text-[13px] text-foreground/85",
          layout === "panel" && "gap-2 pt-4 text-muted-foreground",
        )}
      >
        <p>{error.description}</p>
        <p>{error.recovery.action}</p>
      </AlertDescription>
      <ErrorTrackedNote error={error} />
      {error.detail && (
        <div className="col-span-2 col-start-1 mt-3 flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">
            {error.detail.label}
          </span>
          <div className="flex items-center gap-2 rounded-md border border-border bg-background/60 py-1 pr-1 pl-2.5">
            <code className="min-w-0 flex-1 font-mono text-[12px] break-all [user-select:all]">
              {error.detail.value}
            </code>
            <CopyButton
              code={error.detail.value}
              label={`Copy ${error.detail.label}`}
              text=""
              inline
            />
          </div>
        </div>
      )}
      <div
        className={cn(
          "col-span-2 col-start-1 mt-4 flex flex-wrap items-center gap-2",
          layout === "panel" && "mt-5 gap-3 border-t border-border pt-5",
        )}
      >
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
        {error.agentFixable && (
          <CopyButton
            code={`${context}\n\n${error.fixPrompt}`}
            label="Copy fix prompt"
            text="Copy fix prompt"
            size={layout === "panel" ? "sm" : "xs"}
            variant="outline"
            inline
          />
        )}
        <code className="ml-auto text-[11px] break-all text-muted-foreground">{error.code}</code>
      </div>
      {retrying && (
        <span role="status" aria-label={retryStatus} className="sr-only">
          {retryStatus}…
        </span>
      )}
    </Alert>
  );
}
