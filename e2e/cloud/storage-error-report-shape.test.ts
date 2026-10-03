// Exercise a real rejected database write through the typed API. The caller
// receives an opaque correlation ID; the operator gets the same ID plus the
// operation and SQLSTATE, without SQL, bound values or raw driver causes.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect } from "@effect/vitest";
import { Cause, Effect, Exit, Schedule, Schema } from "effect";
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

const decodeReport = Schema.decodeUnknownOption(
  Schema.Struct({
    event: Schema.Literal("api_unhandled_cause"),
    sentry_event_id: Schema.String,
    tags: Schema.Record(Schema.String, Schema.String),
  }),
);

/** Find the structured operator report by the ID returned to the caller. */
const reportFor = (traceId: string) =>
  Effect.sync(() => {
    for (const line of readServerLog().split("\n")) {
      if (!line.startsWith("{")) continue;
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: mixed stdout includes non-JSON records
      try {
        const report = decodeReport(JSON.parse(line));
        if (report._tag === "Some" && report.value.sentry_event_id === traceId) {
          return {
            headline: JSON.stringify(report.value.tags),
            full: line,
            tags: report.value.tags,
          };
        }
      } catch {
        /* Other stdout records are not diagnostic envelopes. */
      }
    }
    return undefined;
  }).pipe(
    Effect.filterOrFail(
      (report) => report !== undefined,
      () => `no error report joined to trace id ${traceId} in the server log`,
    ),
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

    expect(report.tags).toMatchObject({ operation: "connection.create", code: "22021" });
    for (const forbidden of [
      "Failed query",
      "insert into",
      "params:",
      first.name,
      first.description,
    ]) {
      expect(report.full, "the complete report omits SQL and caller data").not.toContain(forbidden);
    }

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
