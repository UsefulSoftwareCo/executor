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

const connectionParams = (connection: Connection) => ({
  owner: connection.owner,
  integration: connection.integration,
  name: connection.name,
});

const probeKey = (connection: Connection): string =>
  `${connection.owner}:${connection.integration}:${connection.name}`;

/** Whether a persisted verdict may render as-is without a background probe.
 *  Healthy-and-fresh renders untouched. Everything else revalidates: stale or
 *  never-checked for obvious reasons, and NON-healthy always; an expired dot
 *  is exactly the verdict the user is waiting to see change, so recovery must
 *  show on the next load, not after the freshness window. */
const healthyAndFresh = (
  last: HealthCheckResult | null | undefined,
  now: number = Date.now(),
): boolean => last?.status === "healthy" && now - last.checkedAt < HEALTH_REVALIDATE_MS;

/** The revalidation query: a healthy (but stale) verdict defers to the
 *  server-enforced window so N open tabs can't stampede the upstream; a
 *  missing or non-healthy verdict forces a fresh probe.
 *
 *  A non-healthy verdict deliberately sends NO window. Suppressing its probe
 *  would suppress the only thing that can discover recovery: the verdict is
 *  persisted, so a gated request would answer "still expired" from the row
 *  the previous probe wrote, and the dot could not turn green until the window
 *  elapsed. Recovery visibility is the contract these surfaces are built on
 *  (see the health-checks-ui, graphql-introspection-health and
 *  mcp-oauth-reconnect-health scenarios), so the upstream cost of re-probing a
 *  broken connection is paid on purpose. What must NOT happen — one broken
 *  connection raising a server error on every probe — is fixed where it
 *  belongs, in the server folding a credential-resolution failure into a
 *  persisted verdict rather than into the failure channel. */
export const revalidateQuery = (
  last: HealthCheckResult | null | undefined,
): { readonly ifStaleMs?: number } =>
  last?.status === "healthy" ? { ifStaleMs: HEALTH_REVALIDATE_MS } : {};

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

/** Module-scope memory of automatic probes, keyed by `probeKey`. Unlike the
 *  per-hook `useRef` guards below (which reset whenever a row remounts), this
 *  map survives remounts: it is what stops an org-wide reactivity bump from
 *  remounting a row and re-arming its probe every time. `at` is recorded from
 *  the LOCAL wall clock, never `result.checkedAt` — the server may answer
 *  from its 5-minute cache with an old `checkedAt`, which would under-count
 *  elapsed time and defeat the floor below. */
const automaticProbeMemory = new Map<
  string,
  { readonly at: number; readonly result: HealthCheckResult }
>();

/** How long a remembered automatic probe blocks another automatic probe for
 *  the same connection, regardless of verdict. A non-healthy verdict must
 *  still eventually re-probe so recovery can show (see `revalidateQuery`),
 *  but "eventually" must not mean "every remount": this floor is what turns a
 *  per-second remount storm into at most one probe per floor, for healthy and
 *  non-healthy verdicts alike. */
export const AUTO_PROBE_FLOOR_MS = 30 * 1000;

/**
 * Whether an automatic probe should fire for `key` right now, given the
 * persisted verdict. Consults the module memory together with `persisted`:
 *  - if the freshest of the two (see `freshestVerdict`) is healthy-and-fresh,
 *    never probe — the existing freshness contract.
 *  - otherwise, a remembered probe younger than `AUTO_PROBE_FLOOR_MS` blocks
 *    another probe no matter its verdict — the anti-storm floor.
 *  - otherwise (no memory yet, or memory older than the floor) probe.
 * Pure with respect to its arguments and `now`; the only state it reads is
 * the shared module memory, which only `recordAutomaticProbe` and
 * `clearAutomaticProbeMemory` mutate.
 */
export function shouldAutoProbe(
  key: string,
  persisted: HealthCheckResult | null | undefined,
  now: number = Date.now(),
): boolean {
  const remembered = automaticProbeMemory.get(key);
  const freshest = freshestVerdict(remembered?.result ?? null, persisted);
  if (healthyAndFresh(freshest, now)) return false;
  if (remembered !== undefined && now - remembered.at < AUTO_PROBE_FLOOR_MS) return false;
  return true;
}

/** Records a successful probe — automatic or manual — into the module
 *  memory, so a later remount or automatic pass can see it. See
 *  `automaticProbeMemory` for why `at` is the local clock, not the server's
 *  `checkedAt`. Exported (not test-only) so `shouldAutoProbe`'s decision logic
 *  can be exercised directly, without rendering the hooks that normally call
 *  it. */
export function recordAutomaticProbe(key: string, result: HealthCheckResult): void {
  automaticProbeMemory.set(key, { at: Date.now(), result });
}

/** Deletes the remembered probe for `key`, forcing the next `shouldAutoProbe`
 *  call to return `true` regardless of the floor. Called on the reconnect
 *  ("cleared verdict") transition, which must always re-probe: an OAuth
 *  re-mint is the one case where the anti-storm floor must not apply.
 *  Exported for the same testability reason as `recordAutomaticProbe`. */
export function clearAutomaticProbeMemory(key: string): void {
  automaticProbeMemory.delete(key);
}

/** Test-only escape hatch: clears every remembered automatic probe. The
 *  memory is module-scope, so without this, probes recorded by one test
 *  would leak into the next. */
export function resetAutomaticProbeMemoryForTest(): void {
  automaticProbeMemory.clear();
}

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
 * renders instantly; a background probe corrects it in place, guarded by
 * `shouldAutoProbe` so a row that remounts (e.g. from an org-wide reactivity
 * bump) does not re-probe every time, quiet on failure: the persisted verdict
 * is still the best known state. `runCheck` is the manual path ("Check
 * now"): it always forces a fresh probe and folds the result into the same
 * live state.
 */
export function useConnectionHealth(connection: Connection): {
  readonly probe: HealthCheckResult | null;
  readonly status: HealthStatus;
  readonly runCheck: () => Promise<Exit.Exit<HealthCheckResult, unknown>>;
} {
  // A live probe result, once a check has run; merged with the persisted
  // verdict by freshness (see freshestVerdict for why not live-always-wins).
  // Seeded from the module memory on mount, not `null`: without this, a
  // remount (any connections-write in the org bumps the org-wide reactivity
  // key and can remount this row) would render the OLDER persisted verdict
  // until the background probe resolves, even though we already know the
  // last automatic probe's result.
  const [liveProbe, setLiveProbe] = useState<HealthCheckResult | null>(
    () => automaticProbeMemory.get(probeKey(connection))?.result ?? null,
  );
  const doCheck = useAtomSet(checkConnectionHealth, { mode: "promiseExit" });
  const invalidateConnections = useInvalidateConnections();

  const probe = freshestVerdict(liveProbe, connection.lastHealth);
  const status: HealthStatus = probe?.status ?? "unknown";

  // Health checks are AUTOMATIC: loading the list revalidates any verdict
  // older than the freshness window (or never checked), stale-while-revalidate
  // style: the persisted verdict renders instantly, the probe corrects it in
  // place. The per-mount part of the guard is once per mount PLUS once per
  // clearing (the ref holds the last epoch seen this mount, and a verdict
  // giving way to `null` -- an OAuth re-mint -- re-arms it, which is how a
  // completed reconnect gets its recovery probe without a page reload). But a
  // fresh `useRef` starts at `undefined` on every remount, so that guard alone
  // re-arms on every remount too. `shouldAutoProbe` is the guard that survives
  // remounts: it consults the module-scope `automaticProbeMemory`, so a row
  // remounted a second later -- before its own last probe even resolved, or
  // resolved with a non-healthy verdict -- does not re-probe. Only the
  // clearing transition bypasses that floor (see `clearAutomaticProbeMemory`).
  const seenEpoch = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const last = connection.lastHealth;
    const epoch = verdictEpoch(last);
    const firstSight = seenEpoch.current === undefined;
    const cleared = epoch === null && seenEpoch.current !== null && !firstSight;
    seenEpoch.current = epoch;
    if (!firstSight && !cleared) return;
    const key = probeKey(connection);
    if (cleared) clearAutomaticProbeMemory(key);
    if (!shouldAutoProbe(key, last)) return;
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
      recordAutomaticProbe(key, exit.value);
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
    // result's epoch keeps the resulting refetch from re-probing. This path
    // always bypasses `shouldAutoProbe` -- the user explicitly asked for a
    // fresh check -- but still records into the module memory, so a remount
    // right after a manual check doesn't immediately fire an automatic one.
    const exit = await doCheck({
      params: connectionParams(connection),
      query: {},
      reactivityKeys: connectionCheckKeys,
    });
    if (Exit.isSuccess(exit)) {
      recordAutomaticProbe(probeKey(connection), exit.value);
      seenEpoch.current = exit.value.checkedAt;
      setLiveProbe(exit.value);
    }
    return exit;
  }, [connection, doCheck]);

  return { probe, status, runCheck };
}

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
  // Seeded from the module memory for whichever connections are known at
  // mount time, for the same reason as `useConnectionHealth`'s `liveProbe`:
  // a remount must show the last automatic probe's verdict, not fall back to
  // the older persisted one while a new probe is (or isn't, thanks to
  // `shouldAutoProbe`) in flight.
  const [liveProbes, setLiveProbes] = useState<ReadonlyMap<string, HealthCheckResult>>(() => {
    const seeded = new Map<string, HealthCheckResult>();
    for (const connection of connections) {
      const remembered = automaticProbeMemory.get(probeKey(connection));
      if (remembered) seeded.set(probeKey(connection), remembered.result);
    }
    return seeded;
  });
  const doCheck = useAtomSet(checkConnectionHealth, { mode: "promiseExit" });
  const invalidateConnections = useInvalidateConnections();

  // Once per VERDICT per connection (same epoch guard as the single-connection
  // hook): the list streams in asynchronously, so the effect re-runs as rows
  // arrive; each row is considered once per persisted-verdict epoch, and a
  // re-minted connection (epoch cleared to null) is considered again without
  // a remount. As with the single-connection hook, this `useRef` guard alone
  // would re-arm on every remount of the owning component, so whether a
  // considered row actually probes is decided by `shouldAutoProbe` against
  // the module-scope `automaticProbeMemory`, which survives that remount.
  const revalidated = useRef(new Map<string, number | null>());
  useEffect(() => {
    for (const connection of connections) {
      const key = probeKey(connection);
      const last = connection.lastHealth;
      const epoch = verdictEpoch(last);
      const firstSight = !revalidated.current.has(key);
      const previousEpoch = revalidated.current.get(key) ?? null;
      if (!firstSight && previousEpoch === epoch) continue;
      const cleared = !firstSight && previousEpoch !== null && epoch === null;
      revalidated.current.set(key, epoch);
      if (cleared) clearAutomaticProbeMemory(key);
      if (!shouldAutoProbe(key, last)) continue;
      void doCheck({
        params: connectionParams(connection),
        query: revalidateQuery(last),
      }).then((exit) => {
        // Same automatic-path rule as the single-connection hook: reflect the
        // verdict, adopt its epoch so the refetch doesn't re-probe, record it
        // into the module memory so a remount respects the floor, and
        // invalidate the connections cache only when the verdict changed so an
        // unchanged reconfirm never churns the cache.
        if (!Exit.isSuccess(exit)) return;
        recordAutomaticProbe(key, exit.value);
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
