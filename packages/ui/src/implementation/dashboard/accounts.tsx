import { PageFrame, PageHeader } from "./page.tsx";
import { Option } from "effect";
import { AccountRowsSkeleton } from "./loading.tsx";
import { useState, type ReactNode } from "react";
import { QueryResult, useQuery, useDashboard } from "./context.tsx";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import type { Inventory, AccountSummary, QueryProps } from "../../contracts/dashboard.ts";
import { selectedIds, displayDate, accountNeedsSignIn } from "../../contracts/dashboard.ts";

import { Empty, ProviderIcon, SearchInput } from "./common.tsx";
import { Button } from "../components/button.tsx";

/** Saved account metadata is shared across app references, without exposing credential values. */
export function AccountsPage<E>({
  query,
  Failure,
  ...props
}: QueryProps<Inventory, E> & {
  readonly action?: ReactNode;
  readonly filters?: ReactNode;
  readonly empty?: ReactNode;
  readonly accountAction?: (account: AccountSummary) => ReactNode;
  readonly accountMeta?: (account: AccountSummary) => ReactNode;
}) {
  const { result, data, refresh } = useQuery(query);
  const [search, setSearch] = useState("");
  return (
    <PageFrame>
      <PageHeader
        title="Accounts"
        description="Saved sign-ins, available to your apps."
        {...(Option.isSome(data) ? { count: data.value.accounts.length } : {})}
      >
        {(!Option.isSome(data) || data.value.accounts.length > 0) && props.action}
      </PageHeader>
      <div className="list-toolbar mb-4 flex flex-wrap items-center gap-[10px_16px]">
        {(!Option.isSome(data) || data.value.accounts.length > 0 || search.length > 0) && (
          <SearchInput value={search} onChange={setSearch} placeholder="Search accounts…" />
        )}
        {props.filters}
      </div>
      <QueryResult
        result={result}
        Failure={Failure}
        retry={refresh}
        pending={<AccountRowsSkeleton />}
      >
        {(data) => (
          <AccountsList
            data={data}
            search={search}
            clearSearch={() => setSearch("")}
            {...props}
            empty={
              props.empty ?? (
                <Empty title="No accounts yet" action={props.action}>
                  Add an account to use it with your apps.
                </Empty>
              )
            }
          />
        )}
      </QueryResult>
    </PageFrame>
  );
}

function AccountsList({
  data,
  search,
  accountAction,
  accountMeta,
  empty,
  clearSearch,
}: {
  readonly data: Inventory;
  readonly search: string;
  readonly empty: ReactNode;
  readonly clearSearch: () => void;
  readonly accountAction?: (account: AccountSummary) => ReactNode;
  readonly accountMeta?: (account: AccountSummary) => ReactNode;
}) {
  const { AppLink, AccountLink } = useDashboard();
  const accounts = data.accounts.filter((account) =>
    `${account.label} ${account.providerName ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      {data.accounts.length === 0 ? (
        empty
      ) : accounts.length === 0 ? (
        <Empty
          title="No matching accounts"
          action={
            <Button variant="outline" onClick={clearSearch}>
              Clear search
            </Button>
          }
        >
          Try another label or provider.
        </Empty>
      ) : (
        <div className="inventory border border-border rounded-[8px] overflow-hidden">
          <div className="inventory-header accounts-grid bg-muted text-muted-foreground py-[9px] px-[16px] text-[11px] grid grid-cols-[minmax(200px,_1.5fr)_minmax(130px,_0.8fr)_minmax(170px,_1fr)] gap-6.25 items-center max-[1000px]:grid-cols-[minmax(0,_1.3fr)_minmax(0,_1fr)] max-[1000px]:gap-4 max-[1000px]:[.inventory-header&_>_span:nth-child(2)]:hidden max-[740px]:hidden max-[740px]:grid-cols-1 max-[740px]:gap-3">
            <span>Account</span>
            <span>Added</span>
            <span>Apps</span>
          </div>
          {accounts.map((account) => {
            const apps = data.apps.filter((app) =>
              data.profiles.some(
                (profile) =>
                  profile.app === app.id && selectedIds(profile.accounts).includes(account.id),
              ),
            );
            return (
              <div
                className="inventory-row accounts-grid grid grid-cols-[minmax(200px,_1.5fr)_minmax(130px,_0.8fr)_minmax(170px,_1fr)] gap-6.25 items-center py-[12px] px-[16px] border-t border-t-border min-h-16 [a&:hover]:bg-muted max-[1000px]:grid-cols-[minmax(0,_1.3fr)_minmax(0,_1fr)] max-[1000px]:gap-4 max-[1000px]:[.inventory-header&_>_span:nth-child(2)]:hidden max-[740px]:grid-cols-1 max-[740px]:gap-3 max-[740px]:py-[12px] max-[740px]:px-[16px] max-[740px]:[&:first-of-type]:border-t-0 max-[740px]:[.inventory-header_+_&]:border-t-0"
                key={account.id}
              >
                <div className="app-cell [.app-card_&_strong]:text-[14px] [.app-card_&_strong]:overflow-hidden [.app-card_&_strong]:text-ellipsis [.app-card_&_strong]:whitespace-nowrap flex items-center gap-3 min-w-0 [&_>_div]:min-w-0 [&_strong]:text-[13px] [&_strong]:font-medium [&_strong]:block [&_strong]:wrap-anywhere max-[740px]:[&_strong]:text-[14px]">
                  <ProviderIcon
                    name={account.providerName ?? "Account"}
                    url={account.providerUrl}
                  />
                  <div>
                    <AccountLink account={account.id}>
                      <strong>{account.label || "Unnamed account"}</strong>
                    </AccountLink>
                    <div className="row-meta flex flex-wrap gap-1.5 items-center mt-0.75 text-[11px] text-muted-foreground">
                      {account.providerName && (
                        <>
                          <span>{account.providerName}</span>
                          <span>·</span>
                        </>
                      )}
                      <span>{account.method}</span>
                      {accountMeta?.(account)}
                      {accountNeedsSignIn(account) && (
                        <span className="sign-in-status text-sign-in-warning text-[11px] font-medium whitespace-nowrap [.app-account-setup_h2_&]:ml-2">
                          Needs sign-in
                        </span>
                      )}
                      {account.signIn?.state === "unavailable" && (
                        <span className="sign-in-status text-sign-in-warning text-[11px] font-medium whitespace-nowrap [.app-account-setup_h2_&]:ml-2">
                          Account unavailable
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="account-date text-[12px] text-muted-foreground wrap-anywhere max-[1000px]:hidden max-[740px]:hidden">
                  {displayDate(account.createdAt)}
                </div>
                <div className="app-references flex flex-wrap gap-1.75 text-[12px] [&_>_a]:inline-flex [&_>_a]:items-center [&_>_a]:gap-1.25 [&_>_a]:border [&_>_a]:border-border [&_>_a]:rounded-[5px] [&_>_a]:py-[3px] [&_>_a]:px-[7px] [&_>_a:hover]:bg-accent max-[740px]:[.inventory-row_&]:pl-11.5 max-[740px]:[&_>_a]:min-h-11 max-[740px]:[&_>_a]:wrap-anywhere max-[740px]:[&_>_a_svg]:shrink-0">
                  {apps.length === 0 ? (
                    <span className="muted text-muted-foreground">No apps</span>
                  ) : (
                    apps.map((app) => (
                      <AppLink app={app.id} view="accounts" key={app.id}>
                        {app.name}
                        <HugeiconsIcon
                          icon={ArrowUpRight01Icon}
                          strokeWidth={2}
                          aria-hidden
                          size={12}
                        />
                      </AppLink>
                    ))
                  )}
                  {accountAction?.(account)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
