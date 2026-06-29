import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ToolAddress } from "@executor-js/sdk";
import { makeTestExecutor } from "@executor-js/sdk/testing";

import { desktopSettingsPlugin } from "./server";

describe("desktopSettingsPlugin", () => {
  it.effect("returns a browser handoff URL for Desktop-only settings", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [desktopSettingsPlugin({ webBaseUrl: "http://executor.test/base/" })] as const,
      });

      const result = yield* executor.execute(
        ToolAddress.make("executor.desktopSettings.openSettings"),
        {},
      );

      expect(result).toEqual({
        url: "http://executor.test/base/plugins/desktop-settings/",
        flow: "Open this URL in Executor Desktop. The user can inspect the active server connection, change port/auth, or regenerate the password there; then rerun discovery/list tools to observe the refreshed connection.",
      });
    }),
  );
});
