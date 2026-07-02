// The run's distributed-trace ledger (traces.json): every request the
// session made against the target, with the trace id that names its
// click→server→DB waterfall in the OTLP store the run exported to.
//
// Two writers share it — the browser surface (ids harvested off the wire,
// the web app sends traceparent itself) and the MCP surface (ids MINTED
// here, since mcporter's plain fetch sends none; the server joins whatever
// traceparent arrives). Append is read-merge-write so neither clobbers the
// other; entries stay sorted by wall clock.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TraceEntry {
  readonly id: string;
  readonly at: number;
  readonly url: string;
  readonly ms?: number;
  readonly status?: number;
  /** Which window made the request — the viewer's rail tags rows with it. */
  readonly source?: "terminal" | "browser";
  /** Readable name when the URL alone says nothing (MCP: every call POSTs
   *  the same endpoint; the JSON-RPC method/tool is the real identity). */
  readonly label?: string;
}

const fileFor = (runDir: string) => join(runDir, "traces.json");

export const appendTraces = (runDir: string, entries: ReadonlyArray<TraceEntry>): void => {
  if (entries.length === 0) return;
  const file = fileFor(runDir);
  const existing: TraceEntry[] = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as TraceEntry[])
    : [];
  const merged = [...existing, ...entries].sort((a, b) => a.at - b.at);
  writeFileSync(file, JSON.stringify(merged, null, 1));
};
