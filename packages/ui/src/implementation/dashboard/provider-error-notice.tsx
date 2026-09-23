import type { ComponentProps } from "react";
import type { AppProviderFailed } from "@executor-js/sdk";
import { buttonVariants } from "../components/button.tsx";
import { useDashboard } from "./context.tsx";
import { ErrorNotice } from "./error-notice.tsx";

/** Shared recovery uses the product's account route and the server-verified account identity. */
export function ProviderErrorNotice({
  error,
  ...props
}: Omit<ComponentProps<typeof ErrorNotice>, "error" | "action"> & {
  readonly error: AppProviderFailed;
}) {
  const { AccountLink } = useDashboard();
  return (
    <ErrorNotice
      {...props}
      error={error}
      action={
        error.account !== undefined && error.reason !== "rate_limited" ? (
          <AccountLink
            account={error.account.id}
            className={buttonVariants({ size: "sm", variant: "default" })}
          >
            Manage account
          </AccountLink>
        ) : undefined
      }
    />
  );
}
