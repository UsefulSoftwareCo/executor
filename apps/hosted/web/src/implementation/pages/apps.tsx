import { useMemo } from "react";
import { useAtom } from "@effect/atom-react";
import { Option } from "effect";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { AppsPage as SharedPage } from "@executor-js/ui/dashboard/apps";
import { Button } from "@executor-js/ui/components/button";
import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
import { Popover, PopoverContent, PopoverTrigger } from "@executor-js/ui/components/popover";
import { HugeiconsIcon } from "@hugeicons/react";
import { FilterHorizontalIcon } from "@hugeicons/core-free-icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor-js/ui/components/select";
import { useQuery } from "@executor-js/ui/dashboard/context";
import { Link } from "@tanstack/react-router";
import { useOrganizationRoute } from "../components/organization.tsx";
import { createAppListAtoms } from "../../contracts/resource-access.ts";
import { groupsAtom } from "../../contracts/groups.ts";
/** One authorized list, with independent group and explicit management filters. */
export function AppsPage() {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const atoms = useMemo(() => createAppListAtoms(organization), [organization]);
  const [{ view, group }, setFilters] = useAtom(atoms.filters);
  const groups = useQuery(groupsAtom(organization));
  const activeFilters = Number(group !== "all") + Number(view !== "available");
  return (
    <SharedPage
      query={atoms.query}
      Failure={HostedFailure}
      empty={
        <EmptyState
          title={
            group !== "all" || view === "managed"
              ? "No apps match these filters"
              : "No apps available"
          }
          action={
            group !== "all" || view === "managed" ? (
              <Button
                variant="outline"
                onClick={() => {
                  setFilters({ group: "all", view: "available" });
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Button asChild>
                <Link to="/org/$organizationSlug/apps/add" params={{ organizationSlug }}>
                  Add app
                </Link>
              </Button>
            )
          }
        >
          {group !== "all" || view === "managed"
            ? "Choose another view to see your apps."
            : "Add an app or ask a teammate to share one with you."}
        </EmptyState>
      }
      action={
        <Button asChild>
          <Link to="/org/$organizationSlug/apps/add" params={{ organizationSlug }}>
            Add app
          </Link>
        </Button>
      }
      filters={
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="w-full">
              <HugeiconsIcon icon={FilterHorizontalIcon} size={16} aria-hidden />
              Filters
              {activeFilters > 0 && (
                <span className="flex size-5 items-center justify-center rounded-full bg-secondary text-xs text-secondary-foreground">
                  {activeFilters}
                  <span className="sr-only"> active</span>
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent aria-label="App filters" className="w-72 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium">Filters</h2>
              {activeFilters > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFilters({ group: "all", view: "available" });
                  }}
                >
                  Reset
                </Button>
              )}
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Group</p>
              <Select
                value={group}
                onValueChange={(group) => setFilters((current) => ({ ...current, group }))}
              >
                <SelectTrigger aria-label="Filter apps by group" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All apps</SelectItem>
                  <SelectItem value="private">Private apps</SelectItem>
                  {Option.isSome(groups.data) &&
                    groups.data.value.groups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Access</p>
              <Select
                value={view}
                onValueChange={(value) => {
                  if (value === "available" || value === "managed")
                    setFilters((current) => ({ ...current, view: value }));
                }}
              >
                <SelectTrigger aria-label="App list" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="available">Available to me</SelectItem>
                  <SelectItem value="managed">Manage apps</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </PopoverContent>
        </Popover>
      }
    />
  );
}
