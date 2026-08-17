import { useState } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { TOOL_CALLS_PAGE_SIZE, toolCallsPageAtom } from "../api/atoms";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/empty";
import { ErrorState } from "../components/error-state";
import { PageContainer, PageHeader } from "../components/page";
import { Skeleton } from "../components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/table";
import { pageNumber, splitPage } from "../lib/admin-users-display";
import { useExecutorDocumentTitle } from "../lib/document-title";

// ---------------------------------------------------------------------------
// Activity — the tool call log.
//
// One row per call that reached the executor, newest first. The rows that make
// this page worth opening are the ones with no other trace: a call a policy
// blocked, and an approval someone declined. Both end before any request is
// made, so nothing upstream ever saw them.
// ---------------------------------------------------------------------------

type ToolCallRow = {
  readonly id: string;
  readonly address: string;
  readonly integration: string | null;
  readonly tool: string | null;
  readonly outcome: "ok" | "fail" | "blocked" | "declined" | "error";
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly policyAction: string | null;
  readonly durationMs: number;
  readonly createdAt: number;
};

const OUTCOME_VARIANT = {
  ok: "secondary",
  fail: "destructive",
  blocked: "destructive",
  declined: "outline",
  error: "destructive",
} as const;

const OUTCOME_LABEL = {
  ok: "ok",
  fail: "failed",
  blocked: "blocked",
  declined: "declined",
  error: "error",
} as const;

const formatDuration = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

const formatWhen = (epochMs: number): string =>
  new Date(epochMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** The upstream code says more than the message; fall back to the message. */
const detailOf = (call: ToolCallRow): string | null => call.errorCode ?? call.errorMessage ?? null;

export function ActivityPage() {
  useExecutorDocumentTitle("Activity");
  const [offset, setOffset] = useState(0);
  const calls = useAtomValue(toolCallsPageAtom(offset));
  const refresh = useAtomRefresh(toolCallsPageAtom(offset));

  return (
    <PageContainer>
      <PageHeader
        title="Activity"
        description="Every tool call that reached the executor, newest first — including the ones a policy blocked and the approvals that were declined."
        actions={
          <Button variant="outline" size="sm" onClick={refresh}>
            Refresh
          </Button>
        }
      />
      {AsyncResult.match(calls, {
        onInitial: () => <Skeleton className="h-64 w-full" />,
        onFailure: () => (
          <ErrorState message="Could not load the activity log." onRetry={refresh} />
        ),
        onSuccess: (success) => {
          // One row past the page size answers "is there a next page" without
          // a count query — same trick as Admin · Users.
          const { rows, hasNext } = splitPage(
            success.value as readonly ToolCallRow[],
            TOOL_CALLS_PAGE_SIZE,
          );
          return (
            <>
              <ActivityTable calls={rows} onFirstPage={offset === 0} />
              {(hasNext || offset > 0) && (
                <div className="mt-4 flex items-center justify-between">
                  <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    Page {pageNumber(offset, TOOL_CALLS_PAGE_SIZE)}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={offset === 0}
                      onClick={() => setOffset(Math.max(0, offset - TOOL_CALLS_PAGE_SIZE))}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!hasNext}
                      onClick={() => setOffset(offset + TOOL_CALLS_PAGE_SIZE)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          );
        },
      })}
    </PageContainer>
  );
}

function ActivityTable({
  calls,
  onFirstPage,
}: {
  readonly calls: readonly ToolCallRow[];
  readonly onFirstPage: boolean;
}) {
  if (calls.length === 0) {
    // Past the end only happens when the last row of a page is pruned while
    // browsing; the pager above still offers Previous to walk back.
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{onFirstPage ? "No calls yet" : "No calls on this page"}</EmptyTitle>
          <EmptyDescription>
            {onFirstPage
              ? "Once an agent runs a tool through this executor, every call shows up here."
              : "Go back a page to see recorded calls."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Tool</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead>Detail</TableHead>
          <TableHead className="text-right">Duration</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {calls.map((call) => (
          <TableRow key={call.id}>
            <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
              {formatWhen(call.createdAt)}
            </TableCell>
            <TableCell>
              <span className="font-medium">{call.tool ?? call.address}</span>
              {call.integration ? (
                <span className="ml-2 text-muted-foreground">{call.integration}</span>
              ) : null}
            </TableCell>
            <TableCell>
              <Badge variant={OUTCOME_VARIANT[call.outcome]}>{OUTCOME_LABEL[call.outcome]}</Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {detailOf(call) ?? (call.policyAction ? `policy: ${call.policyAction}` : "—")}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatDuration(call.durationMs)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
