// Reworked: one added integration.
//
// "Integration" and "connection" still exist — an integration can hold several
// accounts, which is a real capability — but the hierarchy is no longer
// something you have to understand before you can start. An add always leaves
// exactly one account row behind, already named, in the one state that matters:
// Needs auth, with the button that fixes it. Tools stay collapsed until there
// are some.
//
// A custom integration renders through this same screen. The only difference it
// is allowed to make is the one line naming where its definition came from.

import { ArrowLeftIcon, ArrowUpRightIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { Button } from "@executor-js/react/components/button";
import { cn } from "@executor-js/react/lib/utils";
import type { AddedIntegration } from "../../catalog";

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
  readonly item: AddedIntegration;
  readonly accounts: readonly DemoAccount[];
  readonly toolCount: number;
  readonly onBack: () => void;
  readonly onAuthenticate: (accountLabel: string) => void;
  readonly onAddAccount: () => void;
  readonly onRemove: () => void;
}) {
  const custom = props.item.source === "custom";
  return (
    <>
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
        <img src={props.item.icon} alt="" className="size-12 shrink-0 rounded-xl object-contain" />
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-foreground">{props.item.name}</h1>
          {custom ? (
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
              {props.item.url}
            </p>
          ) : (
            <a
              href={`https://integrations.sh/${props.item.domain}/`}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {props.item.domain}
              <ArrowUpRightIcon className="size-3" aria-hidden />
            </a>
          )}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={props.onRemove}>
          Remove
        </Button>
      </div>

      <p className="mb-8 text-sm leading-relaxed text-muted-foreground">{props.item.description}</p>

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
    </>
  );
}

/** The installed list. Without a sidebar this is how you get back to something
 *  you added, so it carries the same status vocabulary as the detail screen. */
export function InstalledList(props: {
  readonly items: readonly {
    readonly item: AddedIntegration;
    readonly accounts: readonly DemoAccount[];
  }[];
  readonly onOpen: (domain: string) => void;
  readonly onBrowse: () => void;
}) {
  if (props.items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border py-16 text-center">
        <p className="text-sm font-medium text-foreground">Nothing added yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Add an integration and it shows up here.
        </p>
        <Button type="button" size="sm" className="mt-4" onClick={props.onBrowse}>
          Browse integrations
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {props.items.map(({ item, accounts }) => {
        const pending = accounts.filter((account) => account.status === "needs-auth").length;
        return (
          // oxlint-disable-next-line react/forbid-elements
          <button
            key={item.domain}
            type="button"
            onClick={() => props.onOpen(item.domain)}
            className="flex items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
          >
            <img
              src={item.icon}
              alt=""
              loading="lazy"
              className="size-8 shrink-0 rounded-md object-contain"
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">{item.name}</span>
                {item.source === "custom" ? (
                  <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                    Custom
                  </span>
                ) : null}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {accounts.length} account{accounts.length === 1 ? "" : "s"}
              </span>
            </span>
            {pending > 0 ? (
              <span className="shrink-0 text-xs font-medium text-amber-500">Needs auth</span>
            ) : (
              <span className="shrink-0 text-xs text-muted-foreground">Connected</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
