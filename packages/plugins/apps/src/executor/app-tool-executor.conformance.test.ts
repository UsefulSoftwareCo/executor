import { describe, it } from "@effect/vitest";

import { makeInProcessAppToolExecutor } from "./app-tool-executor";
import { isWorkerdAvailable, makeWorkerdAppToolExecutor } from "./workerd-app-tool-executor";
import { appToolExecutorConformance } from "../testing/conformance";

appToolExecutorConformance("in-process", makeInProcessAppToolExecutor);

if (isWorkerdAvailable()) {
  appToolExecutorConformance("workerd", makeWorkerdAppToolExecutor);
} else {
  describe("workerd app tool executor conformance", () => {
    it.skip("skipped because the workerd binary is unavailable on this platform", () => {});
  });
}
