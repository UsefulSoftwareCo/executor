import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeCliSurface } from "../src/surfaces/cli";

it.live("terminal E2E sessions force product telemetry off", () =>
  makeCliSurface()
    .session(
      [
        process.execPath,
        "-e",
        "console.log([process.env.DO_NOT_TRACK, process.env.EXECUTOR_DISABLE_ANALYTICS, process.env.EXECUTOR_DISABLE_INTEGRATIONS_FETCH].join('|'))",
      ],
      (terminal) =>
        terminal.screen
          .waitUntil((screen) => screen.text.includes("1|1|1"), { timeoutMs: 5_000 })
          .then((screen) => expect(screen.text).toContain("1|1|1")),
      {
        env: {
          DO_NOT_TRACK: "0",
          EXECUTOR_DISABLE_ANALYTICS: "0",
          EXECUTOR_DISABLE_INTEGRATIONS_FETCH: "0",
        },
      },
    )
    .pipe(Effect.timeout("10 seconds")),
);
