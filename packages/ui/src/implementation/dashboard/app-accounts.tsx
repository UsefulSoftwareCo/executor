import { AppSectionHeader, AppSectionTitle } from "./app-section-header.tsx";
import type { ReactNode } from "react";
import { useDashboard } from "./context.tsx";
import type { App, AccountRequirement } from "@executor-js/sdk";
import {
  providerDisplayUrl,
  accountSelectionIssues,
  accountNeedsSignIn,
  type AccountSummary,
} from "../../contracts/dashboard.ts";
import { Empty, ProviderIcon } from "./common.tsx";

/** Compact provider rows show the selected identities and the host's account actions. */
export function AppAccounts({
  app,
  accounts,
  chooseAction,
  reconnectAction,
  accountActions,
}: {
  readonly app: App;
  readonly accounts: readonly AccountSummary[];
  readonly chooseAction?: ReactNode;
  readonly reconnectAction?: (account: AccountSummary) => ReactNode;
  readonly accountActions?: (slot: string, requirement: AccountRequirement) => ReactNode;
}) {
  const { AccountLink } = useDashboard();
  const requirements = Object.entries(app.requirements.accounts);
  const issues = accountSelectionIssues(app, accounts);
  return (
    <div className="accounts-section">
      <AppSectionHeader>
        <AppSectionTitle>Accounts</AppSectionTitle>
        {chooseAction}
      </AppSectionHeader>
      <div className="p-7 max-[740px]:p-4">
        {requirements.length === 0 ? (
          <Empty title="No accounts required">This app can run without a saved account.</Empty>
        ) : (
          <div className="requirements-list max-w-185 overflow-hidden rounded-lg border border-border">
            {requirements.map(([slot, requirement]) => {
              const selection = app.accounts[slot];
              const ids = typeof selection === "string" ? [selection] : (selection ?? []);
              return (
                <section
                  key={slot}
                  aria-label={
                    requirements.length > 1
                      ? `${requirement.definition.name} (${slot})`
                      : requirement.definition.name
                  }
                  className="requirement flex items-center gap-3.5 p-4 [&+.requirement]:border-t max-[480px]:flex-wrap"
                >
                  <ProviderIcon
                    name={requirement.definition.name}
                    url={providerDisplayUrl(requirement.definition)}
                  />
                  <div className="min-w-0 flex-1 max-[480px]:min-w-[calc(100%-52px)]">
                    <h3 className="text-sm font-medium">
                      {requirement.definition.name}
                      {requirements.length > 1 && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {slot}
                        </span>
                      )}
                    </h3>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      {ids.map((id, index) => {
                        const account = accounts.find((item) => item.id === id);
                        return (
                          <span
                            key={id}
                            className="inline-flex min-w-0 items-center gap-2 break-words"
                          >
                            {index > 0 && <span aria-hidden>·</span>}
                            {account ? (
                              <>
                                <span className="text-foreground/80 hover:text-foreground hover:underline">
                                  <AccountLink account={account.id}>
                                    {account.label || "Unnamed account"}
                                  </AccountLink>
                                </span>
                                {accountNeedsSignIn(account) ? (
                                  <>
                                    <span className="text-sign-in-warning">Needs sign-in</span>
                                    {reconnectAction?.(account)}
                                  </>
                                ) : account.signIn?.state === "unavailable" ? (
                                  <span className="text-destructive">Unavailable</span>
                                ) : null}
                              </>
                            ) : (
                              <>
                                <span className="text-destructive">Account disconnected</span>
                                {chooseAction}
                              </>
                            )}
                          </span>
                        );
                      })}
                      {ids.length === 0 && (
                        <span>
                          {issues.some((issue) => issue.slot === slot)
                            ? "No account connected"
                            : "No account needed"}
                        </span>
                      )}
                    </div>
                  </div>
                  {accountActions && (
                    <div className="flex shrink-0 flex-wrap items-center gap-2 max-[480px]:ml-[48px]">
                      {accountActions(slot, requirement)}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
