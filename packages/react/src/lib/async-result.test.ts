import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { isAsyncResultLoading } from "./async-result";

describe("isAsyncResultLoading", () => {
  it("treats initial and waiting async results as loading", () => {
    expect(isAsyncResultLoading(AsyncResult.initial())).toBe(true);
    expect(isAsyncResultLoading(AsyncResult.initial(true))).toBe(true);
    expect(isAsyncResultLoading(AsyncResult.success(["cached"], { waiting: true }))).toBe(true);
  });

  it("does not treat settled success or failure as loading", () => {
    expect(isAsyncResultLoading(AsyncResult.success(["ready"]))).toBe(false);
    expect(isAsyncResultLoading(AsyncResult.failure(Cause.fail("boom")))).toBe(false);
  });
});
