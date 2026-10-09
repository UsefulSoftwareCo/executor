import { AppProviderFailed } from "@executor-js/sdk";
import { Cause, Option, Schema } from "effect";
import { ProviderErrorNotice } from "@executor-js/ui/dashboard/provider-error-notice";
import { CompactFailure, ErrorNotice } from "@executor-js/ui/dashboard/error-notice";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { Alert } from "@executor-js/ui/components/alert";
import { Button } from "@executor-js/ui/components/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import type { FailureProps } from "@executor-js/ui/contracts/dashboard";
import {
  connectionLinkRecovery,
  failureMessage,
  type DashboardError,
} from "../../contracts/errors.ts";
import { Link, useParams } from "@tanstack/react-router";
export {
  ProviderIcon,
  SearchInput,
  LoadingRows,
  Empty,
  SectionHeading,
} from "@executor-js/ui/dashboard/common";
/** Render the local product's typed failures without exposing transport or credential data. */
export function Failure({
  cause,
  retry,
  retrying,
  layout,
  recovery,
}: FailureProps<DashboardError> & {
  /** The page's own next step, when it cannot offer the one the error's recovery names. */
  readonly recovery?: string | undefined;
}) {
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error) && Schema.is(AppProviderFailed)(error.value))
    return (
      <ProviderErrorNotice
        error={error.value}
        context="While using this app and selected profile."
        retry={retry}
        retrying={retrying}
        layout={layout}
      />
    );
  const { title, description, account } = failureMessage(cause);
  const app = useParams({ strict: false }).appId;
  // Credentials are replaced from the app that needs them, on its Accounts tab.
  const reconnect = account !== undefined && app !== undefined && (
    <Button variant="outline" size="sm" asChild>
      <Link to="/apps/$appId" params={{ appId: app }} search={{ view: "accounts" }}>
        Reconnect
      </Link>
    </Button>
  );
  if (Option.isSome(error) && UserFacingError.is(error.value))
    return (
      <ErrorNotice
        error={error.value}
        action={reconnect}
        context="While completing this action in Executor."
        recovery={recovery}
        retry={retry}
        retrying={retrying}
        layout={layout}
      />
    );
  if (layout === "compact")
    return (
      <CompactFailure title={title}>
        <div>{description}</div>
        {(reconnect || retry) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {reconnect ||
              (retry && (
                <Button variant="outline" size="xs" onClick={retry}>
                  Retry
                </Button>
              ))}
          </div>
        )}
      </CompactFailure>
    );
  return (
    <Alert className="error-state flex items-start gap-2.5 p-[15px] border border-border rounded-[7px] mb-4 [&_>_svg]:text-destructive [&_>_svg]:shrink-0 [&_>_svg]:mt-0.5 [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere [&_>_div]:flex-1 [&_strong]:text-[13px] [&_strong]:font-medium [&_p]:text-[12px] [&_p]:text-muted-foreground [&_p]:mt-0.75 max-[740px]:flex-wrap max-[740px]:[&_>_div]:basis-[calc(100%_-_30px)] max-[740px]:[&_>_button]:ml-6.75">
      <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} aria-hidden size={17} />
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      {reconnect ||
        (retry && (
          <Button variant="outline" size="sm" onClick={retry}>
            Retry
          </Button>
        ))}
    </Alert>
  );
}
/** Failures on a connection link page, where only the agent that sent the link can start again. */
export function ConnectionLinkFailure({
  cause,
  retry,
  retrying,
  layout,
}: FailureProps<DashboardError>) {
  return (
    <Failure
      cause={cause}
      retry={retry}
      retrying={retrying}
      layout={layout}
      recovery={Option.match(Cause.findErrorOption(cause), {
        onSome: connectionLinkRecovery,
        onNone: () => undefined,
      })}
    />
  );
}
