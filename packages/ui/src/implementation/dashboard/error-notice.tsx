import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { UserFacingError } from "@executor-js/utils/user-facing-error";
import { Alert, AlertDescription, AlertTitle } from "../components/alert.tsx";
import { Button } from "../components/button.tsx";
import { Spinner } from "../components/spinner.tsx";
import { CopyButton } from "./code.tsx";
import { ErrorTrackedNote } from "./error-tracking.tsx";
import { cn } from "../lib/utils.ts";

type ErrorNoticeProps = {
  readonly error: UserFacingError;
  /** Product navigation or recovery controls; error contracts remain independent of routing. */
  readonly action?: ReactNode;
  /** The operation supplies task context without changing the error's reusable explanation. */
  readonly context: string;
  /**
   * The product's next step when it does not offer the one the error's recovery names, such as a
   * page that cannot start account setup itself. The explanation and fix prompt stay the error's.
   */
  readonly recovery?: string | undefined;
  readonly retry?: (() => void) | undefined;
  readonly retrying?: boolean | undefined;
  /** `compact` sits among a form's fields: one short block, without the error code. */
  readonly layout?: "inline" | "panel" | "compact" | undefined;
  readonly retryStatus?: string;
};

/** Explain the failure and recovery inline; retain the card while a retry is pending. */
export function ErrorNotice(props: ErrorNoticeProps) {
  return props.layout === "compact" ? <CompactNotice {...props} /> : <CardNotice {...props} />;
}

function CardNotice({
  error,
  action,
  context,
  recovery = error.recovery.action,
  retry,
  retrying = false,
  layout = "inline",
  retryStatus = "Checking connection",
}: ErrorNoticeProps) {
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
        <p>{recovery}</p>
      </AlertDescription>
      <ErrorTrackedNote error={error} />
      {error.detail && (
        <div className="col-span-2 col-start-1 mt-3 flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">
            {error.detail.label}
          </span>
          <div className="flex items-center gap-2 rounded-md border border-border bg-background/60 py-1 pr-1 pl-2.5">
            <code className="min-w-0 flex-1 font-mono text-[12px] wrap-anywhere [user-select:all]">
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

/**
 * A failure as one short block among a form's fields: an icon, a title, and what to do. Products
 * use it for failures they explain without a shared error presentation.
 */
export function CompactFailure({
  title,
  busy = false,
  children,
}: {
  readonly title: string;
  readonly busy?: boolean | undefined;
  /** The explanation, then any detail and actions, stacked. */
  readonly children: ReactNode;
}) {
  const heading = useId();
  return (
    <Alert
      aria-labelledby={heading}
      aria-busy={busy}
      className="gap-y-1 border-destructive/15 bg-destructive/4 px-3 py-2.5 dark:bg-destructive/7 [&>svg]:text-destructive"
    >
      <HugeiconsIcon icon={AlertCircleIcon} size={16} aria-hidden />
      <AlertTitle
        id={heading}
        role="heading"
        aria-level={3}
        className="line-clamp-none text-[13px] leading-5"
      >
        {title}
      </AlertTitle>
      <AlertDescription className="gap-1.5 text-[13px] leading-5 text-muted-foreground">
        {children}
      </AlertDescription>
    </Alert>
  );
}

/**
 * A shared error as a compact failure: one explanation, and the detail as inline monospace text.
 * The error code stays in the fix prompt, which agents read.
 */
function CompactNotice({
  error,
  action,
  context,
  recovery = error.recovery.action,
  retry,
  retrying = false,
  retryStatus = "Checking connection",
}: ErrorNoticeProps) {
  const retryable = error.retryable && retry !== undefined;
  return (
    <CompactFailure title={error.title} busy={retrying}>
      <p className="text-pretty">
        <span>{error.description}</span> <span>{recovery}</span>
      </p>
      <ErrorTrackedNote error={error} className="text-[13px] text-muted-foreground" />
      {error.detail && <InlineDetail {...error.detail} />}
      {(Boolean(action) || retryable || error.agentFixable) && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {action}
          {retryable && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="max-[740px]:min-h-11"
              disabled={retrying}
              onClick={retry}
            >
              {retrying && <Spinner className="size-3" aria-hidden />}
              {retrying ? "Checking…" : "Try again"}
            </Button>
          )}
          {error.agentFixable && (
            <CopyButton
              code={`${context}\n\n${error.fixPrompt}`}
              label="Copy fix prompt"
              text="Copy fix prompt"
              size="xs"
              variant="outline"
              inline
            />
          )}
        </div>
      )}
      {retrying && (
        <span role="status" aria-label={retryStatus} className="sr-only">
          {retryStatus}…
        </span>
      )}
    </CompactFailure>
  );
}

/**
 * A labelled value, such as a service's own response, as inline monospace text. Long values stop
 * after four lines until shown in full; Copy always takes the whole value.
 */
function InlineDetail({ label, value }: { readonly label: string; readonly value: string }) {
  const text = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = text.current;
    if (element === null || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [value, expanded]);
  return (
    <div className="flex w-full min-w-0 items-start gap-1 text-xs leading-5">
      <div className="min-w-0 flex-1">
        <div ref={text} className={cn("wrap-anywhere", !expanded && "line-clamp-4")}>
          {label}: <code className="font-mono text-foreground/90 [user-select:all]">{value}</code>
        </div>
        {(overflows || expanded) && (
          <button
            type="button"
            aria-expanded={expanded}
            className="rounded-sm font-medium text-foreground/80 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Show less" : `Show full ${label.toLowerCase()}`}
          </button>
        )}
      </div>
      <CopyButton code={value} label={`Copy ${label}`} text="" size="icon-xs" inline />
    </div>
  );
}
