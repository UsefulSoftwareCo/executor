// The supervised daemon's durability as a WATCHABLE terminal recording: register
// a REAL integration, REBOOT the daemon's machine for real (the on-screen
// spinner runs for the actual reboot), then show the integration still there.
// Same assertions as restart-persistence — but filmed, so you can press play
// instead of trusting a green check. Runs against the cli-* VM targets.
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";

import { withChatTheater } from "../src/clients/chat-theater";
import { scenario } from "../src/scenario";
import { Api, Cli, Restart, RunDir, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

/** Inline OpenAPI 3 spec with a single GET /ping (its server is never called). */
const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Reboot Lifecycle API", version: "1.0.0" },
  servers: [{ url: "http://127.0.0.1:59998" }],
  paths: {
    "/ping": {
      get: {
        operationId: "getPing",
        summary: "Liveness ping",
        responses: { "200": { description: "pong" } },
      },
    },
  },
});

scenario(
  "Supervised daemon · an integration survives a real machine reboot (recorded)",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const restart = yield* Restart;
    const { client } = yield* Api;
    const cli = yield* Cli;
    const runDir = yield* RunDir;

    const slug = `reboot-film-${randomBytes(4).toString("hex")}`;

    yield* withChatTheater(
      cli,
      { title: "executor — supervised daemon", record: join(runDir, "terminal.cast") },
      (chat) =>
        Effect.gen(function* () {
          yield* chat.user("If this machine reboots, do my connected integrations survive?");
          yield* chat.assistant(
            "Let's prove it — register a real integration, reboot the daemon's machine for real, then check it's still there.",
          );

          const before = yield* client(api, yield* target.newIdentity());

          const added = yield* chat.tool(
            {
              name: "executor call executor.openapi.addSpec",
              input: `slug: ${slug}\nspec: inline OpenAPI (GET /ping)`,
              result: (a) => `registered — ${a.toolCount} tool(s)`,
            },
            before.openapi.addSpec({
              payload: {
                spec: { kind: "blob", value: pingSpec },
                slug,
                authenticationTemplate: [],
              },
            }),
          );
          expect(added.toolCount, "the spec registered with tools").toBeGreaterThan(0);

          const listed = yield* chat.tool(
            {
              name: "executor tools sources",
              result: (rows) =>
                rows.map((r) => String(r.slug)).includes(slug) ? `${slug} is listed` : "NOT listed",
            },
            before.integrations.list(),
          );
          expect(
            listed.map((i) => String(i.slug)),
            "listed before the reboot",
          ).toContain(slug);

          // The spinner here runs for the ENTIRE real reboot — the supervised
          // service must auto-start at boot for this to ever return.
          yield* chat.tool(
            {
              name: "reboot the daemon's machine",
              input: "guest OS reboot — the OS service manager must auto-start the daemon at boot",
              result: () => "back online; daemon auto-started",
            },
            restart(),
          );

          const after = yield* client(api, yield* target.newIdentity());
          yield* Effect.ensuring(
            Effect.gen(function* () {
              const survived = yield* chat.tool(
                {
                  name: "executor tools sources",
                  result: (rows) =>
                    rows.map((r) => String(r.slug)).includes(slug)
                      ? `${slug} SURVIVED the reboot`
                      : "VANISHED",
                },
                after.integrations.list(),
              );
              expect(
                survived.map((i) => String(i.slug)),
                "survived the reboot",
              ).toContain(slug);
              yield* chat.assistant(
                "It survived — the OS restarted the daemon at boot and its data was intact.",
              );
            }),
            // Shared guest, but ephemeral; still, never leave the spec behind.
            after.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
          );
        }),
    );
  }),
);
