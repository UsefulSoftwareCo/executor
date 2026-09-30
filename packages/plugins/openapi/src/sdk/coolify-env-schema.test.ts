import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import { ConnectionName, createExecutor, IntegrationSlug } from "@executor-js/sdk";
import {
  makeTestConfig,
  memoryCredentialsPlugin,
  serveTestHttpApp,
} from "@executor-js/sdk/testing";

import { addOpenApiTestConnection } from "../testing";
import { repairCoolifyApplicationEnvInputSchema } from "./backing";
import { openApiPlugin } from "./plugin";

type CapturedRequest = {
  readonly method: string;
  readonly url: string;
  readonly body: string;
};

const environmentVariableProperties = {
  key: { type: "string" },
  value: { type: "string" },
  is_preview: { type: "boolean" },
  is_literal: { type: "boolean" },
  is_multiline: { type: "boolean" },
  is_shown_once: { type: "boolean" },
};

const nonTargetOperationName = "applications.updateEnvironmentMetadataByApplicationUuid";

const environmentVariableRequestSchema = () => ({
  type: "object",
  properties: { ...environmentVariableProperties },
});

const bulkEnvironmentVariableRequestSchema = () => ({
  type: "object",
  properties: {
    data: {
      type: "array",
      items: environmentVariableRequestSchema(),
    },
  },
});

const operation = (operationId: string, bodySchema: Record<string, unknown>) => ({
  operationId,
  tags: ["Applications"],
  parameters: [
    {
      name: "uuid",
      in: "path",
      required: true,
      schema: { type: "string" },
    },
  ],
  requestBody: {
    required: true,
    content: {
      "application/json": {
        schema: bodySchema,
      },
    },
  },
  responses: {
    "200": {
      description: "OK",
      content: {
        "application/json": {
          schema: { type: "object" },
        },
      },
    },
  },
});

const coolifySpec = (baseUrl: string) =>
  JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Coolify API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/applications/{uuid}/envs": {
        post: operation("createEnvByApplicationUuid", environmentVariableRequestSchema()),
        patch: operation("updateEnvByApplicationUuid", environmentVariableRequestSchema()),
      },
      "/applications/{uuid}/envs/bulk": {
        patch: operation("updateEnvsByApplicationUuid", bulkEnvironmentVariableRequestSchema()),
      },
      // This has the same legacy body shape but is not one of Coolify's
      // lifecycle-compatible endpoints. It proves the repair is not a broad
      // "any applications env tool" rewrite.
      "/applications/{uuid}/envs/metadata": {
        patch: operation(
          "updateEnvironmentMetadataByApplicationUuid",
          environmentVariableRequestSchema(),
        ),
      },
    },
  });

const tenantLocalCollisionSpec = (baseUrl: string) =>
  JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Tenant-local API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/applications/{uuid}/envs": {
        patch: operation("updateEnvByApplicationUuid", {
          type: "object",
          properties: {
            ...environmentVariableProperties,
            enabled: { type: "boolean" },
          },
        }),
      },
    },
  });

const legacySingleInputSchema = () => ({
  type: "object",
  properties: {
    uuid: { type: "string" },
    body: environmentVariableRequestSchema(),
  },
  required: ["uuid", "body"],
  additionalProperties: false,
});

const legacyBatchInputSchema = () => ({
  type: "object",
  properties: {
    uuid: { type: "string" },
    body: bulkEnvironmentVariableRequestSchema(),
  },
  required: ["uuid", "body"],
  additionalProperties: false,
});

const accepted = {
  onElicitation: () => Effect.succeed({ action: "accept" as const, content: {} }),
};

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const serveCoolifyFixture = () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<readonly CapturedRequest[]>([]);
    const server = yield* serveTestHttpApp((request) =>
      Effect.gen(function* () {
        const body = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));
        yield* Ref.update(requests, (all) => [
          ...all,
          {
            method: request.method,
            url: request.url ?? "/",
            body,
          },
        ]);
        return HttpServerResponse.jsonUnsafe({ ok: true });
      }),
    );

    return {
      ...server,
      specJson: coolifySpec(server.baseUrl),
      requests: Ref.get(requests),
    };
  });

describe("Coolify application environment variable schema compatibility", () => {
  it.effect("republishes legacy bindings with lifecycle flags and sends them unchanged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* serveCoolifyFixture();
        const plugins = [
          openApiPlugin({ httpClientLayer: fixture.httpClientLayer }),
          memoryCredentialsPlugin(),
        ] as const;
        const config = makeTestConfig({ plugins });
        const executor = yield* createExecutor(config);
        const connection = yield* addOpenApiTestConnection(executor, fixture, {
          slug: "coolify",
        });

        const legacySchemas = {
          "applications.createEnvByApplicationUuid": legacySingleInputSchema(),
          "applications.updateEnvByApplicationUuid": legacySingleInputSchema(),
          "applications.updateEnvsByApplicationUuid": legacyBatchInputSchema(),
        } as const;

        const fresh = yield* Effect.promise(() =>
          config.db.findMany("tool", {
            where: (b) =>
              b.and(b("integration", "=", "coolify"), b("connection", "=", connection.connection)),
          }),
        );
        expect(fresh).toHaveLength(4);
        for (const name of Object.keys(legacySchemas)) {
          const row = fresh.find((candidate) => candidate.name === name);
          expect(encodeJson(row?.input_schema)).toContain('"is_runtime"');
          expect(encodeJson(row?.input_schema)).toContain('"is_buildtime"');
        }
        const freshNonTarget = fresh.find((candidate) => candidate.name === nonTargetOperationName);
        expect(encodeJson(freshNonTarget?.input_schema)).not.toContain('"is_runtime"');
        expect(encodeJson(freshNonTarget?.input_schema)).not.toContain('"is_buildtime"');

        for (const [name, inputSchema] of Object.entries(legacySchemas)) {
          yield* Effect.promise(() =>
            config.db.updateMany("tool", {
              where: (b) =>
                b.and(
                  b("integration", "=", "coolify"),
                  b("connection", "=", connection.connection),
                  b("name", "=", name),
                ),
              set: { input_schema: inputSchema },
            }),
          );
        }

        // A deployed Executor must describe old persisted rows correctly before
        // anyone manually refreshes a connection.
        for (const name of Object.keys(legacySchemas)) {
          const schema = yield* executor.tools.schema(connection.address(name));
          expect(schema?.inputTypeScript).toContain("is_runtime?: boolean");
          expect(schema?.inputTypeScript).toContain("is_buildtime?: boolean");
        }
        const nonTargetSchema = yield* executor.tools.schema(
          connection.address(nonTargetOperationName),
        );
        expect(nonTargetSchema?.inputTypeScript).not.toContain("is_runtime?: boolean");
        expect(nonTargetSchema?.inputTypeScript).not.toContain("is_buildtime?: boolean");

        const stillLegacy = yield* Effect.promise(() =>
          config.db.findMany("tool", {
            where: (b) =>
              b.and(b("integration", "=", "coolify"), b("connection", "=", connection.connection)),
          }),
        );
        for (const name of Object.keys(legacySchemas)) {
          const row = stillLegacy.find((candidate) => candidate.name === name);
          const schema = encodeJson(row?.input_schema);
          expect(schema).not.toContain('"is_runtime"');
          expect(schema).not.toContain('"is_buildtime"');
        }

        // Refresh also writes the repaired schema back into the persisted tool
        // catalog so future reads do not depend on the legacy projection.
        yield* executor.connections.refresh({
          owner: connection.owner,
          integration: IntegrationSlug.make(connection.slug),
          name: ConnectionName.make(connection.connection),
        });

        const republished = yield* Effect.promise(() =>
          config.db.findMany("tool", {
            where: (b) =>
              b.and(b("integration", "=", "coolify"), b("connection", "=", connection.connection)),
          }),
        );
        expect(republished).toHaveLength(4);
        for (const name of Object.keys(legacySchemas)) {
          const row = republished.find((candidate) => candidate.name === name);
          const schema = encodeJson(row?.input_schema);
          expect(schema).toContain('"is_runtime"');
          expect(schema).toContain('"is_buildtime"');
        }
        const republishedNonTarget = republished.find(
          (candidate) => candidate.name === nonTargetOperationName,
        );
        const nonTargetPersistedSchema = encodeJson(republishedNonTarget?.input_schema);
        expect(nonTargetPersistedSchema).not.toContain('"is_runtime"');
        expect(nonTargetPersistedSchema).not.toContain('"is_buildtime"');

        yield* executor.execute(
          connection.address("applications.createEnvByApplicationUuid"),
          {
            uuid: "app-1",
            body: {
              key: "CREATE_ONLY",
              value: "one",
              is_runtime: true,
              is_buildtime: false,
            },
          },
          accepted,
        );
        yield* executor.execute(
          connection.address("applications.updateEnvByApplicationUuid"),
          {
            uuid: "app-1",
            body: {
              key: "UPDATE_ONLY",
              value: "two",
              is_runtime: false,
              is_buildtime: true,
            },
          },
          accepted,
        );
        yield* executor.execute(
          connection.address("applications.updateEnvsByApplicationUuid"),
          {
            uuid: "app-1",
            body: {
              data: [
                {
                  key: "BATCH_ONLY",
                  value: "three",
                  is_runtime: false,
                  is_buildtime: false,
                },
              ],
            },
          },
          accepted,
        );

        const requests = yield* fixture.requests;
        const writes = requests.filter(
          (request) => request.method === "POST" || request.method === "PATCH",
        );
        expect(writes).toHaveLength(3);
        expect(writes.map((request) => decodeJson(request.body))).toEqual([
          {
            key: "CREATE_ONLY",
            value: "one",
            is_runtime: true,
            is_buildtime: false,
          },
          {
            key: "UPDATE_ONLY",
            value: "two",
            is_runtime: false,
            is_buildtime: true,
          },
          {
            data: [
              {
                key: "BATCH_ONLY",
                value: "three",
                is_runtime: false,
                is_buildtime: false,
              },
            ],
          },
        ]);
      }),
    ),
  );

  it.effect("leaves a tenant-local integration named coolify untouched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* serveCoolifyFixture();
        const plugins = [
          openApiPlugin({ httpClientLayer: fixture.httpClientLayer }),
          memoryCredentialsPlugin(),
        ] as const;
        const config = makeTestConfig({ plugins });
        const executor = yield* createExecutor(config);
        const connection = yield* addOpenApiTestConnection(
          executor,
          { ...fixture, specJson: tenantLocalCollisionSpec(fixture.baseUrl) },
          { slug: "coolify" },
        );
        const toolName = "applications.updateEnvByApplicationUuid";

        const fresh = yield* Effect.promise(() =>
          config.db.findFirst("tool", {
            where: (b) =>
              b.and(
                b("integration", "=", "coolify"),
                b("connection", "=", connection.connection),
                b("name", "=", toolName),
              ),
          }),
        );
        expect(encodeJson(fresh?.input_schema)).not.toContain('"is_runtime"');
        expect(encodeJson(fresh?.input_schema)).not.toContain('"is_buildtime"');

        const projected = yield* executor.tools.schema(connection.address(toolName));
        expect(projected?.inputTypeScript).not.toContain("is_runtime?: boolean");
        expect(projected?.inputTypeScript).not.toContain("is_buildtime?: boolean");

        yield* executor.connections.refresh({
          owner: connection.owner,
          integration: IntegrationSlug.make(connection.slug),
          name: ConnectionName.make(connection.connection),
        });
        const refreshed = yield* Effect.promise(() =>
          config.db.findFirst("tool", {
            where: (b) =>
              b.and(
                b("integration", "=", "coolify"),
                b("connection", "=", connection.connection),
                b("name", "=", toolName),
              ),
          }),
        );
        expect(encodeJson(refreshed?.input_schema)).not.toContain('"is_runtime"');
        expect(encodeJson(refreshed?.input_schema)).not.toContain('"is_buildtime"');
      }),
    ),
  );

  it("leaves a target-named operation on another route untouched", () => {
    const legacy = legacySingleInputSchema();
    expect(
      repairCoolifyApplicationEnvInputSchema("applications.updateEnvByApplicationUuid", legacy, {
        method: "patch",
        pathTemplate: "/tenant-applications/{uuid}/envs",
        parameters: [{ name: "uuid", location: "path", required: true }],
      }),
    ).toBe(legacy);
  });

  it("adds only the lifecycle field still absent from a matching upstream schema", () => {
    const partial = legacySingleInputSchema();
    const body = partial.properties.body as {
      properties: Record<string, unknown>;
    };
    body.properties.is_runtime = { type: "boolean" };

    const repaired = repairCoolifyApplicationEnvInputSchema(
      "applications.updateEnvByApplicationUuid",
      partial,
      {
        method: "patch",
        pathTemplate: "/applications/{uuid}/envs",
        parameters: [{ name: "uuid", location: "path", required: true }],
      },
    ) as {
      properties: { body: { properties: Record<string, unknown> } };
    };

    expect(repaired.properties.body.properties.is_runtime).toEqual({ type: "boolean" });
    expect(repaired.properties.body.properties.is_buildtime).toEqual({
      type: "boolean",
      description: "Whether this environment variable is available while the application builds.",
    });
  });

  it("is inert once Coolify publishes the lifecycle fields itself", () => {
    const current = {
      type: "object",
      properties: {
        uuid: { type: "string" },
        body: {
          type: "object",
          properties: {
            ...environmentVariableProperties,
            is_runtime: { type: "boolean" },
            is_buildtime: { type: "boolean" },
          },
        },
      },
      required: ["uuid", "body"],
      additionalProperties: false,
    };

    expect(
      repairCoolifyApplicationEnvInputSchema("applications.updateEnvByApplicationUuid", current, {
        method: "patch",
        pathTemplate: "/applications/{uuid}/envs",
        parameters: [{ name: "uuid", location: "path", required: true }],
      }),
    ).toBe(current);
  });
});
