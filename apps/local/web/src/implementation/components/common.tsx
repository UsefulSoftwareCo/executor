import { Alert } from "@executor-js/ui/components/alert";
import { Button } from "@executor-js/ui/components/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import type { FailureProps } from "@executor-js/ui/contracts/dashboard";
import { failureMessage, type DashboardError } from "../../contracts/errors.ts";
import { Link } from "@tanstack/react-router";
export {
  ProviderIcon,
  SearchInput,
  LoadingRows,
  Empty,
  SectionHeading,
} from "@executor-js/ui/dashboard/common";
/** Render the local product's typed failures without exposing transport or credential data. */
export function Failure({ cause, retry }: FailureProps<DashboardError>) {
  const { title, description, account } = failureMessage(cause);
  return (
    <Alert className="error-state flex items-start gap-2.5 p-[15px] border border-border rounded-[7px] mb-4 [&_>_svg]:text-destructive [&_>_svg]:shrink-0 [&_>_svg]:mt-0.5 [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere [&_>_div]:flex-1 [&_strong]:text-[13px] [&_strong]:font-medium [&_p]:text-[12px] [&_p]:text-muted-foreground [&_p]:mt-0.75 max-[740px]:flex-wrap max-[740px]:[&_>_div]:basis-[calc(100%_-_30px)] max-[740px]:[&_>_button]:ml-6.75">
      <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} aria-hidden size={17} />
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      {account !== undefined ? (
        <Button variant="outline" size="sm" asChild>
          <Link to="/accounts/$accountId/credentials" params={{ accountId: account }}>
            Reconnect
          </Link>
        </Button>
      ) : (
        retry && (
          <Button variant="outline" size="sm" onClick={retry}>
            Retry
          </Button>
        )
      )}
    </Alert>
  );
}
