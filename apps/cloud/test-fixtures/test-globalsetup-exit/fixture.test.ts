import { expect, it } from "@effect/vitest";

it("exercises the global-setup exit path", () => {
  if (process.env.TEST_GLOBALSETUP_SHOULD_PASS === "true") return;

  expect("deliberate failure").toBe("reported as success");
});
