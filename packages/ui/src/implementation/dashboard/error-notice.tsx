import { useId } from "react";
import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { UserFacingError } from "@executor-js/utils/user-facing-error";
import { Alert, AlertDescription, AlertTitle } from "../components/alert.tsx";
import { Button } from "../components/button.tsx";
import { Spinner } from "../components/spinner.tsx";
import { CopyButton } from "./code.tsx";

/** Explain the failure and recovery inline; retain the card while a retry is pending. */
export function ErrorNotice({
  error,
  context,
  retry,
  retrying = false,
}: {
  readonly error: UserFacingError;
  /** The operation supplies task context without changing the error's reusable explanation. */
  readonly context: string;
  readonly retry: () => void;
  readonly retrying?: boolean;
}) {
  const title = useId();
  return (
    <Alert
      aria-labelledby={title}
      aria-busy={retrying}
      className="border-destructive/20 bg-destructive/5 p-4 [&>svg]:text-destructive"
    >
      <HugeiconsIcon icon={AlertCircleIcon} size={16} aria-hidden />
      <AlertTitle id={title} role="heading" aria-level={3} className="line-clamp-none leading-5">
        {error.title}
      </AlertTitle>
      <AlertDescription className="col-span-2 col-start-1 gap-3 pt-2 text-[13px] text-foreground/85">
        <p>{error.description}</p>
        <p>{error.recovery.action}</p>
      </AlertDescription>
      <div className="col-span-2 col-start-1 mt-4 flex flex-col gap-3 border-t border-destructive/10 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          {error.retryable && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-w-28 text-xs"
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
            inline
          />
        </div>
        <code className="text-[11px] leading-relaxed break-all text-muted-foreground">
          {error.code}
        </code>
      </div>
      {retrying && (
        <span role="status" aria-label="Checking connection" className="sr-only">
          Checking connection…
        </span>
      )}
    </Alert>
  );
}
