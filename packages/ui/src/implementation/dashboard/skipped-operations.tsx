/** Show which API operations an import left out, before the user continues to the new app. */
import { useId, useState } from "react";
import { AlertCircleIcon, ArrowRight02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  skippedOperationSummary,
  type ImportedApp,
  type SkippedOperation,
} from "@executor-js/catalog/contracts";
import { Alert, AlertDescription, AlertTitle } from "../components/alert.tsx";
import { Button } from "../components/button.tsx";

/** Hold a new app with skipped operations until the user has seen them; continue at once otherwise. */
export function useImportReview(onInstalled: (app: ImportedApp) => void | Promise<void>) {
  const [review, setReview] = useState<ImportedApp>();
  return {
    review,
    installed: (app: ImportedApp) =>
      app.skippedOperations.length ? setReview(app) : onInstalled(app),
  };
}

/** The app is ready; list each operation it does not include and how to add it. */
export function SkippedOperationsNotice({
  operations,
  onContinue,
}: {
  readonly operations: readonly SkippedOperation[];
  readonly onContinue: () => void | Promise<void>;
}) {
  const title = useId();
  const count = operations.length;
  return (
    <Alert
      role="status"
      aria-labelledby={title}
      className="max-w-145 rounded-xl border-border bg-muted/15 p-6 shadow-xs has-[>svg]:grid-cols-[20px_1fr] has-[>svg]:gap-x-3 [&>svg]:size-5 [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400"
    >
      <HugeiconsIcon icon={AlertCircleIcon} size={16} aria-hidden />
      <AlertTitle
        id={title}
        role="heading"
        aria-level={2}
        className="line-clamp-none text-base leading-6"
      >
        App added without {count === 1 ? "1 operation" : `${count} operations`}
      </AlertTitle>
      <AlertDescription className="col-span-2 col-start-1 gap-4 pt-3 text-[13px]">
        <p>
          Executor could not add {count === 1 ? "this operation" : "these operations"} from the API
          definition. The other tools are ready to use.
        </p>
        <ul className="w-full max-h-72 overflow-auto rounded-lg border border-border bg-background divide-y divide-border">
          {operations.map((operation) => (
            <li
              key={`${operation.method} ${operation.path} ${operation.tool}`}
              className="flex flex-col gap-0.5 px-3 py-2.5"
            >
              <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="font-mono text-[12px] text-foreground wrap-anywhere">
                  {operation.tool}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground wrap-anywhere">
                  {operation.method} {operation.path}
                </span>
              </span>
              <span className="text-[12px] text-muted-foreground">
                {skippedOperationSummary(operation.reason)}
              </span>
            </li>
          ))}
        </ul>
        <p>
          To add {count === 1 ? "it" : "them"}, edit the app source. The file{" "}
          <code className="font-mono text-foreground">skipped-operations.json</code> lists each
          operation and the reason.
        </p>
      </AlertDescription>
      <div className="col-span-2 col-start-1 mt-5 flex border-t border-border pt-5">
        <Button type="button" onClick={() => void onContinue()}>
          Continue
          <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} aria-hidden size={14} />
        </Button>
      </div>
    </Alert>
  );
}
