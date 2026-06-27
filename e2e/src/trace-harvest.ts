// The run's distributed-trace ledger (traces.json): every request the
// session made against the target, with the trace id that names its
// click→server→DB waterfall in the OTLP store the run exported to.
//
// Two writers share it: the browser surface (ids harvested off the wire,
// the web app sends traceparent itself) and the MCP surface (ids MINTED
// here, since mcporter's plain fetch sends none; the server joins whatever
// traceparent arrives). Append is read-merge-write so neither clobbers the
// other; entries stay sorted by wall clock.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { evidenceReferenceFor, withArtifactLockSync, writeJsonAtomicSync } from "./artifact-io";
import { sanitizePublishedText, sanitizePublishedUrl } from "./published-artifacts";

export interface TraceEntry {
  readonly id: string;
  readonly at: number;
  readonly url: string;
  readonly ms?: number;
  readonly status?: number;
  /** Which window made the request; the viewer's rail tags rows with it. */
  readonly source?: "terminal" | "browser";
  /** Readable name when the URL alone says nothing (MCP: every call POSTs
   *  the same endpoint; the JSON-RPC method/tool is the real identity). */
  readonly label?: string;
  /** Retry and worker-process identity for cross-file evidence correlation. */
  readonly attemptId?: string;
  readonly invocationId?: string;
  /** Stable order assigned while holding the run's cross-process ledger lock. */
  readonly sequence?: number;
}

const fileFor = (runDir: string) => join(runDir, "traces.json");

const optionalNumber = (value: unknown): boolean =>
  value === undefined || typeof value === "number";
const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

const isTraceEntry = (value: unknown): value is TraceEntry => {
  if (typeof value !== "object" || value === null) return false;
  return (
    "id" in value &&
    typeof value.id === "string" &&
    "at" in value &&
    typeof value.at === "number" &&
    "url" in value &&
    typeof value.url === "string" &&
    (!("ms" in value) || optionalNumber(value.ms)) &&
    (!("status" in value) || optionalNumber(value.status)) &&
    (!("source" in value) ||
      value.source === undefined ||
      value.source === "terminal" ||
      value.source === "browser") &&
    (!("label" in value) || optionalString(value.label)) &&
    (!("attemptId" in value) || optionalString(value.attemptId)) &&
    (!("invocationId" in value) || optionalString(value.invocationId)) &&
    (!("sequence" in value) || optionalNumber(value.sequence))
  );
};

export const appendTraces = (runDir: string, entries: ReadonlyArray<TraceEntry>): void => {
  if (entries.length === 0) return;
  const file = fileFor(runDir);
  const evidence = evidenceReferenceFor(runDir);
  withArtifactLockSync(file, () => {
    const parsed: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    if (!Array.isArray(parsed) || !parsed.every(isTraceEntry)) {
      throw new Error(`invalid e2e trace ledger: ${file}`);
    }
    const existing = parsed;
    const nextSequence =
      existing.reduce((highest, entry) => Math.max(highest, entry.sequence ?? -1), -1) + 1;
    const appended = entries.map(
      (entry, index): TraceEntry => ({
        ...entry,
        url: sanitizePublishedUrl(entry.url),
        ...(entry.label === undefined ? {} : { label: sanitizePublishedText(entry.label) }),
        ...evidence,
        sequence: nextSequence + index,
      }),
    );
    const merged = [...existing, ...appended].sort(
      (left, right) => left.at - right.at || (left.sequence ?? 0) - (right.sequence ?? 0),
    );
    writeJsonAtomicSync(file, merged);
  });
};
