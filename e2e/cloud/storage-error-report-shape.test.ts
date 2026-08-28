// Cloud-only: what an operator SEES when a write is rejected by the database.
//
// The product guarantee: a storage failure is reported under a stable headline
// built from the operation and the database's error code — never the statement
// text, never the values that were bound into it. Two consequences, both of
// them things production got wrong:
//
//   - The values bound into a rejected statement are customer data (the
//     organization id, the connection name, whatever the user typed into the
//     description). They must not appear in the report's headline.
//   - The headline is the grouping key of the error reporter, so one defect that
//     hits several tables — or the same table through several WHERE shapes —
//     must arrive as ONE report, not one per statement.
//
// The failure is induced through the public typed API only: PostgreSQL cannot
// store a NUL byte in a text column, so a connection whose description carries
// one is rejected by the driver with SQLSTATE 22021 while the statement and its
// bound parameters are already assembled. That is the same class of failure the
// production reports came from, reachable without touching the database.
//
// Two surfaces are asserted, both public:
//   1. What the CALLER gets — an opaque `InternalError` carrying only a trace
//      id, with no driver text anywhere in the payload.
//   2. What the OPERATOR gets — the server's own error log, where the trace id
//      the caller received joins to the report the server filed. Its headline —
//      the captured exception's type and message — is what the error reporter
//      files the report under, and groups by.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect } from "@effect/vitest";
import { Cause, Effect, Exit, Schedule } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { RUNS_DIR, scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

/** A text value PostgreSQL cannot store — the driver rejects it as 22021. */
const NUL = String.fromCharCode(0);

const SLUG = "storage-error-report-shape";

/** Minimal OpenAPI spec with a single GET /ping — never contacted here. */
const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Ping API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: { operationId: "ping", summary: "Ping", responses: { "200": { description: "pong" } } },
    },
  },
});

/** Registers a fresh apiKey-authenticated integration for connections to bind to. */
const registerIntegration = (client: Client) =>
  Effect.gen(function* () {
    const slug = IntegrationSlug.make(`${SLUG}-${randomBytes(4).toString("hex")}`);
    yield* client.openapi.addSpec({
      payload: {
        spec: { kind: "blob", value: pingSpec },
        slug,
        baseUrl: "http://127.0.0.1:59999", // never contacted during registration
        authenticationTemplate: [
          {
            slug: "apiKey",
            type: "apiKey",
            headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
          },
        ],
      },
    });
    return slug;
  });

interface RejectedWrite {
  /** The trace id the caller was handed; joins to the server's report. */
  readonly traceId: string;
  /** The name the caller chose for the connection — customer data. */
  readonly name: string;
  /** The free text the caller typed — customer data, and the NUL carrier. */
  readonly description: string;
  /** The whole client-visible failure, serialized. */
  readonly payload: string;
}

/**
 * Create a connection whose description PostgreSQL will refuse, and return what
 * the caller can see about the failure.
 */
const rejectedConnectionWrite = (
  client: Client,
  integration: IntegrationSlug,
): Effect.Effect<RejectedWrite> =>
  Effect.gen(function* () {
    const name = ConnectionName.make(
      `${SLUG.replaceAll("-", "")}${randomBytes(4).toString("hex")}`,
    );
    const description = `desc-${randomBytes(6).toString("hex")}${NUL}tail`;

    const exit = yield* Effect.exit(
      client.connections.create({
        payload: {
          owner: "org",
          name,
          integration,
          template: AuthTemplateSlug.make("apiKey"),
          description,
          value: `sk-${randomBytes(4).toString("hex")}`,
        },
      }),
    );

    const failure = Exit.isFailure(exit)
      ? exit.cause.reasons.find(Cause.isFailReason)?.error
      : exit.value;
    const error = failure as { readonly _tag?: string; readonly traceId?: string } | undefined;

    // PostgreSQL refuses the NUL byte, so the write cannot succeed, and what
    // comes back is the opaque internal failure — never the storage error.
    expect(error?._tag, "the caller sees an opaque internal failure").toBe("InternalError");
    expect(error?.traceId ?? "", "the caller is handed a trace id to quote").toMatch(
      /^[0-9a-f]{32}$/,
    );

    return {
      traceId: error?.traceId ?? "",
      name,
      description,
      payload: JSON.stringify(failure),
    };
  });

/**
 * The dev stack's stdout. The suite's globalsetup funnels it into the run
 * artifacts; a scenario run against an already-booted instance (`cli up cloud`)
 * reads that instance's log instead.
 */
const serverLogCandidates = [
  resolve(RUNS_DIR, "cloud", "server-logs", "boot.log"),
  resolve(RUNS_DIR, "..", ".dev", "cloud.log"),
];

const readServerLog = (): string => {
  const texts = serverLogCandidates.flatMap((path) => {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: probing which of the two stdout sinks this run uses
    try {
      return [readFileSync(path, "utf8")];
    } catch {
      return [];
    }
  });
  return texts.join("\n");
};

const REPORT_PREFIX = "[api] unhandled cause: ";

/** A stack frame in the logged cause — where the report's headline stops. */
const STACK_FRAME = /^\s+at /;

interface FiledReport {
  /** Type + message: what the reporter names and groups the report by. */
  readonly headline: string;
  /** The whole record, headline and chained cause — what a diagnosis reads. */
  readonly full: string;
}

/**
 * The report the server filed for one request.
 *
 * The headline is the captured cause's type and message up to the first stack
 * frame — exactly what `Cause.prettyErrors` hands the reporter as the
 * exception. The message is multi-line whenever the driver's text is
 * (`Failed query: …\nparams: …`), so the whole headline has to be read, not
 * just its first line.
 *
 * Found by walking back from the correlation record carrying the caller's trace
 * id, so it is THIS request's report and not a neighbour's.
 */
const reportFor = (traceId: string): Effect.Effect<FiledReport, string> =>
  Effect.sync(() => {
    const lines = readServerLog().split("\n");
    const correlated = lines.findLastIndex(
      (line) =>
        line.includes('"event":"sentry_before_send_otel_correlation"') &&
        line.includes(`"sentry_event_id":"${traceId}"`),
    );
    if (correlated === -1) return undefined;
    const reported = lines
      .slice(0, correlated)
      .findLastIndex((line) => line.startsWith(REPORT_PREFIX));
    if (reported === -1) return undefined;
    const block = [
      lines[reported]!.slice(REPORT_PREFIX.length),
      ...lines.slice(reported + 1, correlated),
    ];
    const end = block.slice(1).findIndex((line) => STACK_FRAME.test(line));
    return {
      headline: block
        .slice(0, end === -1 ? 1 : end + 1)
        .join("\n")
        .trimEnd(),
      full: block.join("\n"),
    };
  }).pipe(
    Effect.filterOrFail(
      (report): report is FiledReport => report !== undefined,
      () => `no error report joined to trace id ${traceId} in the server log`,
    ),
    // The log is a file the dev stack appends to; the write lands moments after
    // the response. Poll rather than sleep (~20s ceiling).
    Effect.retry(Schedule.both(Schedule.spaced("500 millis"), Schedule.recurs(40))),
  );

scenario(
  "Storage · a rejected write is reported without its SQL or the caller's data",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: apiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiClient(api, identity);
    const integration = yield* registerIntegration(client);

    const first = yield* rejectedConnectionWrite(client, integration);
    const second = yield* rejectedConnectionWrite(client, integration);

    for (const write of [first, second]) {
      expect(write.payload, "the client payload carries no driver text").not.toContain(
        "Failed query",
      );
      expect(write.payload, "the client payload carries no bound parameter").not.toContain(
        write.description,
      );
    }

    const report = yield* reportFor(first.traceId);
    const headline = report.headline;

    // The symptom: the statement and everything bound into it used to BE the
    // headline, so the report was named after the customer's data.
    expect(headline, "the report headline carries no statement text").not.toContain("Failed query");
    expect(headline, "the report headline carries no statement text").not.toContain("insert into");
    expect(headline, "the report headline carries no bound parameters").not.toContain("params:");
    expect(headline, "the report headline carries no user-typed description").not.toContain(
      first.description,
    );
    expect(headline, "the report headline carries no user-chosen connection name").not.toContain(
      first.name,
    );
    expect(headline, "the report headline carries no organization id").not.toContain("org_");

    // What it says instead: which operation failed, and how the database
    // refused it — enough to act on, stable across calls.
    expect(headline, "the report still names the failing operation").toContain("connection.create");
    expect(headline, "the report still names the database's error code").toContain("22021");

    // Shaping the headline must not mean throwing the diagnosis away: the
    // driver's own text is still filed with the report, one level down, where
    // it informs a fix instead of naming the report.
    expect(report.full, "the driver's statement is still filed under the report").toContain(
      "Failed query",
    );

    // The fan-out: the two writes bound different names, descriptions and
    // secrets, so their statements differ in every parameter. One defect, one
    // report — not one report per set of values.
    const secondReport = yield* reportFor(second.traceId);
    expect(
      secondReport.headline,
      "a second rejected write with different values files the same report",
    ).toBe(headline);
  }),
);
