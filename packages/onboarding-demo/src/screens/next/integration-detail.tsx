// Reworked: one added integration.
//
// "Integration" and "connection" still exist — an integration can hold several
// accounts, which is a real capability — but the hierarchy is no longer
// something you have to understand before you can start. An add always leaves
// exactly one account row behind, already named, in the one state that matters:
// Needs auth, with the button that fixes it. Tools stay collapsed until there
// are some.

import { ArrowLeftIcon, ArrowUpRightIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { Button } from "@executor-js/react/components/button";
import { cn } from "@executor-js/react/lib/utils";
import type { CatalogItem } from "../../catalog";

export interface DemoAccount {
  readonly label: string;
  readonly status: "needs-auth" | "connected";
  readonly identity?: string;
}

function AccountRow(props: { readonly account: DemoAccount; readonly onAuthenticate: () => void }) {
  const needsAuth = props.account.status === "needs-auth";
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          needsAuth ? "bg-amber-500" : "bg-emerald-500",
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">
          {props.account.identity ?? props.account.label}
        </span>
      </span>
      {needsAuth ? (
        <>
          <span className="shrink-0 text-xs font-medium text-amber-500">Needs auth</span>
          <Button type="button" variant="outline" size="sm" onClick={props.onAuthenticate}>
            Authenticate
          </Button>
        </>
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground">Connected</span>
      )}
    </div>
  );
}

export function NextIntegrationDetail(props: {
  readonly item: CatalogItem;
  readonly accounts: readonly DemoAccount[];
  readonly toolCount: number;
  readonly onBack: () => void;
  readonly onAuthenticate: (accountLabel: string) => void;
  readonly onAddAccount: () => void;
  readonly onRemove: () => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 mb-6 gap-1.5 text-muted-foreground"
          onClick={props.onBack}
        >
          <ArrowLeftIcon className="size-4" />
          All integrations
        </Button>

        <div className="mb-6 flex items-start gap-4">
          <img
            src={props.item.icon}
            alt=""
            className="size-12 shrink-0 rounded-xl object-contain"
          />
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold text-foreground">{props.item.name}</h1>
            <a
              href={`https://integrations.sh/${props.item.domain}/`}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {props.item.domain}
              <ArrowUpRightIcon className="size-3" aria-hidden />
            </a>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={props.onRemove}>
            Remove
          </Button>
        </div>

        <p className="mb-8 text-sm leading-relaxed text-muted-foreground">
          {props.item.description}
        </p>

        <section className="mb-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Accounts
          </h2>
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="divide-y divide-border">
              {props.accounts.map((account) => (
                <AccountRow
                  key={account.label}
                  account={account}
                  onAuthenticate={() => props.onAuthenticate(account.label)}
                />
              ))}
            </div>
            {/* oxlint-disable-next-line react/forbid-elements */}
            <button
              type="button"
              onClick={props.onAddAccount}
              className="flex w-full items-center gap-1.5 border-t border-border px-3 py-2.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
            >
              <PlusIcon className="size-3.5" aria-hidden />
              Add another account
            </button>
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
            <span className="text-sm text-foreground">
              {props.toolCount === 0
                ? "Tools appear once an account is connected"
                : `${props.toolCount} tools`}
            </span>
            <ChevronDownIcon className="size-4 text-muted-foreground" aria-hidden />
          </div>
        </section>
      </div>
    </div>
  );
}
