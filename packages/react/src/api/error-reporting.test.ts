// That a handled UI failure reaches the crash reporter as a titled error is
// covered end to end by e2e/cloud/frontend-error-reporting.test.ts, which reads
// the report off the wire. What is left here is the input shapes a browser run
// cannot produce on demand — a thrown string, a tagged error declared without a
// `message` field, an already-normalized error — at the pure function that has
// to handle each of them.
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Exit from "effect/Exit";
import {
  messageFromExit,
  messageFromUnknown,
  reportExitFailure,
  toReportableError,
  type FrontendErrorContext,
} from "./error-reporting";

const context: FrontendErrorContext = {
  surface: "api_client",
  action: "decode_or_transport",
};

/**
 * These tests exercise the adapter between Effect's failure model and a crash
 * reporter, so a built-in `Error` is the fixture the adapter exists to accept
 * and to produce.
 */
// oxlint-disable-next-line executor/no-error-constructor, executor/no-redundant-error-factory -- boundary: fixture for the raw-Error adapter under test
const rawError = (message: string): Error => new Error(message);

const captureReports = (): {
  readonly calls: Array<{ error: unknown; context: FrontendErrorContext }>;
  readonly report: (error: unknown, context: FrontendErrorContext) => void;
} => {
  const calls: Array<{ error: unknown; context: FrontendErrorContext }> = [];
  return { calls, report: (error, ctx) => calls.push({ error, context: ctx }) };
};

describe("frontend error reporting", () => {
  it("extracts stable messages from structured failures", () => {
    expect(messageFromUnknown({ message: "Saved connection failed" }, "Fallback")).toBe(
      "Saved connection failed",
    );
    expect(messageFromUnknown("Plain failure", "Fallback")).toBe("Plain failure");
    expect(messageFromUnknown({ reason: "unknown" }, "Fallback")).toBe("Fallback");
  });

  it("extracts stable messages from Effect exits", () => {
    const exit = Exit.fail({ message: "Could not update integration" });

    expect(messageFromExit(exit, "Fallback")).toBe("Could not update integration");
    expect(messageFromExit(Exit.fail({ reason: "unknown" }), "Fallback")).toBe("Fallback");
  });

  it("reports failed exits with the provided context", () => {
    const exit = Exit.fail({ message: "Could not update integration" });
    const { calls, report } = captureReports();

    reportExitFailure(report, exit, {
      surface: "integrations",
      action: "update",
      message: "Could not update integration",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.context.surface).toBe("integrations");
    expect(calls[0]!.context.action).toBe("update");
    // The originating cause travels with the report rather than being reported
    // as-is — see the normalization contract below.
    expect(Cause.isCause((calls[0]!.error as Error).cause)).toBe(true);
  });
});

class ConnectionRefused extends Data.TaggedError("ConnectionRefused")<{
  readonly endpoint: string;
}> {}

describe("toReportableError", () => {
  it("returns a real Error untouched", () => {
    const original = rawError("original failure");

    const reportable = toReportableError(original, context);

    expect(reportable).toBe(original);
    expect(reportable.message).toBe("original failure");
    expect(reportable.stack).toBe(original.stack);
  });

  it("keeps the message and stack of a defect inside a cause", () => {
    const defect = rawError("render crashed");

    const reportable = toReportableError(Cause.die(defect), context);

    expect(reportable).toBeInstanceOf(Error);
    expect(reportable.message).toBe("render crashed");
    expect(reportable.stack ?? "").toContain("render crashed");
    expect(Cause.isCause(reportable.cause)).toBe(true);
  });

  it("titles a thrown string", () => {
    const reportable = toReportableError("something went sideways", context);

    expect(reportable).toBeInstanceOf(Error);
    expect(reportable.message).toBe("something went sideways");
  });

  it("titles a cause carrying a thrown string", () => {
    const reportable = toReportableError(Cause.fail("upstream said no"), context);

    expect(reportable.message).toBe("upstream said no");
  });

  it("names an Effect tagged error by its tag and never leaves it message-less", () => {
    const reportable = toReportableError(
      Cause.fail(new ConnectionRefused({ endpoint: "https://api.example.test" })),
      { ...context, message: "Could not reach the API" },
    );

    // A `Data.TaggedError` declared without a `message` field renders with an
    // empty one — the exact shape that produced `No error message` in Sentry.
    expect(reportable.name).toBe("ConnectionRefused");
    expect(reportable.message).toBe("Could not reach the API");
  });

  it("falls back to the reporting surface when nothing carries a message", () => {
    const reportable = toReportableError({ status: 418 }, context);

    expect(reportable.message).toBe("api_client/decode_or_transport");
  });

  it("is idempotent, so layering it is safe", () => {
    const once = toReportableError(Cause.die(rawError("render crashed")), context);

    expect(toReportableError(once, context)).toBe(once);
  });
});
