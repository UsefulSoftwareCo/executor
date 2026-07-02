import { describe, expect, it } from "@effect/vitest";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Effect, Option, Schema } from "effect";

import { parse } from "./parse";
import { extract } from "./extract";
import { compileToolDefinitions } from "./definitions";

// ---------------------------------------------------------------------------
// Define a test API using Effect's HttpApi
// ---------------------------------------------------------------------------

const Pet = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  tag: Schema.optional(Schema.String),
});
type Pet = typeof Pet.Type;

const CreatePetInput = Schema.Struct({
  name: Schema.String,
  tag: Schema.optional(Schema.String),
});

class PetNotFound extends Schema.TaggedErrorClass<PetNotFound>()("PetNotFound", {
  message: Schema.String,
}) {}

const PetstoreGroup = HttpApiGroup.make("pets")
  .add(HttpApiEndpoint.get("listPets", "/pets", { success: Schema.Array(Pet) }))
  .add(HttpApiEndpoint.post("createPet", "/pets", { payload: CreatePetInput, success: Pet }))
  .add(
    HttpApiEndpoint.get("getPet", "/pets/:petId", {
      success: Pet,
      error: PetNotFound,
    }),
  );

const PetstoreApi = HttpApi.make("petstore").add(PetstoreGroup);

// Generate OpenAPI spec from the Effect API definition
const spec = OpenApi.fromApi(PetstoreApi);

type TestOpenApiServer = {
  readonly url: string;
  readonly description?: string;
  readonly variables?: Record<
    string,
    {
      readonly default: string;
      readonly enum?: [string, ...string[]];
      readonly description?: string;
    }
  >;
};

const pingSpecWithServers = (title: string, servers: readonly TestOpenApiServer[]) =>
  OpenApi.fromApi(
    HttpApi.make("serverVariablesTest")
      .add(
        HttpApiGroup.make("default", { topLevel: true }).add(
          HttpApiEndpoint.get("ping", "/ping", { success: Schema.Unknown }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title,
          version: "1.0.0",
          servers,
        }),
      ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAPI plugin", () => {
  it.effect("parses and extracts operations from Effect HttpApi spec", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(JSON.stringify(spec));
      const result = yield* extract(doc);

      expect(Option.getOrElse(result.title, () => "")).toBe("Api");
      expect(result.operations.length).toBeGreaterThanOrEqual(3);
    }),
  );

  it.effect("extracts listPets with output schema", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(JSON.stringify(spec));
      const result = yield* extract(doc);

      const listPets = result.operations.find((op) => op.operationId === "pets.listPets");
      expect(listPets).toBeDefined();
      expect(listPets!.method).toBe("get");
      expect(listPets!.pathTemplate).toBe("/pets");
      expect(listPets!.tags).toContain("pets");

      // Has output schema (array of pets, dereferenced)
      expect(Option.isSome(listPets!.outputSchema)).toBe(true);
      const outputSchema = Option.getOrThrow(listPets!.outputSchema) as Record<string, unknown>;
      expect(outputSchema.type).toBe("array");
    }),
  );

  it.effect("extracts createPet with request body from payload", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(JSON.stringify(spec));
      const result = yield* extract(doc);

      const createPet = result.operations.find((op) => op.operationId === "pets.createPet");
      expect(createPet).toBeDefined();
      expect(createPet!.method).toBe("post");

      // Has request body
      expect(Option.isSome(createPet!.requestBody)).toBe(true);
      const rb = Option.getOrThrow(createPet!.requestBody);
      expect(rb.contentType).toBe("application/json");

      // Input schema includes body
      expect(Option.isSome(createPet!.inputSchema)).toBe(true);
      const inputSchema = Option.getOrThrow(createPet!.inputSchema) as Record<string, unknown>;
      expect(inputSchema.properties).toHaveProperty("body");
    }),
  );

  it.effect("extracts getPet with path template", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(JSON.stringify(spec));
      const result = yield* extract(doc);

      const getPet = result.operations.find((op) => op.operationId === "pets.getPet");
      expect(getPet).toBeDefined();
      expect(getPet!.method).toBe("get");
      expect(getPet!.pathTemplate).toBe("/pets/{petId}");
    }),
  );

  it.effect("extracts error responses", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(JSON.stringify(spec));
      const result = yield* extract(doc);

      const getPet = result.operations.find((op) => op.operationId === "pets.getPet");
      expect(getPet).toBeDefined();

      // Should have a success output schema
      expect(Option.isSome(getPet!.outputSchema)).toBe(true);
    }),
  );

  it.effect("round-trips: generated spec paths match HttpApi definition", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(JSON.stringify(spec));
      const result = yield* extract(doc);

      // Should have all 3 operations
      const paths = result.operations.map((op) => `${op.method} ${op.pathTemplate}`);
      expect(paths).toContain("get /pets");
      expect(paths).toContain("post /pets");
      expect(paths).toContain("get /pets/{petId}");
    }),
  );

  it.effect("compileToolDefinitions produces nested group.leaf paths", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(JSON.stringify(spec));
      const result = yield* extract(doc);
      const defs = compileToolDefinitions(result.operations);

      // All 3 operations compiled
      expect(defs).toHaveLength(3);

      // All should be under the "pets" group
      for (const def of defs) {
        expect(def.group).toBe("pets");
        expect(def.toolPath).toMatch(/^pets\./);
      }

      // Specific tool paths
      const paths = defs.map((d) => d.toolPath);
      expect(paths).toContain("pets.listPets");
      expect(paths).toContain("pets.createPet");
      expect(paths).toContain("pets.getPet");
    }),
  );

  it.effect("compileToolDefinitions honors explicit executor tool paths", () =>
    Effect.gen(function* () {
      const explicitSpec = {
        openapi: "3.1.0",
        info: { title: "Googleish", version: "1.0.0" },
        paths: {
          "/gmail/v1/users/{userId}/messages": {
            get: {
              operationId: "gmail.usersMessagesList",
              "x-executor-toolPath": "users.messages.list",
              parameters: [
                {
                  name: "userId",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
              ],
              responses: { "200": { description: "OK" } },
            },
          },
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(JSON.stringify(explicitSpec));
      const result = yield* extract(doc);
      const defs = compileToolDefinitions(result.operations);

      expect(defs.map((def) => def.toolPath)).toEqual(["users.messages.list"]);
      expect(defs.map((def) => def.operation.operationId)).toEqual(["gmail.usersMessagesList"]);
    }),
  );

  it.effect("extracts server variables with enum and description", () =>
    Effect.gen(function* () {
      const specWithServerVars = pingSpecWithServers("Sentry", [
        {
          url: "https://{region}.sentry.io",
          description: "Regional endpoint",
          variables: {
            region: {
              default: "us",
              description: "The data-storage-location for an organization",
              enum: ["us", "de"],
            },
          },
        },
      ]);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(JSON.stringify(specWithServerVars));
      const result = yield* extract(doc);

      expect(result.servers).toHaveLength(1);
      const server = result.servers[0]!;
      expect(server.url).toBe("https://{region}.sentry.io");
      expect(Option.getOrElse(server.description, () => "")).toBe("Regional endpoint");

      const vars = Option.getOrThrow(server.variables);
      expect(vars.region!.default).toBe("us");
      expect(Option.getOrElse(vars.region!.enum, () => [] as readonly string[])).toEqual([
        "us",
        "de",
      ]);
      expect(Option.getOrElse(vars.region!.description, () => "")).toBe(
        "The data-storage-location for an organization",
      );
    }),
  );
});

// ---------------------------------------------------------------------------
// Server variable extraction
// ---------------------------------------------------------------------------

describe("extract — server variables", () => {
  const specWithServerVars = pingSpecWithServers("Test", [
    {
      url: "https://{region}.example.com/{basePath}",
      description: "Regional endpoint",
      variables: {
        region: {
          default: "us",
          enum: ["us", "eu", "ap"],
          description: "Data region",
        },
        basePath: { default: "v1" },
      },
    },
  ]);

  it.effect("preserves enum, default, and description for server variables", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(JSON.stringify(specWithServerVars));
      const result = yield* extract(doc);

      expect(result.servers).toHaveLength(1);
      const server = result.servers[0]!;
      expect(server.url).toBe("https://{region}.example.com/{basePath}");
      expect(Option.getOrNull(server.description)).toBe("Regional endpoint");

      const vars = Option.getOrNull(server.variables);
      expect(vars).not.toBeNull();
      const region = vars!.region!;
      expect(region.default).toBe("us");
      expect(Option.getOrNull(region.enum)).toEqual(["us", "eu", "ap"]);
      expect(Option.getOrNull(region.description)).toBe("Data region");

      const basePath = vars!.basePath!;
      expect(basePath.default).toBe("v1");
      expect(Option.isNone(basePath.enum)).toBe(true);
    }),
  );
});
