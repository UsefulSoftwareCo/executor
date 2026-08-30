// The reworked flow, wired end to end: browse → add (in place) → the added
// integration → authenticate, plus the custom-URL door that bypasses the
// registry entirely. Adding never blocks and never navigates; the only thing
// that moves you off the picker is choosing to look at something.
//
// Every screen is a hash route, so any of them can be linked to directly:
//   #reworked                     the picker
//   #reworked/installed           what you've added
//   #reworked/custom              the custom-URL dialog
//   #reworked/<domain>            one integration
//   #reworked/<domain>/auth       …with its authenticate dialog open

import { useCallback, useEffect, useState } from "react";
import { Button } from "@executor-js/react/components/button";
import { cn } from "@executor-js/react/lib/utils";
import { Shell } from "./shell";
import { BrowsePage } from "./screens/next/browse";
import {
  InstalledList,
  NextIntegrationDetail,
  type DemoAccount,
} from "./screens/next/integration-detail";
import { AuthenticateDialog } from "./screens/next/authenticate";
import { AddCustomDialog } from "./screens/next/custom";
import { fromCatalogItem, type AddedIntegration, type CatalogItem } from "./catalog";
import type { DemoIntegration } from "./fixtures";

interface Added {
  readonly item: AddedIntegration;
  readonly accounts: readonly DemoAccount[];
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export type NextRoute =
  | { readonly kind: "browse" }
  | { readonly kind: "installed" }
  | { readonly kind: "custom" }
  | { readonly kind: "detail"; readonly domain: string }
  | { readonly kind: "auth"; readonly domain: string };

const parseRoute = (hash: string): NextRoute => {
  // `#reworked/...` is canonical; `#next/...` is kept working because it was
  // the first spelling and may already be pasted somewhere.
  const path = hash.replace(/^#/, "").replace(/^(reworked|next)\/?/, "");
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return { kind: "browse" };
  const [first, second] = segments;
  if (first === "installed") return { kind: "installed" };
  if (first === "custom") return { kind: "custom" };
  if (first && second === "auth") return { kind: "auth", domain: first };
  if (first) return { kind: "detail", domain: first };
  return { kind: "browse" };
};

const routeToHash = (route: NextRoute): string => {
  if (route.kind === "browse") return "#reworked";
  if (route.kind === "installed") return "#reworked/installed";
  if (route.kind === "custom") return "#reworked/custom";
  if (route.kind === "auth") return `#reworked/${route.domain}/auth`;
  return `#reworked/${route.domain}`;
};

// ---------------------------------------------------------------------------

const toolsFor = (accounts: readonly DemoAccount[]): number =>
  accounts.some((account) => account.status === "connected") ? 24 : 0;

/** What the console sidebar lists: the same added integrations, in the shape
 *  the shell already renders. */
const asSidebarIntegration = (added: Added): DemoIntegration => ({
  slug: added.item.domain,
  name: added.item.name,
  kind: "openapi",
  icon: added.item.icon,
  toolCount: toolsFor(added.accounts),
});

export function NextFlow() {
  const [added, setAdded] = useState<readonly Added[]>([]);
  const [route, setRoute] = useState<NextRoute>(() => parseRoute(globalThis.location?.hash ?? ""));

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(globalThis.location?.hash ?? ""));
    globalThis.addEventListener("hashchange", onHashChange);
    return () => globalThis.removeEventListener("hashchange", onHashChange);
  }, []);

  const go = useCallback((next: NextRoute) => {
    setRoute(next);
    if (globalThis.location) globalThis.location.hash = routeToHash(next);
  }, []);

  const addIntegration = useCallback((item: AddedIntegration) => {
    setAdded((previous) =>
      previous.some((entry) => entry.item.domain === item.domain)
        ? previous
        : [
            ...previous,
            // An add always leaves exactly one account behind, already named
            // and in the one state that matters.
            { item, accounts: [{ label: "default", status: "needs-auth" as const }] },
          ],
    );
  }, []);

  const addFromCatalog = useCallback(
    (item: CatalogItem) => addIntegration(fromCatalogItem(item)),
    [addIntegration],
  );

  const markConnected = useCallback((domain: string, accountLabel: string, identity: string) => {
    setAdded((previous) =>
      previous.map((entry) =>
        entry.item.domain === domain
          ? {
              ...entry,
              accounts: entry.accounts.map((account) =>
                account.label === accountLabel
                  ? { ...account, status: "connected" as const, identity }
                  : account,
              ),
            }
          : entry,
      ),
    );
  }, []);

  const activeDomain = route.kind === "detail" || route.kind === "auth" ? route.domain : null;
  const open = added.find((entry) => entry.item.domain === activeDomain) ?? null;
  const pendingCount = added.filter((entry) =>
    entry.accounts.some((account) => account.status === "needs-auth"),
  ).length;

  // A deep link can name a domain that has not been added in this session.
  // Say so rather than rendering an empty detail screen.
  const missing = activeDomain !== null && open === null;

  const showingInstalled = route.kind === "installed";
  const showingBrowse = route.kind === "browse" || route.kind === "custom";

  return (
    <Shell integrations={added.map(asSidebarIntegration)}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 py-10">
          {open && !missing ? (
            <NextIntegrationDetail
              item={open.item}
              accounts={open.accounts}
              toolCount={toolsFor(open.accounts)}
              onBack={() => go({ kind: "installed" })}
              onAuthenticate={() => go({ kind: "auth", domain: open.item.domain })}
              onAddAccount={() =>
                setAdded((previous) =>
                  previous.map((entry) =>
                    entry.item.domain === open.item.domain
                      ? {
                          ...entry,
                          accounts: [
                            ...entry.accounts,
                            {
                              label: `account ${entry.accounts.length + 1}`,
                              status: "needs-auth" as const,
                            },
                          ],
                        }
                      : entry,
                  ),
                )
              }
              onRemove={() => {
                setAdded((previous) =>
                  previous.filter((entry) => entry.item.domain !== open.item.domain),
                );
                go({ kind: "installed" });
              }}
            />
          ) : missing ? (
            <div className="rounded-lg border border-dashed border-border py-16 text-center">
              <p className="text-sm font-medium text-foreground">
                {activeDomain} isn&apos;t added in this session
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                This prototype keeps nothing between reloads.
              </p>
              <Button
                type="button"
                size="sm"
                className="mt-4"
                onClick={() => go({ kind: "browse" })}
              >
                Browse integrations
              </Button>
            </div>
          ) : (
            <>
              <div className="mb-6 flex items-center justify-between gap-4">
                <div className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
                  {/* oxlint-disable-next-line react/forbid-elements */}
                  <button
                    type="button"
                    onClick={() => go({ kind: "browse" })}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      showingBrowse
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Browse
                  </button>
                  {/* oxlint-disable-next-line react/forbid-elements */}
                  <button
                    type="button"
                    onClick={() => go({ kind: "installed" })}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      showingInstalled
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Installed
                    {added.length > 0 ? (
                      <span className="font-mono text-xs text-muted-foreground">
                        {added.length}
                      </span>
                    ) : null}
                  </button>
                </div>
                {pendingCount > 0 ? (
                  <span className="shrink-0 text-xs font-medium text-amber-500">
                    {pendingCount} need{pendingCount === 1 ? "s" : ""} auth
                  </span>
                ) : null}
              </div>

              {showingInstalled ? (
                <InstalledList
                  items={added}
                  onOpen={(domain) => go({ kind: "detail", domain })}
                  onBrowse={() => go({ kind: "browse" })}
                />
              ) : (
                <BrowsePage
                  addedDomains={added.map((entry) => entry.item.domain)}
                  onAdd={addFromCatalog}
                  onOpen={(item) => {
                    addFromCatalog(item);
                    go({ kind: "detail", domain: item.domain });
                  }}
                  onAddCustom={() => go({ kind: "custom" })}
                />
              )}
            </>
          )}
        </div>
      </div>

      {route.kind === "custom" ? (
        <AddCustomDialog
          open
          onOpenChange={(next) => {
            if (!next) go({ kind: "browse" });
          }}
          onAdd={(integration) => {
            addIntegration(integration);
            go({ kind: "detail", domain: integration.domain });
          }}
        />
      ) : null}

      {route.kind === "auth" && open ? (
        <AuthenticateDialog
          // Keyed per target so the dialog owns its state and a close throws it
          // away, rather than carrying a half-finished attempt to the next one.
          key={open.item.domain}
          open
          onOpenChange={(next) => {
            if (!next) go({ kind: "detail", domain: open.item.domain });
          }}
          integrationName={open.item.name}
          domain={open.item.domain}
          accountLabel={
            open.accounts.find((account) => account.status === "needs-auth")?.label ?? "default"
          }
          onAuthenticated={() => {
            const account =
              open.accounts.find((candidate) => candidate.status === "needs-auth")?.label ??
              "default";
            markConnected(
              open.item.domain,
              account,
              `rhys@${open.item.domain.split(".")[0] ?? open.item.domain}`,
            );
            go({ kind: "detail", domain: open.item.domain });
          }}
        />
      ) : null}
    </Shell>
  );
}
