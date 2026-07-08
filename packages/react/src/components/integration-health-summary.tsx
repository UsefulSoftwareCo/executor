import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { isToolsSyncStale, type Connection, type IntegrationSlug } from "@executor-js/sdk/shared";

import { connectionsForIntegrationAtom } from "../api/atoms";
import {
  HEALTH_INDICATOR_COLOR,
  HEALTH_STATUS_LABEL,
  HEALTH_TEXT_CLASS,
  worstHealthStatus,
} from "../lib/health-display";
import { useConnectionsHealth } from "../lib/use-connection-health";

// ---------------------------------------------------------------------------
// Integration health summary: the at-a-glance verdict on an integrations-list
// row. Reads the integration's connections across BOTH owners, revalidates
// each one stale-while-revalidate (the same automatic check the detail page
// runs), and collapses them to the worst status: one dot per row, however
// many connections back it.
//
// The verdict is CREDENTIAL health only. Catalog-sync trouble (tool listing
// failing) is a different, lesser signal: it renders as a muted "SYNC" tag,
// never as the amber/red health treatment, and only after several consecutive
// failures (see isToolsSyncStale) so a single transient blip shows nothing.
//
// Display only: the row is a Link, so this must never introduce a nested
// interactive element. No connections, or nothing but never-probed ones,
// renders nothing at all: a gray dot on every row would be pure noise.
// ---------------------------------------------------------------------------

export function IntegrationHealthSummary(props: { readonly integration: IntegrationSlug }) {
  const { integration } = props;
  const org = useAtomValue(connectionsForIntegrationAtom({ integration, owner: "org" }));
  const user = useAtomValue(connectionsForIntegrationAtom({ integration, owner: "user" }));

  const connections = useMemo<readonly Connection[]>(
    () => [
      ...(AsyncResult.isSuccess(org) ? org.value : []),
      ...(AsyncResult.isSuccess(user) ? user.value : []),
    ],
    [org, user],
  );

  const probeFor = useConnectionsHealth(connections);

  const status = worstHealthStatus(
    connections.map((connection) => probeFor(connection)?.status ?? "unknown"),
  );
  const syncStale = connections.find((connection) => isToolsSyncStale(connection.toolsSyncError));
  // No connections, or no signal of either kind: render nothing at all.
  if (status === null && syncStale === undefined) return null;

  const label = status === null ? null : HEALTH_STATUS_LABEL[status];
  return (
    <span
      className="flex shrink-0 items-center gap-1.5"
      title={label === null ? undefined : `Status: ${label}`}
    >
      {syncStale !== undefined ? (
        <span
          className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
          title={`Tool list may be out of date: ${syncStale.toolsSyncError?.reason ?? "sync failing"}`}
        >
          Sync
        </span>
      ) : null}
      {status !== null && status !== "healthy" ? (
        <span
          className={`font-mono text-[11px] font-medium uppercase tracking-[0.08em] ${HEALTH_TEXT_CLASS[status]}`}
        >
          {label}
        </span>
      ) : null}
      {status !== null ? (
        <span
          aria-label={`Status: ${label}`}
          className={`size-2 rounded-full ${HEALTH_INDICATOR_COLOR[status].dot}`}
        />
      ) : null}
    </span>
  );
}
