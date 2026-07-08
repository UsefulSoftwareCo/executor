// Shared stale-while-revalidate health probing for connections. Two surfaces
// render a connection's health (the detail page's AccountRow and the
// integrations-list summary), and both must revalidate the same way: render
// the persisted `lastHealth` verdict instantly, then probe in the background
// unless the verdict is steady (healthy/unknown) and fresh. Keeping the guard,
// the `ifStaleMs` semantics, and the freshness window here means the two
// surfaces cannot drift apart.

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { RegistryContext, useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import type { Connection, HealthCheckResult, HealthStatus, Owner } from "@executor-js/sdk/shared";

import { checkConnectionHealth, connectionsOptimisticAtom } from "../api/atoms";
import { connectionCheckKeys } from "../api/reactivity-keys";

/** Freshness window for automatic revalidation: a HEALTHY verdict younger
 *  than this renders as-is; anything else (stale, missing, or non-healthy)
 *  triggers a background probe on mount. Server-enforced for the healthy
 *  path too, so concurrent tabs collapse to one probe. */
export const HEALTH_REVALIDATE_MS = 5 * 60 * 1000;

const connectionParams = (connection: Connection) => ({
  owner: connection.owner,
  integration: connection.integration,
  name: connection.name,
});

/** Statuses that may render as-is when fresh, without a background probe.
 *  `healthy` for the obvious reason; `unknown` because it means "no health
 *  check configured / not supported" — re-probing it on every page load just
 *  rewrites the same verdict (row churn, no signal). Expired/degraded always
 *  revalidate: a bad dot is exactly the verdict the user is waiting to see
 *  change, so recovery must show on the next load, not after the window. */
const STEADY_STATUSES: ReadonlySet<HealthStatus> = new Set(["healthy", "unknown"]);

const steadyAndFresh = (last: HealthCheckResult | null | undefined): boolean =>
  last != null &&
  STEADY_STATUSES.has(last.status) &&
  Date.now() - last.checkedAt < HEALTH_REVALIDATE_MS;

/** The revalidation query: a steady (but stale) verdict defers to the
 *  server-enforced window so N open tabs can't stampede the upstream; a
 *  missing or non-steady verdict forces a fresh probe. */
const revalidateQuery = (
  last: HealthCheckResult | null | undefined,
): { readonly ifStaleMs?: number } =>
  last != null && STEADY_STATUSES.has(last.status) ? { ifStaleMs: HEALTH_REVALIDATE_MS } : {};

/**
 * Imperative invalidation of the connections cache for one owner. The server
 * persists every verdict on `last_health`, so after a check we must re-read the
 * connection rows or a later render within the atom TTL serves the pre-check
 * state. Returns a stable callback usable from a probe's `.then` for any owner
 * (the loop surface probes across both owners), refreshing the optimistic atom
 * every connections view derives from.
 */
function useInvalidateConnections(): (owner: Owner) => void {
  const registry = useContext(RegistryContext);
  return useCallback(
    (owner: Owner) => registry.refresh(connectionsOptimisticAtom(owner)),
    [registry],
  );
}

/**
 * Health for ONE connection, stale-while-revalidate. The persisted verdict
 * renders instantly; a background probe on mount corrects it in place (once
 * per mount, quiet on failure: the persisted verdict is still the best known
 * state). `runCheck` is the manual path ("Check now"): it always forces a
 * fresh probe and folds the result into the same live state.
 */
export function useConnectionHealth(connection: Connection): {
  readonly probe: HealthCheckResult | null;
  readonly status: HealthStatus;
  readonly runCheck: () => Promise<Exit.Exit<HealthCheckResult, unknown>>;
} {
  // A live probe result, once a check has run, overrides the persisted one.
  const [liveProbe, setLiveProbe] = useState<HealthCheckResult | null>(null);
  const doCheck = useAtomSet(checkConnectionHealth, { mode: "promiseExit" });
  const invalidateConnections = useInvalidateConnections();

  const probe = liveProbe ?? connection.lastHealth ?? null;
  const status: HealthStatus = probe?.status ?? "unknown";

  // Health checks are AUTOMATIC: loading the list revalidates any verdict
  // older than the freshness window (or never checked), stale-while-revalidate
  // style: the persisted verdict renders instantly, the probe corrects it in
  // place.
  const revalidated = useRef(false);
  useEffect(() => {
    if (revalidated.current) return;
    const last = connection.lastHealth;
    if (steadyAndFresh(last)) return;
    revalidated.current = true;
    void doCheck({
      params: connectionParams(connection),
      query: revalidateQuery(last),
    }).then((exit) => {
      // Background refresh: update the dot on success, stay quiet on failure
      // (the persisted verdict is still the best known state). Invalidate the
      // connections cache ONLY when the verdict actually changed: on the common
      // no-change reconfirm we skip it, so an automatic probe never churns the
      // cache (which would refetch connections, re-run this effect, and, but
      // for the once-per-mount ref guard, risk a probe loop).
      if (!Exit.isSuccess(exit)) return;
      setLiveProbe(exit.value);
      if (exit.value.status !== (last?.status ?? "unknown")) {
        invalidateConnections(connection.owner);
      }
    });
  }, [connection, doCheck, invalidateConnections]);

  const runCheck = useCallback(async () => {
    // Manual "Check now": invalidate the connections cache unconditionally so
    // every surface picks up the freshly persisted verdict. Re-running this
    // effect after the refetch is harmless: the ref guard blocks a re-probe.
    const exit = await doCheck({
      params: connectionParams(connection),
      query: {},
      reactivityKeys: connectionCheckKeys,
    });
    if (Exit.isSuccess(exit)) setLiveProbe(exit.value);
    return exit;
  }, [connection, doCheck]);

  return { probe, status, runCheck };
}

const probeKey = (connection: Connection): string =>
  `${connection.owner}:${connection.integration}:${connection.name}`;

/**
 * Health for MANY connections at once (the integrations-list summary), where
 * hooks-in-a-loop is illegal. One effect walks the list and fires the same
 * guarded per-connection revalidation as `useConnectionHealth`, accumulating
 * live probes in a map keyed by `owner:integration:name`. The returned reader
 * resolves a connection's best-known probe: the live result when a check has
 * run, otherwise the persisted verdict.
 */
export function useConnectionsHealth(
  connections: readonly Connection[],
): (connection: Connection) => HealthCheckResult | null {
  const [liveProbes, setLiveProbes] = useState<ReadonlyMap<string, HealthCheckResult>>(new Map());
  const doCheck = useAtomSet(checkConnectionHealth, { mode: "promiseExit" });
  const invalidateConnections = useInvalidateConnections();

  // Once per mount PER CONNECTION: the list streams in asynchronously, so the
  // effect re-runs as rows arrive; the key set keeps each row to one probe.
  const revalidated = useRef(new Set<string>());
  useEffect(() => {
    for (const connection of connections) {
      const key = probeKey(connection);
      if (revalidated.current.has(key)) continue;
      const last = connection.lastHealth;
      if (steadyAndFresh(last)) continue;
      revalidated.current.add(key);
      void doCheck({
        params: connectionParams(connection),
        query: revalidateQuery(last),
      }).then((exit) => {
        // Same automatic-path rule as the single-connection hook: reflect the
        // verdict, and invalidate the connections cache only when it changed so
        // an unchanged reconfirm never churns the cache (the per-key ref guard
        // already prevents a re-probe on the resulting re-render).
        if (!Exit.isSuccess(exit)) return;
        setLiveProbes((current) => new Map(current).set(key, exit.value));
        if (exit.value.status !== (last?.status ?? "unknown")) {
          invalidateConnections(connection.owner);
        }
      });
    }
  }, [connections, doCheck, invalidateConnections]);

  return useCallback(
    (connection: Connection) =>
      liveProbes.get(probeKey(connection)) ?? connection.lastHealth ?? null,
    [liveProbes],
  );
}
