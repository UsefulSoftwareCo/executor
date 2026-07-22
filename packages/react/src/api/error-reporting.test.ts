// oxlint-disable executor/no-error-constructor -- boundary: tests construct plain browser Errors as fixtures for the Sentry capture boundary
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import {
  frontendErrorCapturePayload,
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
    const exit = Exit.fail({ message: "Could not update integration" });

    expect(messageFromExit(exit, "Fallback")).toBe("Could not update integration");
    expect(messageFromExit(Exit.fail({ reason: "unknown" }), "Fallback")).toBe("Fallback");
  });

  it("reports failed exits with the provided context", () => {
    const exit = Exit.fail({ message: "Could not update integration" });
    const calls: Array<{ error: unknown; context: FrontendErrorContext }> = [];

    reportExitFailure(
      (error, context) => {
        calls.push({ error, context });
      },
      exit,
      {
        surface: "integrations",
        action: "update",
        message: "Could not update integration",
      },
    );

    expect(calls).toHaveLength(1);
    expect(Cause.isCause(calls[0]!.error)).toBe(true);
    expect(calls[0]!.context.surface).toBe("integrations");
    expect(calls[0]!.context.action).toBe("update");
  });

  it("extracts the failed Error from an Effect Cause", () => {
    const original = new Error("GET /api/tools failed with 522");
    original.stack = "Error: GET /api/tools failed with 522\n    at loadTools (tools.ts:12:3)";
    const payload = frontendErrorCapturePayload(Cause.fail(original));

    expect(payload.exception).toBe(original);
    expect(payload.exception.message).toBe("GET /api/tools failed with 522");
    expect(payload.exception.stack).toContain("loadTools");
    expect(payload.causePretty).toContain("GET /api/tools failed with 522");
  });

  it("builds an Error from a string Effect failure", () => {
    const payload = frontendErrorCapturePayload(
      Cause.fail("GET /api/integrations failed with 522"),
    );

    expect(payload.exception).toBeInstanceOf(Error);
    expect(payload.exception.message).toContain("GET /api/integrations failed with 522");
    expect(payload.exception.stack).toContain("GET /api/integrations failed with 522");
    expect(payload.causePretty).toContain("GET /api/integrations failed with 522");
  });

  it("extracts the defect Error from an Effect Cause", () => {
    const defect = new TypeError("render crashed");
    defect.stack = "TypeError: render crashed\n    at renderWidget (widget.tsx:40:5)";
    const payload = frontendErrorCapturePayload(Cause.die(defect));

    expect(payload.exception).toBe(defect);
    expect(payload.exception.message).toBe("render crashed");
    expect(payload.exception.stack).toContain("renderWidget");
    expect(payload.causePretty).toContain("render crashed");
  });

  it("unwraps a Cause that arrives wrapped as a defect of another Cause", () => {
    // The production chain: runPromise squashes an exit whose defect is itself
    // a Cause, so the capture boundary receives Die(CauseImpl).
    const original = new Error("GET /api/connections failed with 522");
    original.stack =
      "Error: GET /api/connections failed with 522\n    at loadConnections (connections.ts:9:2)";
    const payload = frontendErrorCapturePayload(Cause.die(Cause.fail(original)));

    expect(payload.exception).toBeInstanceOf(Error);
    expect(payload.exception.message).toContain("GET /api/connections failed with 522");
    expect(payload.exception.message).not.toContain("CauseImpl");
    expect(payload.causePretty).toContain("GET /api/connections failed with 522");
  });

  it("unwraps a record carrying a Cause on its cause property", () => {
    const original = new Error("wrapped cause failure");
    const payload = frontendErrorCapturePayload({ cause: Cause.fail(original) });

    expect(payload.exception).toBe(original);
    expect(payload.causePretty).toContain("wrapped cause failure");
  });

  it("passes a plain Error through unchanged", () => {
    const original = new Error("plain browser error");
    original.stack = "Error: plain browser error\n    at onClick (button.tsx:7:1)";
    const payload = frontendErrorCapturePayload(original);

    expect(payload.exception).toBe(original);
    expect(payload.exception.message).toBe("plain browser error");
    expect(payload.exception.stack).toContain("onClick");
    expect(payload.causePretty).toBeNull();
  });

  it("builds an Error from a non-Cause non-Error value", () => {
    const payload = frontendErrorCapturePayload({ path: "/api/connections", status: 522 });

    expect(payload.exception).toBeInstanceOf(Error);
    expect(payload.exception.message).toContain("/api/connections");
    expect(payload.exception.message).toContain("522");
    expect(payload.exception.stack).toContain("Non-Error frontend exception");
    expect(payload.causePretty).toBeNull();
  });
});
