import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";

const source = (answer: string) => ({
  path: "index.ts",
  content: `import { defineApp, query, object, string, router } from "apps";
export const answer = query({ input: object({}), output: string() }, async () => ${JSON.stringify(answer)});
export default defineApp({}, { tools: router({ answer }) });`,
});
const Deployed = Schema.Struct({
  id: Schema.String,
  activeVersion: Schema.String,
  activeDeployment: Schema.String,
});
const Summaries = Schema.Array(Schema.Struct({ id: Schema.String }));
const Source = Schema.Struct({
  id: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const Catalog = Schema.Struct({ version: Schema.String, deployment: Schema.String });

layer(HostedLive, { excludeTestServices: true })("Version API compatibility", (it) => {
  it.effect(scenarios.versionApiCompatibility.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const created = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Versions ${randomUUID().slice(0, 8)}`,
          files: [source("first"), appsManifest],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const first = yield* body(Deployed, created);
        expect(first.activeDeployment).toBe(first.activeVersion);
        const path = `${prefix}/apps/${first.id}`;
        const updated = yield* saveAndDeploy(actors.owner, path, {
          files: [source("second"), appsManifest],
        });
        expect(updated.status, JSON.stringify(updated.body)).toBe(200);
        const { app: second } = yield* body(Schema.Struct({ app: Deployed }), updated);
        expect(second.activeVersion).not.toBe(first.activeVersion);

        const versions = yield* api.request(actors.owner, "GET", `${path}/versions`);
        const deployments = yield* api.request(actors.owner, "GET", `${path}/deployments`);
        expect(versions.status).toBe(200);
        expect(deployments.status).toBe(200);
        const listed = yield* body(Summaries, versions);
        expect(yield* body(Summaries, deployments)).toEqual(listed);
        expect(listed.map((version) => version.id).sort()).toEqual(
          [first.activeVersion, second.activeVersion].sort(),
        );

        for (const name of ["version", "deployment"]) {
          const read = yield* api.request(
            actors.owner,
            "GET",
            `${path}/source?${name}=${first.activeVersion}`,
          );
          expect(read.status, name).toBe(200);
          const retained = yield* body(Source, read);
          expect(retained.id, name).toBe(first.activeVersion);
          expect(retained.files.find((file) => file.path === "index.ts")?.content).toContain(
            '"first"',
          );
        }
        for (const segment of ["versions", "deployments"]) {
          const file = yield* api.request(
            actors.owner,
            "GET",
            `${path}/${segment}/${first.activeVersion}/display/file?path=index.ts`,
          );
          expect(file.status, segment).toBe(200);
        }

        const tools = yield* api.request(
          actors.owner,
          "GET",
          `${path}/tools?deployment=${second.activeVersion}`,
        );
        expect(tools.status, JSON.stringify(tools.body)).toBe(200);
        const catalog = yield* body(Catalog, tools);
        expect(catalog).toMatchObject({
          version: second.activeVersion,
          deployment: second.activeVersion,
        });
        const retired = yield* api.request(
          actors.owner,
          "GET",
          `${path}/tools?deployment=${first.activeVersion}`,
        );
        expect(retired.status, JSON.stringify(retired.body)).toBe(404);
        expect(retired.body).toMatchObject({ _tag: "VersionNotFound" });

        const stale = yield* api.request(actors.owner, "POST", `${path}/activate`, {
          deployment: first.activeVersion,
          expectedDeployment: first.activeVersion,
        });
        expect(stale.status, JSON.stringify(stale.body)).toBe(409);
        expect(stale.body).toMatchObject({ _tag: "AppVersionChanged" });
        const activated = yield* api.request(actors.owner, "POST", `${path}/activate`, {
          deployment: first.activeVersion,
          expectedDeployment: second.activeVersion,
        });
        expect(activated.status, JSON.stringify(activated.body)).toBe(200);
        expect(yield* body(Deployed, activated)).toMatchObject({
          activeVersion: first.activeVersion,
          activeDeployment: first.activeVersion,
        });
        const reactivated = yield* api.request(actors.owner, "POST", `${path}/activate`, {
          version: second.activeVersion,
          expectedVersion: first.activeVersion,
        });
        expect(reactivated.status, JSON.stringify(reactivated.body)).toBe(200);
        expect((yield* body(Deployed, reactivated)).activeVersion).toBe(second.activeVersion);
      }),
    ),
  );
});
