/** Provider MCP defaults reach the source of custom imports; OAuth discovery keeps the entered URL. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

const Display = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, content: Schema.optionalKey(Schema.String) }),
  ),
});

layer(HostedLive, { excludeTestServices: true })("MCP URL defaults", (it) => {
  it.effect(scenarios.mcpUrlDefaults.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const source = (url: string) =>
          Effect.gen(function* () {
            const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
              source: {
                kind: "mcp",
                name: `Defaults ${randomUUID().slice(0, 8)}`,
                url,
                auth: { type: "auto" },
              },
            });
            expect(imported.status).toBe(200);
            const app = yield* body(Resource, imported);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            const display = yield* body(
              Display,
              yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/source/display`),
            );
            return display.files.map((file) => file.content ?? "").join("\n");
          });

        const cloudflare = yield* source("https://mcp.cloudflare.com/mcp");
        expect(cloudflare, "Cloudflare exposes its tools instead of code mode").toContain(
          "https://mcp.cloudflare.com/mcp?codemode=false",
        );
        expect(cloudflare, "OAuth discovery keeps the entered URL").toContain(
          '"https://mcp.cloudflare.com/mcp"',
        );
        expect(yield* source("https://mcp.posthog.com/mcp")).toContain(
          "https://mcp.posthog.com/mcp?mode=tools",
        );
      }),
    ),
  );
});
