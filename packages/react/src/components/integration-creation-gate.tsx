import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";

import { orgMembersAtom } from "../api/account-atoms";
import { isAsyncResultLoading } from "../lib/async-result";
import { useCanCreateWorkspaceConnections } from "../multiplayer/use-admin-nav";
import { Button } from "./button";
import { PageContainer, PageHeader } from "./page";
import { Skeleton } from "./skeleton";

/** Keep integration creation flows behind the same role gate as edit and delete. */
export function IntegrationCreationGate({ children }: { readonly children: ReactNode }) {
  const canCreate = useCanCreateWorkspaceConnections();
  const members = useAtomValue(orgMembersAtom);
  if (canCreate) return children;
  if (isAsyncResultLoading(members)) {
    return (
      <PageContainer>
        <Skeleton className="h-8 w-64" />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="An admin must add integrations"
        description="Ask a workspace admin to add the integration. You can add personal connections to existing integrations."
      />
      <Button asChild variant="outline">
        <Link to="/{-$orgSlug}">Back to integrations</Link>
      </Button>
    </PageContainer>
  );
}
