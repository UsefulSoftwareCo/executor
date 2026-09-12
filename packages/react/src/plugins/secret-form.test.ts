import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";

import { InternalError } from "@executor-js/sdk/shared";

import { credentialSaveErrorMessage } from "./secret-form";

describe("credentialSaveErrorMessage", () => {
  it("shows retry guidance and the correlation id for retryable saves", () => {
    const exit = Exit.fail(new InternalError({ traceId: "trace-123", retryable: true }));

    expect(credentialSaveErrorMessage(exit)).toBe(
      "The credential save didn't complete. Try again. Reference ID: trace-123",
    );
  });

  it("keeps unexpected failures opaque", () => {
    const exit = Exit.fail(new InternalError({ traceId: "trace-500" }));

    expect(credentialSaveErrorMessage(exit)).toBe("Failed to save credential");
  });
});
