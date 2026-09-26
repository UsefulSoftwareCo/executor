/** Generated package metadata and installed labels remain independent through real imports. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Workspace } from "../support/app-authoring.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { publicTemplateUpstream } from "../support/template-upstream.ts";

const Package = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    dependencies: Schema.Record(Schema.String, Schema.String),
  }),
);

layer(HostedLive, { excludeTestServices: true })("App package metadata", (it) => {
  it.effect(scenarios.appPackageMetadata.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        // The public MCP server is a fixture; quick add still checks it through the real server.
        const origin = yield* publicTemplateUpstream;
        const suffix = randomUUID().slice(0, 8);
        const prefix = `/api/organizations/${actors.organization.id}`;
        for (const fixture of [
          {
            label: "display",
            name: `MCP Notes ${suffix}`,
            package: `@${actors.organization.slug}/mcp-notes-${suffix}`,
          },
          {
            label: "scoped",
            name: `@fixture/mcp-${suffix}`,
            package: `@${actors.organization.slug}/mcp-${suffix}`,
          },
        ] as const) {
          const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
            source: { kind: "mcp", name: fixture.name, url: `${origin}/mcp` },
          });
          expect(imported.status, JSON.stringify(imported.body)).toBe(200);
          const app = yield* body(App, imported);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(
              Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
              Effect.orDie,
            ),
          );
          expect(app.name).toBe(fixture.name);
          const path = `${prefix}/apps/${app.id}`;
          const before = yield* body(
            Workspace,
            yield* api.request(actors.owner, "GET", `${path}/workspace`),
          );
          const manifest = before.files.find((file) => file.path === "package.json");
          expect(manifest, `${fixture.label} name retains package metadata`).toBeDefined();
          if (manifest === undefined) return yield* Effect.die("Package manifest missing");
          const metadata = yield* Schema.decodeUnknownEffect(Package)(manifest.content);
          expect(metadata.name).toBe(fixture.package);
          expect(metadata.dependencies).toEqual({ "@modelcontextprotocol/sdk": "1.30.0" });
          const source = before.files.find((file) => file.path === "index.ts");
          expect(source?.content).not.toMatch(/\bname\s*:/);

          const renamed = yield* body(
            App,
            yield* api.request(actors.owner, "PATCH", `${path}/name`, {
              name: `My ${fixture.label} ${suffix}`,
            }),
          );
          expect(renamed.name).toBe(`My ${fixture.label} ${suffix}`);
          const after = yield* body(
            Workspace,
            yield* api.request(actors.owner, "GET", `${path}/workspace`),
          );
          expect(after).toEqual(before);
        }
      }),
    ),
  );
});
