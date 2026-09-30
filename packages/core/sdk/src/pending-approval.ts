// ---------------------------------------------------------------------------
// PendingApprovalStore — durable "this call is waiting on a human" records.
//
// A paused execution normally lives as a suspended fiber inside one engine
// instance. That works whenever the pause and the resume are served by the same
// engine (local and desktop, which share one boot-built executor, and any
// same-instance resume elsewhere). It does NOT work on a host whose HTTP API
// builds a fresh executor per request: the fiber is discarded with the request
// that created it, so the resume arrives at an engine that has never heard of
// the execution. That is the whole of the artifact-approval bug — the failure is
// immediate, not a lease expiring.
//
// An artifact action is reconstructible where general code is not. The shell's
// grammar is exactly ONE tool call (`parseToolCallCode`), and the approval gate
// runs strictly BEFORE the tool is invoked, so a paused artifact action holds no
// partial work — only a resolved call that has not happened yet. Recording that
// call durably and running it when the approval arrives is therefore equivalent
// to resuming the fiber, without requiring the fiber to still exist.
//
// Records live in the existing owner-scoped `blob` table (no new table, no
// migration). They are single-use: consumed atomically (compareAndDelete) on
// resume, so one approval authorizes exactly one invocation and NEITHER a
// replayed resume NOR two concurrent resumes can re-run the call.
// ---------------------------------------------------------------------------

import { Effect, Option, Schema } from "effect";

import type { BlobStore } from "./blob";
import type { StorageError } from "./fuma-runtime";

/** How long a recorded approval stays valid. Human-scale: someone reading an
 *  argument preview and deciding takes minutes, not seconds. Past this the
 *  record is treated as absent and the shell asks the user to trigger the
 *  action again, which is safe because nothing has run yet. */
export const PENDING_APPROVAL_TTL_MS = 15 * 60 * 1000;

/**
 * The resolved call an approval authorizes.
 *
 * `code` is the SERVER-BUILT emission (`resolveArtifactAction` rewrote the
 * artifact's role into a real connection address) — never the string the iframe
 * sent. Re-running it after approval therefore runs exactly what the pause
 * described, and an iframe cannot widen its own grant between pause and resume.
 */
export const PendingApproval = Schema.Struct({
  executionId: Schema.String,
  /** The artifact the call came from, for the ownership re-check on resume. */
  artifactId: Schema.String,
  /** The resolved, server-built tool-call code. */
  code: Schema.String,
  /** The tool address the human was shown, so the record can be audited and so
   *  a resume cannot be pointed at a different call than the one approved. */
  address: Schema.String,
  /** Epoch ms after which this record is ignored. */
  expiresAt: Schema.Number,
});
export type PendingApproval = typeof PendingApproval.Type;

const encodePendingApproval = Schema.encodeUnknownSync(Schema.fromJsonString(PendingApproval));
const decodePendingApproval = Schema.decodeUnknownOption(Schema.fromJsonString(PendingApproval));

/**
 * Durable store for pending approvals, scoped to one owner partition.
 *
 * `get` is a strict read: an expired or unparseable record reads as absent, and
 * either way the entry is not returned. Callers treat absent as "the approval
 * window closed — ask the user to trigger the action again".
 */
export interface PendingApprovalStore {
  readonly put: (approval: PendingApproval) => Effect.Effect<void, StorageError>;
  /** Read and DELETE in one step — an approval authorizes exactly one run. */
  readonly consume: (executionId: string) => Effect.Effect<PendingApproval | null, StorageError>;
  /** Drop a record without running it (decline/cancel). */
  readonly discard: (executionId: string) => Effect.Effect<void, StorageError>;
}

/**
 * Bind a `BlobStore` to one owner partition as a pending-approval store.
 *
 * The namespace is the owner partition plus a fixed suffix, matching how plugin
 * blobs namespace themselves — so a record is only ever visible to the scope
 * that wrote it, and the ownership check on resume is the same read that fetches
 * the record rather than a separate test that could drift from it.
 */
export const makePendingApprovalStore = (
  blobs: BlobStore,
  partition: string,
  now: () => number = Date.now,
): PendingApprovalStore => {
  const namespace = `${partition}/@pending-approval`;

  return {
    put: (approval) => blobs.put(namespace, approval.executionId, encodePendingApproval(approval)),

    consume: (executionId) =>
      Effect.gen(function* () {
        // Read the payload first — compareAndDelete returns only a boolean,
        // so the winner needs the record's value to validate and return.
        // Reading before the gate is safe: a concurrent loser may read the
        // same payload but will fail the compareAndDelete gate below and
        // never return it. The ordering that matters is the DELETE's
        // single-winner guarantee, not the read's.
        const raw = yield* blobs.get(namespace, executionId);
        if (raw === null) return null;
        // Atomic single-winner delete: exactly one concurrent consumer
        // observes true (the record existed and was removed); everyone else
        // observes false. This closes the get→delete race that previously
        // let two concurrent resumes both read a record before either
        // deleted it — duplicated side effects.
        const removed = yield* blobs.compareAndDelete(namespace, executionId);
        if (!removed) return null;
        // Consume before validating (preserved): a record we are about to
        // reject is a record nobody should be able to retry against — the
        // atomic delete already removed it, so no other consumer can see it.
        const decoded = decodePendingApproval(raw);
        if (Option.isNone(decoded)) return null;
        const approval = decoded.value;
        if (approval.expiresAt <= now()) return null;
        return approval;
      }),

    discard: (executionId) => blobs.delete(namespace, executionId),
  };
};
