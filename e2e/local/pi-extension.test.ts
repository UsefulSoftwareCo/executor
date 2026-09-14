// The local half of the Pi setup the README documents. The hosted half is
// covered cross-target (scenarios/pi-extension.test.ts) with an API key in
// `EXECUTOR_API_KEY`; a local or desktop Executor has no API keys page, and
// hands out its own bearer token instead — `EXECUTOR_AUTH_TOKEN`.
//
// Nothing about that token is special to the extension, which is the point: the
// only way to know a local user can follow the README is to boot a real
// `executor web`, take the token it prints, and drive the installed extension
// against it exactly as the docs say.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { installPi, piToolText } from "../src/clients/pi";
import { scenario } from "../src/scenario";
import { Cli, RunDir } from "../src/services";
import { withLocalServer } from "./local-server";

scenario(
  "Local · the Pi extension reaches a local Executor with EXECUTOR_AUTH_TOKEN",
  // Strictly greater than withLocalServer's 240s boot wait, so a stuck boot
  // surfaces its terminal tail instead of vitest's generic timeout.
  { timeout: 300_000 },
  Effect.gen(function* () {
    const cli = yield* Cli;
    const runDir = yield* RunDir;

    yield* withLocalServer(cli, runDir, (server) =>
      Effect.gen(function* () {
        const pi = yield* Effect.promise(() =>
          installPi({
            EXECUTOR_MCP_URL: new URL("/mcp", server.origin).toString(),
            EXECUTOR_AUTH_TOKEN: server.token,
          }),
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => pi.close()));

        // `/executor` is the check a user runs after following the README.
        const [status] = yield* Effect.promise(() => pi.runCommand("/executor"));
        expect(status?.type, `the local server accepted the token: ${status?.message}`).toBe(
          "info",
        );
        expect(status?.message, "it reports the local endpoint").toContain(server.origin);

        const executed = yield* Effect.promise(() =>
          pi.callTool("executor_execute", { code: "return 21 * 2;" }),
        );
        expect(piToolText(executed), "the local sandbox ran the code").toContain("42");
      }).pipe(Effect.scoped),
    );
  }),
);
