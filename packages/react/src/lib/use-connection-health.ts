// Shared stale-while-revalidate health probing for connections. Two surfaces
// render a connection's health (the detail page's AccountRow and the
// integrations-list summary), and both must revalidate the same way: render
// the persisted `lastHealth` verdict instantly, then probe in the background
// unless the verdict is healthy and fresh. Keeping the guard, the `ifStaleMs`
// semantics, and the freshness window here means the two surfaces cannot
// drift apart.

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

/** Freshness window for a NON-healthy verdict. Short, because an expired dot is
 *  exactly the verdict the user is waiting to see change — but non-zero,
 *  because a broken connection is the one every surface wants to re-probe and
 *  every probe is another request to an upstream that is already refusing.
 *  Sending this lets the server-side gate collapse repeated mounts and
 *  concurrent tabs into one probe per window. */
export const HEALTH_REVALIDATE_UNHEALTHY_MS = 30 * 1000;

const connectionParams = (connection: Connection) => ({
  owner: connection.owner,
  integration: connection.integration,
  name: connection.name,
});

/** Whether a persisted verdict may render as-is without asking at all.
 *  Healthy-and-fresh renders untouched. Everything else asks: stale or
 *  never-checked for obvious reasons, and NON-healthy always; an expired dot
 *  is exactly the verdict the user is waiting to see change, so recovery must
 *  show on the next load, not after the long window. Asking is not the same as
 *  probing — the request carries a short `ifStaleMs` (see revalidateQuery), so
 *  the server answers from the persisted verdict unless it has gone stale. */
const healthyAndFresh = (last: HealthCheckResult | null | undefined): boolean =>
  last?.status === "healthy" && Date.now() - last.checkedAt < HEALTH_REVALIDATE_MS;

/** The revalidation query. ALWAYS defers to the server-enforced freshness
 *  window, only the width changes: long for a healthy verdict, short for
 *  anything else. Omitting it for non-healthy verdicts (as this once did)
 *  bypassed the gate for precisely the connections that were failing — the
 *  once-per-mount client guard is per MOUNT, not per verdict, so two surfaces
 *  rendering the same broken connection each sent their own probe, and each
 *  probe was another refused token request and another captured server error.
 *  Manual "Check now" is the only unconditional probe, and it passes `{}`. */
export const revalidateQuery = (
  last: HealthCheckResult | null | undefined,
): { readonly ifStaleMs: number } => ({
  ifStaleMs: last?.status === "healthy" ? HEALTH_REVALIDATE_MS : HEALTH_REVALIDATE_UNHEALTHY_MS,
});

/** Identity of a persisted verdict, for detecting the reconnect transition.
 *  An OAuth re-mint clears `last_health`, so a verdict giving way to `null`
 *  means the grant was replaced and the row must re-probe even though it never
 *  remounts (its React key is owner:integration:name, unchanged by a
 *  reconnect). This CLEARING transition is the only re-trigger: reacting to
 *  every epoch change instead would race probes against cache refetches
 *  (a refetch can deliver a snapshot older than a just-adopted verdict) and
 *  storm upstreams with re-probes. `null` is a real epoch — never-checked or
 *  just-re-minted — distinct from the "never seen" sentinel `undefined`. */
const verdictEpoch = (last: HealthCheckResult | null | undefined): number | null =>
  last?.checkedAt ?? null;

/** The verdict to display: whichever of the live probe and the persisted
 *  verdict is FRESHEST. A plain live-over-persisted preference would let a
 *  pre-reconnect probe shadow the verdict a completed reconnect persisted
 *  (any surface may write a newer verdict server-side; this hook only learns
 *  of it through the refetched row). Ties keep the live result: identical
 *  timestamps mean it IS the persisted verdict, echoed back. */
const freshestVerdict = (
  live: HealthCheckResult | null,
  persisted: HealthCheckResult | null | undefined,
): HealthCheckResult | null => {
  if (live === null) return persisted ?? null;
  if (persisted == null) return live;
  return persisted.checkedAt > live.checkedAt ? persisted : live;
};

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
  // A live probe result, once a check has run; merged with the persisted
  // verdict by freshness (see freshestVerdict for why not live-always-wins).
  const [liveProbe, setLiveProbe] = useState<HealthCheckResult | null>(null);
  const doCheck = useAtomSet(checkConnectionHealth, { mode: "promiseExit" });
  const invalidateConnections = useInvalidateConnections();

  const probe = freshestVerdict(liveProbe, connection.lastHealth);
  const status: HealthStatus = probe?.status ?? "unknown";

  // Health checks are AUTOMATIC: loading the list revalidates any verdict
  // older than the freshness window (or never checked), stale-while-revalidate
  // style: the persisted verdict renders instantly, the probe corrects it in
  // place. The guard is once per mount PLUS once per clearing: the ref holds
  // the last epoch seen, and a verdict giving way to `null` (an OAuth re-mint
  // cleared it) re-arms the probe — that is how a completed reconnect gets its
  // recovery probe without a page reload. Only the clearing transition
  // re-arms; every other epoch change (a probe's own verdict echoed back by
  // the refetch, a concurrent surface's fresher verdict) stays quiet, keeping
  // the no-probe-storm invariant of the original once-per-mount guard.
  const seenEpoch = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const last = connection.lastHealth;
    const epoch = verdictEpoch(last);
    const firstSight = seenEpoch.current === undefined;
    const cleared = epoch === null && seenEpoch.current !== null && !firstSight;
    seenEpoch.current = epoch;
    if (!firstSight && !cleared) return;
    if (healthyAndFresh(last)) return;
    void doCheck({
      params: connectionParams(connection),
      query: revalidateQuery(last),
    }).then((exit) => {
      // Background refresh: update the dot on success, stay quiet on failure
      // (the persisted verdict is still the best known state). Invalidate the
      // connections cache ONLY when the verdict actually changed: on the
      // common no-change reconfirm we skip it, so an automatic probe never
      // churns the cache (which would refetch connections, re-run this
      // effect, and, but for the epoch guard, risk a probe loop).
      if (!Exit.isSuccess(exit)) return;
      seenEpoch.current = exit.value.checkedAt;
      setLiveProbe(exit.value);
      if (exit.value.status !== (last?.status ?? "unknown")) {
        invalidateConnections(connection.owner);
      }
    });
  }, [connection, doCheck, invalidateConnections]);

  const runCheck = useCallback(async () => {
    // Manual "Check now": invalidate the connections cache unconditionally so
    // every surface picks up the freshly persisted verdict. Adopting the
    // result's epoch keeps the resulting refetch from re-probing.
    const exit = await doCheck({
      params: connectionParams(connection),
      query: {},
      reactivityKeys: connectionCheckKeys,
    });
    if (Exit.isSuccess(exit)) {
      seenEpoch.current = exit.value.checkedAt;
      setLiveProbe(exit.value);
    }
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

  // Once per VERDICT per connection (same epoch guard as the single-connection
  // hook): the list streams in asynchronously, so the effect re-runs as rows
  // arrive; each row probes once per persisted-verdict epoch, and a re-minted
  // connection (epoch cleared to null) probes again without a remount.
  const revalidated = useRef(new Map<string, number | null>());
  useEffect(() => {
    for (const connection of connections) {
      const key = probeKey(connection);
      const last = connection.lastHealth;
      const epoch = verdictEpoch(last);
      if (revalidated.current.has(key) && revalidated.current.get(key) === epoch) continue;
      revalidated.current.set(key, epoch);
      if (healthyAndFresh(last)) continue;
      void doCheck({
        params: connectionParams(connection),
        query: revalidateQuery(last),
      }).then((exit) => {
        // Same automatic-path rule as the single-connection hook: reflect the
        // verdict, adopt its epoch so the refetch doesn't re-probe, and
        // invalidate the connections cache only when the verdict changed so an
        // unchanged reconfirm never churns the cache.
        if (!Exit.isSuccess(exit)) return;
        revalidated.current.set(key, exit.value.checkedAt);
        setLiveProbes((current) => new Map(current).set(key, exit.value));
        if (exit.value.status !== (last?.status ?? "unknown")) {
          invalidateConnections(connection.owner);
        }
      });
    }
  }, [connections, doCheck, invalidateConnections]);

  return useCallback(
    (connection: Connection) =>
      freshestVerdict(liveProbes.get(probeKey(connection)) ?? null, connection.lastHealth),
    [liveProbes],
  );
}
