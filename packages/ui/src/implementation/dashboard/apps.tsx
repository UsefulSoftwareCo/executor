import { PageFrame, PageHeader } from "./page.tsx";
import { Option } from "effect";
import { AppCardsSkeleton } from "./loading.tsx";
import { Card } from "@executor-js/ui/components/card";
import { useState, type ReactNode } from "react";
import { QueryResult, useQuery, useDashboard } from "./context.tsx";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, ArrowRight02Icon, Key01Icon } from "@hugeicons/core-free-icons";
import { providerDisplayUrl, type Inventory, type QueryProps } from "../../contracts/dashboard.ts";
import {
  accountSelectionIssues,
  selectedIds,
  accountNeedsSignIn,
} from "../../contracts/dashboard.ts";

import { Empty, ProviderIcon, SearchInput } from "./common.tsx";
import { Button } from "../components/button.tsx";

/** A card for each configured app and its selected accounts. */
export function AppsPage<E>({
  action,
  filters,
  empty,
  pending,
  query,
  Failure,
}: QueryProps<Inventory, E> & {
  readonly action?: ReactNode;
  readonly filters?: ReactNode;
  readonly empty?: ReactNode;
  readonly pending?: ReactNode;
}) {
  const { result, data, refresh } = useQuery(query);
  const [search, setSearch] = useState("");
  return (
    <PageFrame>
      <PageHeader
        title="Apps"
        description="Your installed apps and their selected accounts."
        {...(Option.isSome(data) ? { count: data.value.apps.length } : {})}
      >
        {(!Option.isSome(data) || data.value.apps.length > 0 || pending) && action}
      </PageHeader>
      {/* Controls above cards should use half-card or full-card widths. Search uses a full
          card and Filters uses half a card at each grid breakpoint. */}
      <div className="list-toolbar apps-toolbar mb-4 flex flex-wrap items-center gap-4">
        {(!Option.isSome(data) || data.value.apps.length > 0 || pending || search.length > 0) && (
          <div className="w-[calc((100%_-_2rem)/3)] shrink-0 max-[1100px]:w-[calc((100%_-_1rem)/2)] max-[600px]:w-full">
            <SearchInput value={search} onChange={setSearch} placeholder="Search apps…" />
          </div>
        )}
        {filters && (
          <div className="w-[calc((100%_-_2rem)/6)] shrink-0 max-[1100px]:w-[calc((100%_-_1rem)/4)] max-[600px]:w-1/2">
            {filters}
          </div>
        )}
      </div>
      <QueryResult result={result} Failure={Failure} retry={refresh} pending={<AppCardsSkeleton />}>
        {(data) => (
          <AppsList
            data={data}
            search={search}
            clearSearch={() => setSearch("")}
            pending={search.length === 0 ? pending : undefined}
            empty={
              empty ?? (
                <Empty title="No apps yet" action={action}>
                  Add an app to get started.
                </Empty>
              )
            }
          />
        )}
      </QueryResult>
    </PageFrame>
  );
}
function AppsList({
  data,
  search,
  clearSearch,
  empty,
  pending,
}: {
  readonly data: Inventory;
  readonly search: string;
  readonly clearSearch: () => void;
  readonly empty: ReactNode;
  readonly pending?: ReactNode;
}) {
  const { AppLink } = useDashboard();
  const apps = data.apps.filter((app) => app.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      {data.apps.length === 0 && !pending ? (
        empty
      ) : apps.length === 0 && !pending ? (
        <Empty
          title="No matching apps"
          action={
            <Button variant="outline" onClick={clearSearch}>
              Clear search
            </Button>
          }
        >
          Try another name.
        </Empty>
      ) : (
        <div className="app-cards grid grid-cols-3 [grid-auto-rows:1fr] gap-4 max-[1100px]:grid-cols-2 max-[600px]:grid-cols-1">
          {pending}
          {apps.map((app) => {
            const ids = selectedIds(app);
            const issues = accountSelectionIssues(app, data.accounts);
            const selected = data.accounts.filter((account) => ids.includes(account.id));
            const needsSignIn = selected.some((account) => accountNeedsSignIn(account));
            const unavailable = selected.some((account) => account.signIn?.state === "unavailable");
            const provider = Object.values(app.requirements.accounts)[0]?.definition;
            return (
              <Card asChild key={app.id} className="gap-0 rounded-lg p-4 shadow-none">
                <AppLink
                  className="app-card flex min-h-[137px] flex-col min-w-0 p-[16px] border border-border rounded-[8px] bg-background [transition:border-color_120ms,_background-color_120ms] hover:border-input hover:bg-muted focus-visible:[outline:2px_solid_var(--ring)] focus-visible:outline-offset-[3px]"
                  app={app.id}
                  aria-label={`Open ${app.name}${needsSignIn ? ", needs sign-in" : unavailable ? ", account unavailable" : ""}`}
                >
                  <div className="app-card-heading flex items-center justify-between gap-3">
                    <div className="app-cell [.app-card_&_strong]:text-[14px] [.app-card_&_strong]:overflow-hidden [.app-card_&_strong]:text-ellipsis [.app-card_&_strong]:whitespace-nowrap flex items-center gap-3 min-w-0 [&_>_div]:min-w-0 [&_strong]:text-[13px] [&_strong]:font-medium [&_strong]:block [&_strong]:wrap-anywhere max-[740px]:[&_strong]:text-[14px]">
                      <ProviderIcon
                        name={provider?.name ?? app.name}
                        url={providerDisplayUrl(provider)}
                      />
                      <div>
                        <strong title={app.name}>{app.name}</strong>
                      </div>
                    </div>
                    <HugeiconsIcon
                      icon={ArrowRight02Icon}
                      strokeWidth={2}
                      size={15}
                      className="app-card-arrow shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  </div>
                  <div className="app-card-footer flex items-center justify-between gap-3 mt-auto pt-4 text-[11px] text-muted-foreground">
                    <div className="account-cell [.app-card_&]:flex-1 [.app-card_&]:[align-content:start] [.app-card_&]:text-foreground [.app-card_&_>_span]:min-w-0 grid gap-1.25 text-[12px] min-w-0 [&_>_span]:flex [&_>_span]:items-center [&_>_span]:gap-1.5 [&_>_span]:wrap-anywhere [&_svg]:text-muted-foreground [&_svg]:shrink-0">
                      {issues.length > 0 ? (
                        <span className="setup-state inline-flex items-center gap-1">
                          <HugeiconsIcon
                            icon={AlertCircleIcon}
                            strokeWidth={2}
                            aria-hidden
                            size={12}
                          />
                          <span className="app-card-account-label min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                            {issues.some((issue) => issue.reason === "disconnected")
                              ? "Account disconnected"
                              : "Needs account"}
                          </span>
                        </span>
                      ) : ids.length === 0 ? (
                        <span className="muted text-muted-foreground">No account required</span>
                      ) : (
                        <span>
                          {needsSignIn || unavailable ? (
                            <HugeiconsIcon
                              icon={AlertCircleIcon}
                              strokeWidth={2}
                              aria-hidden
                              size={12}
                            />
                          ) : (
                            <HugeiconsIcon icon={Key01Icon} strokeWidth={2} aria-hidden size={12} />
                          )}
                          <span className="app-card-account-label min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                            {ids
                              .map((id) => {
                                const account = data.accounts.find((account) => account.id === id);
                                return account
                                  ? account.label || "Unnamed account"
                                  : "Account unavailable";
                              })
                              .join(", ")}
                          </span>
                        </span>
                      )}
                    </div>
                    {(needsSignIn || unavailable) && (
                      <span className="sign-in-status text-sign-in-warning text-[11px] font-medium whitespace-nowrap [.app-account-setup_h2_&]:ml-2">
                        {needsSignIn ? "Needs sign-in" : "Account unavailable"}
                      </span>
                    )}
                  </div>
                </AppLink>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
