import { useState } from "react";
import { Option } from "effect";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { AppsPage as SharedPage } from "@executor-js/ui/dashboard/apps";
import { Button } from "@executor-js/ui/components/button";
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
import { resourceInventoryAtom } from "../../contracts/resource-access.ts";
import { groupsAtom } from "../../contracts/groups.ts";
/** One authorized list, with independent group and explicit management filters. */
export function AppsPage() {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const [view, setView] = useState<"available" | "managed">("available");
  const [group, setGroup] = useState("all");
  const groups = useQuery(groupsAtom(organization));
  return (
    <SharedPage
      query={resourceInventoryAtom(organization, view, group)}
      Failure={HostedFailure}
      action={
        <Button asChild>
          <Link to="/org/$organizationSlug/apps/add" params={{ organizationSlug }}>
            Add app
          </Link>
        </Button>
      }
      filters={
        <>
          <Select value={group} onValueChange={setGroup}>
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
          <Select
            value={view}
            onValueChange={(value) => {
              if (value === "available" || value === "managed") setView(value);
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
        </>
      }
    />
  );
}
