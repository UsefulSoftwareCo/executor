// Regression for the "StorageError: Failed query: …" reports in production.
// One root cause fanned out into a report per table and WHERE-clause because
// `fumaFailureFromCause` copied the driver's error text verbatim into
// `StorageError.message`: drizzle's `DrizzleQueryError` message is
// `Failed query: <sql>\nparams: <bound values>`, so error reports grouped by
// SQL statement AND printed bound parameters (org ids, user ids, connection
// names) in their TITLES.
//
// Two contracts are pinned here:
//   1. `StorageError.message` is built from a stable label plus the driver's
//      error CODE. Never the statement text, never the bound parameters.
//   2. postgres.js connection faults are classified as a distinct
//      `StorageConnectionError` rather than melting into a generic
//      `StorageError`, so a pool-lifetime bug is not indistinguishable from a
//      malformed query.
//
// The fixtures below are synthetic reconstructions of the driver error shapes
// (verified against node_modules/postgres/src/errors.js and
// node_modules/drizzle-orm/errors.js); all identifiers are placeholders.

import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Predicate } from "effect";

import {
  fumaEffect,
  fumaFailureFromCause,
  isStorageFailure,
  StorageError,
  UniqueViolationError,
} from "./fuma-runtime";

/** Shape of `postgres.js` `Errors.connection(code, options, socket)`. */
const postgresConnectionError = (code: string): Error =>
  Object.assign(
    // oxlint-disable-next-line executor/no-error-constructor -- boundary: reconstructs the native driver error this module has to classify
    new Error(`write ${code} db-placeholder.hyperdrive.local:5432`),
    { code, errno: code, address: "db-placeholder.hyperdrive.local", port: 5432 },
  );

/** Shape of `postgres.js` `Errors.postgres(x)` — a server-side error report. */
const postgresServerError = (code: string, message: string): Error =>
  // oxlint-disable-next-line executor/no-error-constructor -- boundary: reconstructs the native driver error this module has to classify
  Object.assign(new Error(message), { code, severity: "ERROR" });

/**
 * Shape of drizzle's `DrizzleQueryError`: the statement text and the bound
 * parameters are baked into `message`, and the driver error hangs off `cause`.
 */
const drizzleQueryError = (sql: string, params: readonly unknown[], cause: unknown): Error => {
  // oxlint-disable-next-line executor/no-error-constructor -- boundary: reconstructs the native driver error this module has to classify
  const error = new Error(`Failed query: ${sql}\nparams: ${params.join(",")}`);
  return Object.assign(error, { query: sql, params, cause });
};

const SQL = 'select "key", "value" from "plugin_storage" where "scope_id" = $1 and "key" = $2';
// Synthetic placeholders standing in for the real bound values (a WorkOS org id
// and a connection-scoped storage key) that leaked into error-report titles.
const PARAMS = ["org_placeholder_0000", "oauth:integration-placeholder:refresh"] as const;

const expectNoDriverTextIn = (message: string): void => {
  expect(message).not.toContain("Failed query");
  expect(message).not.toContain("params:");
  expect(message).not.toContain("select");
  expect(message).not.toContain('plugin_storage"');
  for (const param of PARAMS) expect(message).not.toContain(param);
};

describe("fumaFailureFromCause — message shaping", () => {
  it("does not put the statement text or bound parameters in the message", () => {
    const failure = fumaFailureFromCause(
      "plugin_storage.findFirst",
      drizzleQueryError(SQL, PARAMS, postgresConnectionError("CONNECTION_ENDED")),
    );

    expectNoDriverTextIn(failure.message ?? "");
  });

  it("builds a stable message from the label and the driver error code", () => {
    const failure = fumaFailureFromCause(
      "plugin_storage.findFirst",
      drizzleQueryError(
        SQL,
        PARAMS,
        postgresServerError("42P01", 'relation "nope" does not exist'),
      ),
    );

    expect(Predicate.isTagged(failure, "StorageError")).toBe(true);
    expect(failure.message).toContain("plugin_storage.findFirst");
    expect(failure.message).toContain("42P01");
    expectNoDriverTextIn(failure.message ?? "");
  });

  it("groups two different statements failing the same way onto one message", () => {
    const a = fumaFailureFromCause(
      "integration.findFirst",
      drizzleQueryError(
        'select * from "integration" where "slug" = $1',
        ["integration-placeholder"],
        postgresServerError("57P01", "terminating connection due to administrator command"),
      ),
    );
    const b = fumaFailureFromCause(
      "integration.findFirst",
      drizzleQueryError(
        'select * from "integration" where "owner" = $1 and "slug" = $2',
        ["org_placeholder_0000", "other-integration-placeholder"],
        postgresServerError("57P01", "terminating connection due to administrator command"),
      ),
    );

    expect(a.message).toBe(b.message);
  });

  it("still yields a stable message when the driver reports no code", () => {
    const failure = fumaFailureFromCause(
      "tool.findMany",
      drizzleQueryError(
        SQL,
        PARAMS,
        // oxlint-disable-next-line executor/no-error-constructor -- boundary: reconstructs a codeless native driver error
        new Error("something went wrong in the driver"),
      ),
    );

    expect(Predicate.isTagged(failure, "StorageError")).toBe(true);
    expect(failure.message).toContain("tool.findMany");
    expectNoDriverTextIn(failure.message ?? "");
    expect(failure.message).not.toContain("something went wrong");
  });

  it("keeps the full driver error reachable on `cause`", () => {
    const driver = drizzleQueryError(SQL, PARAMS, postgresConnectionError("CONNECTION_ENDED"));
    const failure = fumaFailureFromCause("plugin_storage.findFirst", driver);

    expect((failure as { readonly cause?: unknown }).cause).toBe(driver);
  });
});

describe("fumaFailureFromCause — classification", () => {
  it.each([
    ["CONNECTION_ENDED"],
    ["CONNECTION_CLOSED"],
    ["CONNECTION_DESTROYED"],
    ["CONNECT_TIMEOUT"],
    // A backend that is simply down: postgres.js surfaces the socket errno
    // verbatim, so `connect ECONNREFUSED …` is the ordinary "database
    // unreachable" fault and must classify like the rest.
    ["ECONNREFUSED"],
    ["ECONNRESET"],
  ])("classifies postgres.js %s as a storage connection fault", (code) => {
    const failure = fumaFailureFromCause(
      "plugin_storage.findFirst",
      drizzleQueryError(SQL, PARAMS, postgresConnectionError(code)),
    );

    expect(Predicate.isTagged(failure, "StorageConnectionError")).toBe(true);
    expect(failure).toEqual(
      expect.objectContaining({
        _tag: "StorageConnectionError",
        code,
        label: "plugin_storage.findFirst",
      }),
    );
    expect(typeof (failure as { readonly retryable?: unknown }).retryable).toBe("boolean");
    expectNoDriverTextIn(failure.message ?? "");
  });

  it("classifies the workerd cross-request I/O rejection as a connection fault", () => {
    const failure = fumaFailureFromCause(
      "integration.findFirst",
      drizzleQueryError(
        'select * from "integration" where "slug" = $1',
        ["integration-placeholder"],
        // oxlint-disable-next-line executor/no-error-constructor -- boundary: reconstructs workerd's cross-request I/O rejection, which carries no code
        new Error(
          "Cannot perform I/O on behalf of a different request. I/O objects (such as streams, request/response bodies, and others) created in the context of one request handler cannot be accessed from a different request's handler.",
        ),
      ),
    );

    expect(Predicate.isTagged(failure, "StorageConnectionError")).toBe(true);
    expectNoDriverTextIn(failure.message ?? "");
    expect(failure.message).not.toContain("Cannot perform I/O");
  });

  it("marks transient socket loss retryable and pool-lifetime faults not retryable", () => {
    const transient = fumaFailureFromCause(
      "tool.findMany",
      postgresConnectionError("CONNECTION_CLOSED"),
    ) as { readonly retryable?: boolean };
    const lifetime = fumaFailureFromCause(
      "tool.findMany",
      postgresConnectionError("CONNECTION_ENDED"),
    ) as { readonly retryable?: boolean };

    expect(transient.retryable).toBe(true);
    expect(lifetime.retryable).toBe(false);
  });

  it("still recognises unique violations by SQLSTATE", () => {
    const failure = fumaFailureFromCause(
      "connection.create",
      drizzleQueryError(
        'insert into "connection" ("owner","name") values ($1,$2)',
        ["org_placeholder_0000", "connection-placeholder"],
        postgresServerError(
          "23505",
          'duplicate key value violates unique constraint "connection_pkey"',
        ),
      ),
    );

    expect(failure).toBeInstanceOf(UniqueViolationError);
    expect(Predicate.isTagged(failure, "UniqueViolationError")).toBe(true);
  });

  it("does not misread a unique violation as a connection fault", () => {
    const failure = fumaFailureFromCause(
      "connection.create",
      postgresServerError("23505", "duplicate key value violates unique constraint"),
    );

    expect(Predicate.isTagged(failure, "StorageConnectionError")).toBe(false);
  });

  it("passes an already-typed storage failure through untouched", () => {
    const original = new StorageError({
      message: 'FumaDB table "secret" is not available through this storage boundary.',
      cause: undefined,
    });

    expect(fumaFailureFromCause("plugin_storage.findFirst", original)).toBe(original);
  });

  it("treats a connection fault as a storage failure at the boundary", () => {
    const failure = fumaFailureFromCause(
      "plugin_storage.findFirst",
      postgresConnectionError("CONNECTION_ENDED"),
    );

    expect(isStorageFailure(failure)).toBe(true);
    expect(fumaFailureFromCause("plugin_storage.findFirst", failure)).toBe(failure);
  });
});

describe("fumaEffect", () => {
  it("maps a rejected driver promise onto the classified failure", async () => {
    const driverRejection = () =>
      // oxlint-disable-next-line executor/no-promise-reject -- boundary: fumaEffect's whole contract is adapting a rejected driver promise
      Promise.reject(drizzleQueryError(SQL, PARAMS, postgresConnectionError("CONNECTION_ENDED")));

    const exit = await Effect.runPromiseExit(
      fumaEffect("plugin_storage.findFirst", driverRejection),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Exit.isFailure(exit)
      ? exit.cause.reasons.find(Cause.isFailReason)?.error
      : undefined;

    expect(Predicate.isTagged(failure, "StorageConnectionError")).toBe(true);
    expectNoDriverTextIn(failure?.message ?? "");
  });
});
