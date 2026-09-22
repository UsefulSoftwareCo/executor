import { EmptyState } from "./empty-state.tsx";
import type { ComponentType, ReactNode } from "react";
import type { FailureProps, Query } from "../../contracts/dashboard.ts";
import type { ApprovalListItem } from "../../contracts/schedules.ts";
import { QueryView } from "./context.tsx";
import { Button } from "../components/button.tsx";

/** Pending scheduled work uses the same review interaction in local and hosted dashboards. */
export function ApprovalsPage<E>({
  query,
  Failure,
  review,
}: {
  readonly query: Query<readonly ApprovalListItem[], E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly review: (item: ApprovalListItem) => ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-5xl p-4 md:p-6">
      <h1 className="mb-2 text-[22px] font-semibold tracking-tight">Approvals</h1>
      <p className="mb-5 text-sm text-muted-foreground">
        Review scheduled runs before they continue.
      </p>
      <QueryView query={query} Failure={Failure}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title="No approvals waiting">
              Scheduled runs that need your review will appear here.
            </EmptyState>
          ) : (
            <div className="divide-y rounded-lg border">
              {items.map((item) => (
                <div key={item.run.id} className="flex items-center justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium break-words">{item.app.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.run.name}
                      {item.run.expiresAt
                        ? ` · Expires ${item.run.expiresAt.toLocaleTimeString()}`
                        : ""}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" asChild>
                    {review(item)}
                  </Button>
                </div>
              ))}
            </div>
          )
        }
      </QueryView>
    </main>
  );
}
