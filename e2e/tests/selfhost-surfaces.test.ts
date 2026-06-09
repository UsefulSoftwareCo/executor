// Shared e2e tests: drive the self-host through its public surfaces, Effect Vitest.
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { composePluginApi } from "@executor-js/api/server";
import { selfHostPlugins } from "@executor-js/host-selfhost/plugins";
import { makeApiClient } from "../src/surfaces/api";
import { runCli } from "../src/surfaces/cli";

const BASE = process.env.TESTKIT_BASE_URL ?? "http://localhost:5173";
const CREDS = { email: "admin@demo.test", password: "demo-password-12345" };
const selfHostApi = composePluginApi(selfHostPlugins);

layer(FetchHttpClient.layer)("self-host surfaces", (it) => {
  // API surface — typed client over the wire
  it.effect("API · typed HttpApiClient lists tools", () =>
    Effect.gen(function* () {
      const client = yield* makeApiClient(selfHostApi, { baseUrl: BASE, ...CREDS });
      const tools = yield* client.tools.list();
      expect(tools.length).toBeGreaterThan(0);
    }),
  );

  // CLI/TUI surface — drive a real PTY
  it.effect("CLI · node REPL evaluates 6 * 7", () =>
    Effect.gen(function* () {
      const out = yield* runCli(["node", "-i"], async (s) => {
        await s.screen.waitForText(">");
        await s.keyboard.type("6 * 7");
        await s.keyboard.press("Enter");
        await s.screen.waitForText("42");
        return s.screen.text();
      });
      expect(out).toContain("42");
    }),
  );
});
