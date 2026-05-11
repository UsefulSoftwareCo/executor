import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import {
  messageFromExit,
  messageFromUnknown,
  reportExitFailure,
  type FrontendErrorContext,
} from "./error-reporting";

describe("frontend error reporting", () => {
  it("extracts stable messages from structured failures", () => {
    expect(messageFromUnknown({ message: "Saved connection failed" }, "Fallback")).toBe(
      "Saved connection failed",
    );
    expect(messageFromUnknown("Plain failure", "Fallback")).toBe("Plain failure");
    expect(messageFromUnknown({ reason: "unknown" }, "Fallback")).toBe("Fallback");
  });

  it("extracts stable messages from Effect exits", () => {
    const exit = Exit.fail({ message: "Could not update source" });

    expect(messageFromExit(exit, "Fallback")).toBe("Could not update source");
    expect(messageFromExit(Exit.fail({ reason: "unknown" }), "Fallback")).toBe("Fallback");
  });

  it("reports failed exits with the provided context", () => {
    const exit = Exit.fail({ message: "Could not update source" });
    const calls: Array<{ error: unknown; context: FrontendErrorContext }> = [];

    reportExitFailure(
      (error, context) => {
        calls.push({ error, context });
      },
      exit,
      {
        surface: "sources",
        action: "update",
        message: "Could not update source",
      },
    );

    expect(calls).toHaveLength(1);
    expect(Cause.isCause(calls[0]!.error)).toBe(true);
    expect(calls[0]!.context.surface).toBe("sources");
    expect(calls[0]!.context.action).toBe("update");
  });
});
