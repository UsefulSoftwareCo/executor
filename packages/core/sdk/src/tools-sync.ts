// ---------------------------------------------------------------------------
// @executor-js/sdk tool-sync status vocabulary (browser-safe).
//
// Catalog sync and credential health are DIFFERENT signals. A health check
// answers "is this credential alive, and whose account is it?" — an explicit,
// authenticated probe whose verdict lives in `last_health`. A failed tool sync
// answers a different question entirely: "is this connection's tool catalog
// current?" — the credential may be perfectly fine while an MCP server is
// slow to dial once, or a spec blob read hiccups.
//
// Conflating them (writing a degraded health verdict on sync failure) painted
// amber DEGRADED across whole connection lists over single transient blips.
// So sync trouble is persisted on its own column (`tools_sync_error`), with a
// consecutive-failure count: the raw data is honest (every failure recorded,
// success clears it), and DISPLAY applies the debounce — a stale-catalog hint
// renders only after several consecutive failures, and always as a muted
// annotation, never as the credential-health treatment.
// ---------------------------------------------------------------------------

import { Schema } from "effect";

export const ToolsSyncError = Schema.Struct({
  /** Epoch ms of the most recent failed sync attempt. */
  at: Schema.Number,
  /** How many syncs in a row have failed. Reset to zero (the whole record is
   *  cleared) by any successful sync. */
  failures: Schema.Number,
  /** Human-readable reason from the plugin (why the listing was
   *  non-authoritative), for operators. */
  reason: Schema.String,
});
export type ToolsSyncError = typeof ToolsSyncError.Type;

/** How many consecutive sync failures before the UI hints that the catalog
 *  may be stale. At the 15-minute background sweep TTL this is ~45 minutes of
 *  continuous failure — a real outage, not a blip. */
export const TOOLS_SYNC_STALE_THRESHOLD = 3;

/** Whether a connection's sync state should surface as "catalog may be stale".
 *  Null (last sync authoritative) or a below-threshold streak render nothing. */
export const isToolsSyncStale = (error: ToolsSyncError | null | undefined): boolean =>
  error != null && error.failures >= TOOLS_SYNC_STALE_THRESHOLD;
