import { useId, type ReactNode } from "react";
import { Spinner } from "@executor-js/ui/components/spinner";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, InformationCircleIcon } from "@hugeicons/core-free-icons";

/** Center connection progress or failure content; callers own recovery actions and navigation. */
export function ConnectionStatusPage({
  status,
  label,
  message,
  children,
}: {
  readonly status: "connecting" | "failed" | "cancelled";
  readonly label?: string | undefined;
  readonly message: string;
  readonly children?: ReactNode;
}) {
  const titleId = useId();
  const title = {
    connecting: "Connecting account…",
    failed: "Account not connected",
    cancelled: "Connection cancelled",
  }[status];
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-12 sm:px-6">
      <div className="w-full max-w-110">
        <div className="mb-6 flex items-center justify-center gap-2 text-[19px] font-semibold tracking-[-0.04em]">
          <img src="/favicon.png" alt="" className="size-6" />
          executor
        </div>
        <section
          aria-labelledby={titleId}
          className="flex min-h-88 flex-col items-center justify-center rounded-xl border border-border bg-card p-6 text-center sm:p-8"
        >
          <div className="mb-5 flex size-11 items-center justify-center rounded-full bg-muted">
            {status === "connecting" ? (
              <Spinner className="size-6 motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <HugeiconsIcon
                icon={status === "cancelled" ? InformationCircleIcon : AlertCircleIcon}
                className={
                  status === "cancelled"
                    ? "size-6 text-muted-foreground"
                    : "size-6 text-destructive"
                }
                aria-hidden="true"
              />
            )}
          </div>
          {label && <p className="mb-2 break-words text-[13px] text-muted-foreground">{label}</p>}
          <h1 id={titleId} className="text-[22px] font-semibold leading-tight tracking-[-0.035em]">
            {title}
          </h1>
          <p
            className="mt-3 text-sm leading-6 text-muted-foreground"
            role={status === "connecting" ? "status" : "alert"}
          >
            {message}
          </p>
          {children && (
            <div className="mt-6 flex w-full flex-col justify-center gap-2 sm:flex-row">
              {children}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
