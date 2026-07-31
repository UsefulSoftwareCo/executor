/**
 * The three states every artifact has and no model should have to draw:
 * loading, empty, and error.
 *
 * The skill mandates rendering all three ("always render the loading and error
 * states from useQuery"), and until now gave the model nothing to render them
 * WITH — so each artifact invented its own spinner, its own "no data" text, and,
 * when something threw, the shell showed a raw stack trace in a `<pre>`. Three
 * artifacts side by side looked like three products.
 *
 * These are built from the same Skeleton / Alert primitives the console uses, in
 * `design.md`'s idiom: hairline borders, grayscale, mono for metadata, sentence
 * case, and errors that say what happened plus what to do. They are bound into
 * generated-code scope through `components.ts`, so `ArtifactLoading` is simply
 * in scope the way `Card` is.
 */

import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@executor-js/react/components/alert";
import { Button } from "@executor-js/react/components/button";
import { Skeleton } from "@executor-js/react/components/skeleton";
import { cn } from "@executor-js/react/lib/utils";
import { AlertCircle } from "lucide-react";

/**
 * The waiting state, shaped like the thing being waited for.
 *
 * A spinner says "something is happening"; a skeleton in the layout's own shape
 * says "this is what is arriving", and the page does not jump when it does. So
 * the variant is the layout, not a size.
 */
export function ArtifactLoading({
  variant = "list",
  rows = 4,
  label,
  className,
}: {
  /** `list` for stacked rows, `table` for a header plus rows, `cards` for a
   *  metric row, `chart` for a plot area. */
  readonly variant?: "list" | "table" | "cards" | "chart";
  /** How many rows or cards to suggest. Ignored by `chart`. */
  readonly rows?: number;
  /** Optional mono caption, e.g. `Loading deployments...`. */
  readonly label?: string;
  readonly className?: string;
}) {
  const count = Math.max(1, Math.min(rows, 12));
  const items = Array.from({ length: count }, (_, index) => index);

  return (
    <div
      data-slot="artifact-loading"
      data-variant={variant}
      aria-busy="true"
      className={cn("w-full", className)}
    >
      {label && (
        <div className="mb-3 font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
          {label}
        </div>
      )}

      {variant === "cards" && (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(${Math.min(count, 4)}, minmax(0, 1fr))` }}
        >
          {items.slice(0, 4).map((index) => (
            <div key={index} className="rounded-lg border border-border p-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-3 h-6 w-16" />
            </div>
          ))}
        </div>
      )}

      {variant === "chart" && (
        <div className="rounded-lg border border-border p-4">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="mt-4 h-48 w-full" />
        </div>
      )}

      {variant === "table" && (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="border-b border-border px-4 py-2.5">
            <Skeleton className="h-3 w-24" />
          </div>
          {items.map((index) => (
            <div
              key={index}
              className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
            >
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-3 w-1/5" />
              <Skeleton className="ml-auto h-3 w-12" />
            </div>
          ))}
        </div>
      )}

      {variant === "list" && (
        <div className="space-y-2.5">
          {items.map((index) => (
            <Skeleton key={index} className="h-4" style={{ width: `${92 - index * 9}%` }} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Nothing to show, which is not an error.
 *
 * Per `design.md`, an empty state points at the first action rather than
 * announcing absence, so `action` is where a button goes when one exists. No
 * illustration and no icon: type and a hairline carry it.
 */
export function ArtifactEmpty({
  title = "Nothing to show",
  description,
  action,
  className,
}: {
  /** Sentence case, specific: `No deployments in the last 7 days`. */
  readonly title?: string;
  /** What would put something here. */
  readonly description?: ReactNode;
  /** The first action, usually a `Button`. */
  readonly action?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      data-slot="artifact-empty"
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-border px-6 py-10 text-center",
        className,
      )}
    >
      <div className="text-sm font-medium text-foreground">{title}</div>
      {description && (
        <div className="mt-1.5 max-w-sm text-sm text-muted-foreground">{description}</div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** The message out of whatever a query, a mutation or an error boundary handed
 *  us — `Error`, a string, or one of the shapes a tool result can fail with. */
const messageOf = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const record = error as { message?: unknown; error?: { message?: unknown } };
    if (typeof record.message === "string") return record.message;
    if (typeof record.error?.message === "string") return record.error.message;
  }
  return "Unknown error";
};

/**
 * Something failed.
 *
 * Deliberately NOT a stack trace: a stack is for whoever wrote the code, and
 * the person looking at an artifact did not. They get what happened plus what
 * to do — `design.md`'s error contract — with `onRetry` when retrying is the
 * answer. The underlying message is shown, because "something went wrong" is
 * unactionable, but it is set in mono at metadata size rather than dominating
 * the frame.
 */
export function ArtifactError({
  error,
  title = "Couldn't load this",
  hint,
  onRetry,
  className,
}: {
  /** The thrown value, or `query.error`. */
  readonly error: unknown;
  /** Sentence case, what failed. */
  readonly title?: string;
  /** What to do next. Defaults to a retry hint when `onRetry` is given. */
  readonly hint?: ReactNode;
  readonly onRetry?: () => void;
  readonly className?: string;
}) {
  const message = messageOf(error);
  const fallbackHint = onRetry ? "Retry, or check the integration is still connected." : undefined;

  return (
    <Alert data-slot="artifact-error" variant="destructive" className={cn(className)}>
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <span className="font-mono text-xs break-words">{message}</span>
        {(hint ?? fallbackHint) && (
          <span className="mt-1.5 block text-xs text-muted-foreground">{hint ?? fallbackHint}</span>
        )}
        {onRetry && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="mt-2.5 h-7 px-2.5 text-xs"
          >
            Retry
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
