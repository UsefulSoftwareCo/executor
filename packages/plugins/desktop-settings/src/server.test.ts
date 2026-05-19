import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { createExecutor } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";

import { desktopSettingsPlugin } from "./server";

describe("desktopSettingsPlugin", () => {
  it.effect("returns a browser handoff URL for Desktop-only settings", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        plugins: [desktopSettingsPlugin({ webBaseUrl: "http://executor.test/base/" })] as const,
      });
      const executor = yield* createExecutor(config);

      const result = yield* executor.tools.invoke("executor.desktopSettings.openSettings", {});

      expect(result).toEqual({
        url: "http://executor.test/base/plugins/desktop-settings/",
        flow: "Open this URL in Executor Desktop. The user can change port/auth or regenerate the password there; then rerun discovery/list tools to observe the restarted server.",
      });

      yield* executor.close();
      yield* Effect.promise(() => config.testDb.close());
    }),
  );
});
