import { describe, expect, it } from "@effect/vitest";

import { classifyThrownExecuteError } from "./error-kind";

describe("classifyThrownExecuteError", () => {
  it("maps built-in JS error names to their kinds", () => {
    expect(classifyThrownExecuteError("SyntaxError")).toBe("syntax_error");
    expect(classifyThrownExecuteError("TypeError")).toBe("type_error");
    expect(classifyThrownExecuteError("ReferenceError")).toBe("reference_error");
    expect(classifyThrownExecuteError("RangeError")).toBe("range_error");
    expect(classifyThrownExecuteError("DataCloneError")).toBe("serialization_error");
  });

  it("maps runtime-tagged names to their kinds", () => {
    expect(classifyThrownExecuteError("ExecutionToolError")).toBe("tool_error");
    expect(classifyThrownExecuteError("ExecutionTimeoutError")).toBe("timeout");
  });

  it("treats anything else as the script's own throw", () => {
    expect(classifyThrownExecuteError("Error")).toBe("thrown");
    expect(classifyThrownExecuteError("CustomDomainError")).toBe("thrown");
    expect(classifyThrownExecuteError(null)).toBe("thrown");
    expect(classifyThrownExecuteError(undefined)).toBe("thrown");
  });
});
