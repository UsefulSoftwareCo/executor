// The reworked flow, wired end to end: browse → add (in place) → the added
// integration → authenticate. Adding never blocks and never navigates; the only
// thing that moves you off the picker is choosing to look at something.

import { useCallback, useState } from "react";
import { Shell } from "./shell";
import { BrowsePage } from "./screens/next/browse";
import { NextIntegrationDetail, type DemoAccount } from "./screens/next/integration-detail";
import { AuthenticateDialog } from "./screens/next/authenticate";
import type { CatalogItem } from "./catalog";
import type { DemoIntegration } from "./fixtures";

interface Added {
  readonly item: CatalogItem;
  readonly accounts: readonly DemoAccount[];
}

const asSidebarIntegration = (added: Added): DemoIntegration => ({
  slug: added.item.domain,
  name: added.item.name,
  kind: "openapi",
  icon: added.item.icon,
  toolCount: added.accounts.some((account) => account.status === "connected") ? 24 : 0,
});

export function NextFlow() {
  const [added, setAdded] = useState<readonly Added[]>([]);
  const [openDomain, setOpenDomain] = useState<string | null>(null);
  const [authFor, setAuthFor] = useState<{
    readonly domain: string;
    readonly account: string;
  } | null>(null);

  const addItem = useCallback((item: CatalogItem) => {
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

  const open = added.find((entry) => entry.item.domain === openDomain) ?? null;
  const authTarget = added.find((entry) => entry.item.domain === authFor?.domain) ?? null;

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

  return (
    <Shell integrations={added.map(asSidebarIntegration)}>
      {open ? (
        <NextIntegrationDetail
          item={open.item}
          accounts={open.accounts}
          toolCount={open.accounts.some((account) => account.status === "connected") ? 24 : 0}
          onBack={() => setOpenDomain(null)}
          onAuthenticate={(accountLabel) =>
            setAuthFor({ domain: open.item.domain, account: accountLabel })
          }
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
            setOpenDomain(null);
          }}
        />
      ) : (
        <BrowsePage
          addedDomains={added.map((entry) => entry.item.domain)}
          onAdd={addItem}
          onOpen={(item) => {
            addItem(item);
            setOpenDomain(item.domain);
          }}
        />
      )}

      {authTarget && authFor ? (
        <AuthenticateDialog
          // Keyed per target so the dialog owns its state and a close throws it
          // away, rather than carrying a half-finished attempt to the next one.
          key={`${authFor.domain}:${authFor.account}`}
          open
          onOpenChange={(next) => {
            if (!next) setAuthFor(null);
          }}
          integrationName={authTarget.item.name}
          domain={authTarget.item.domain}
          accountLabel={authFor.account}
          onAuthenticated={() => {
            markConnected(
              authFor.domain,
              authFor.account,
              `rhys@${authTarget.item.domain.split(".")[0]}`,
            );
            setAuthFor(null);
            setOpenDomain(authFor.domain);
          }}
        />
      ) : null}
    </Shell>
  );
}
