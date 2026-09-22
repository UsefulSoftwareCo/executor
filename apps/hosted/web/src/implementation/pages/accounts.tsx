import { useState } from "react";
import { Option } from "effect";
import { AccountsPage as SharedPage } from "@executor-js/ui/dashboard/accounts";
import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
import { Button } from "@executor-js/ui/components/button";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@executor-js/ui/dashboard/context";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor-js/ui/components/select";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";
import { resourceDirectoryAtom, resourceInventoryAtom } from "../../contracts/resource-access.ts";
/** Personal and shared credentials use one list; management remains a separate explicit mode. */
export function AccountsPage() {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const [view, setView] = useState<"available" | "managed">("available");
  const directory = useQuery(resourceDirectoryAtom(organization, view));
  return (
    <SharedPage
      query={resourceInventoryAtom(organization, view)}
      Failure={HostedFailure}
      empty={
        <EmptyState
          title={view === "managed" ? "No accounts to manage" : "No accounts available"}
          action={
            view === "managed" ? (
              <Button variant="outline" onClick={() => setView("available")}>
                View available accounts
              </Button>
            ) : (
              <Button asChild>
                <Link to="/org/$organizationSlug/apps" params={{ organizationSlug }}>
                  Choose an app
                </Link>
              </Button>
            )
          }
        >
          {view === "managed"
            ? "Accounts you can manage will appear here."
            : "Open an app to connect an account, or ask a teammate to share one."}
        </EmptyState>
      }
      filters={
        <Select
          value={view}
          onValueChange={(value) => {
            if (value === "available" || value === "managed") setView(value);
          }}
        >
          <SelectTrigger aria-label="Account list">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="available">Available to me</SelectItem>
            <SelectItem value="managed">Manage accounts</SelectItem>
          </SelectContent>
        </Select>
      }
      accountMeta={(account) => {
        const access = Option.isSome(directory.data)
          ? directory.data.value.accounts.find((item) => item.account.id === account.id)?.access
          : undefined;
        return (
          access && (
            <span className="rounded border px-1.5 py-0.5 text-[10px]">
              {access.ownership.kind === "personal" ? "Personal" : "Shared"}
            </span>
          )
        );
      }}
    />
  );
}
