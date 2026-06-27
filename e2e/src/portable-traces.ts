import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Cause, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { writeJsonAtomicSync } from "./artifact-io";
import { sanitizePublishedText, sanitizePublishedValue } from "./published-artifacts";

const TraceLedger = Schema.Array(
  Schema.Struct({
    id: Schema.String,
  }),
);
const MotelTraceResponse = Schema.Struct({ data: Schema.Unknown });
const decodeTraceLedger = Schema.decodeUnknownSync(TraceLedger);
const decodeMotelTraceResponse = Schema.decodeUnknownEffect(MotelTraceResponse);
const TRACE_ID = /^[0-9a-f]{32}$/i;
const TRACE_POLL_ATTEMPTS = 40;

const fetchTraceOnce = (motelUrl: string, traceId: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${motelUrl}/api/traces/${encodeURIComponent(traceId)}`),
    );
    if (response.status !== 200) {
      yield* response.text.pipe(Effect.catch(() => Effect.succeed("")));
      return yield* Effect.fail({
        _tag: "MotelTraceNotReady",
        traceId,
        status: response.status,
      } as const);
    }
    return yield* response.json.pipe(Effect.flatMap(decodeMotelTraceResponse));
  });

const fetchTrace = (motelUrl: string, traceId: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < TRACE_POLL_ATTEMPTS; attempt += 1) {
      const result = yield* Effect.result(fetchTraceOnce(motelUrl, traceId));
      if (result._tag === "Success") return result.success;
      yield* Effect.sleep("500 millis");
    }
    return yield* fetchTraceOnce(motelUrl, traceId);
  });

export interface PortableTraceExport {
  readonly file?: string;
  readonly exported: number;
  readonly missing: number;
  readonly invalid: number;
}

/**
 * Copy every trace named by the run ledger out of the suite-owned Motel store.
 * The store is deleted by global teardown, so this sanitized export is the
 * portable evidence reviewers can inspect after CI has finished.
 */
export const exportPortableTraces = (runDir: string, motelUrl: string) =>
  Effect.gen(function* () {
    const ledgerFile = join(runDir, "traces.json");
    if (!existsSync(ledgerFile)) {
      return { exported: 0, missing: 0, invalid: 0 } satisfies PortableTraceExport;
    }

    const ledger = decodeTraceLedger(JSON.parse(readFileSync(ledgerFile, "utf8")));
    const ids = [...new Set(ledger.map((entry) => entry.id))];
    const validIds = ids.filter((id) => TRACE_ID.test(id));
    const invalidIds = ids.filter((id) => !TRACE_ID.test(id));
    const fetched = yield* Effect.all(
      validIds.map((traceId) =>
        fetchTrace(motelUrl, traceId).pipe(
          Effect.map(({ data }) => ({ traceId, data, found: true }) as const),
          Effect.catchCause((cause) =>
            Effect.succeed({
              traceId,
              found: false,
              error: sanitizePublishedText(String(Cause.squash(cause))),
            } as const),
          ),
        ),
      ),
      { concurrency: 8 },
    );
    const traces = fetched
      .filter((entry) => entry.found)
      .map((entry) => ({ traceId: entry.traceId, data: entry.data }));
    const missing = fetched
      .filter((entry) => !entry.found)
      .map((entry) => ({ traceId: entry.traceId, error: entry.error }));
    const file = join(runDir, "otel-traces.json");
    writeJsonAtomicSync(
      file,
      sanitizePublishedValue({
        schemaVersion: 1,
        exportedAt: Date.now(),
        traces,
        missing,
        invalidTraceIds: invalidIds,
      }),
    );
    return {
      file: "otel-traces.json",
      exported: traces.length,
      missing: missing.length,
      invalid: invalidIds.length,
    } satisfies PortableTraceExport;
  });
