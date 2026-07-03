import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type { Connection, IntegrationSlug } from "@executor-js/sdk/shared";

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
  // No connections, or none has ever produced a verdict: no signal, no dot.
  if (status === null) return null;

  const label = HEALTH_STATUS_LABEL[status];
  return (
    <span className="flex shrink-0 items-center gap-1.5" title={`Status: ${label}`}>
      {status !== "healthy" ? (
        <span
          className={`font-mono text-[11px] font-medium uppercase tracking-[0.08em] ${HEALTH_TEXT_CLASS[status]}`}
        >
          {label}
        </span>
      ) : null}
      <span
        aria-label={`Status: ${label}`}
        className={`size-2 rounded-full ${HEALTH_INDICATOR_COLOR[status].dot}`}
      />
    </span>
  );
}
