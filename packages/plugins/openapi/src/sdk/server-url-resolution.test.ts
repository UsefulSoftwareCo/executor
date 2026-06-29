import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { extract } from "./extract";
import { resolveServerUrl } from "./openapi-utils";
import { parse } from "./parse";
import { previewSpec as previewSpecRaw } from "./preview";
import { ServerVariable } from "./types";

const previewSpec = (input: string) =>
  previewSpecRaw(input).pipe(Effect.provide(FetchHttpClient.layer));

const serverVariable = (defaultValue: string): ServerVariable =>
  ServerVariable.make({ default: defaultValue, enum: Option.none(), description: Option.none() });

// ---------------------------------------------------------------------------
// resolveServerUrl — invoke-time template resolution
// ---------------------------------------------------------------------------

describe("resolveServerUrl", () => {
  const vars = {
    tenant: serverVariable("default-tenant"),
    region: serverVariable("us-east-1"),
  };

  it("fills placeholders from variable defaults when no override is given", () => {
    expect(resolveServerUrl("https://{tenant}.{region}.api.example.com", vars, {})).toBe(
      "https://default-tenant.us-east-1.api.example.com",
    );
  });

  it("prefers connection overrides over defaults", () => {
    expect(
      resolveServerUrl("https://{tenant}.{region}.api.example.com", vars, {
        tenant: "acme",
        region: "eu-west-1",
      }),
    ).toBe("https://acme.eu-west-1.api.example.com");
  });

  it("ignores empty overrides and keeps the default", () => {
    expect(
      resolveServerUrl("https://{tenant}.{region}.api.example.com", vars, { tenant: "" }),
    ).toBe("https://default-tenant.us-east-1.api.example.com");
  });

  it("returns a URL with no placeholders unchanged", () => {
    expect(resolveServerUrl("https://api.example.com", undefined, { tenant: "acme" })).toBe(
      "https://api.example.com",
    );
  });
});

// ---------------------------------------------------------------------------
// Operation applicable servers — operation/path override else document servers
// ---------------------------------------------------------------------------

// Raw JSON so the path-level `servers` override is easy to express.
const specWithPathOverride = {
  openapi: "3.0.0",
  info: { title: "Example", version: "1.0" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/items": {
      get: { operationId: "listItems", responses: { "200": { description: "ok" } } },
    },
    "/query": {
      servers: [
        {
          url: "https://{tenant}.{region}.api.example.com",
          variables: { tenant: { default: "default-tenant" }, region: { default: "us-east-1" } },
        },
      ],
      post: { operationId: "runQuery", responses: { "200": { description: "ok" } } },
    },
  },
};

describe("extract — operation applicable servers", () => {
  it.effect("inherits the document servers when there is no override", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(JSON.stringify(specWithPathOverride));
      const result = yield* extract(doc);

      const listItems = result.operations.find((op) => op.operationId === "listItems")!;
      expect(listItems.servers.map((s) => s.url)).toEqual(["https://api.example.com"]);
    }),
  );

  it.effect("carries a path-level override's servers as templates with variables", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(JSON.stringify(specWithPathOverride));
      const result = yield* extract(doc);

      const runQuery = result.operations.find((op) => op.operationId === "runQuery")!;
      expect(runQuery.servers.map((s) => s.url)).toEqual([
        "https://{tenant}.{region}.api.example.com",
      ]);
      const vars = Option.getOrThrow(runQuery.servers[0]!.variables);
      expect(vars.tenant?.default).toBe("default-tenant");
      expect(vars.region?.default).toBe("us-east-1");

      // The host resolves per call: defaults, or call-supplied overrides.
      const server = runQuery.servers[0]!;
      expect(resolveServerUrl(server.url, Option.getOrUndefined(server.variables), {})).toBe(
        "https://default-tenant.us-east-1.api.example.com",
      );
      expect(
        resolveServerUrl(server.url, Option.getOrUndefined(server.variables), {
          tenant: "acme",
          region: "eu-west-1",
        }),
      ).toBe("https://acme.eu-west-1.api.example.com");
    }),
  );
});

// ---------------------------------------------------------------------------
// Preview surfaces each top-level server with its own variables
// ---------------------------------------------------------------------------

describe("previewSpec — server variables", () => {
  it.effect("carries variables per top-level server, excluding operation overrides", () =>
    Effect.gen(function* () {
      const spec = {
        openapi: "3.0.0",
        info: { title: "Example", version: "1.0" },
        servers: [
          { url: "https://api.example.com", description: "Control plane" },
          {
            url: "https://{branch}.{region}.example.com",
            variables: { branch: { default: "main" }, region: { default: "us-east-1" } },
          },
        ],
        paths: {
          "/query": {
            servers: [
              {
                url: "https://{tenant}.gw.example.com",
                variables: { tenant: { default: "default-tenant" } },
              },
            ],
            post: { operationId: "runQuery", responses: { "200": { description: "ok" } } },
          },
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const preview = yield* previewSpec(JSON.stringify(spec));

      // The plain control-plane server has no variables.
      const control = preview.servers.find((s) => s.url === "https://api.example.com")!;
      expect(Option.getOrNull(control.variables)).toBeNull();

      // The gateway server carries only its own branch/region.
      const gateway = preview.servers.find((s) => s.url.startsWith("https://{branch}"))!;
      expect(Object.keys(Option.getOrThrow(gateway.variables))).toEqual(["branch", "region"]);

      // The operation override's `tenant` never appears in the top-level servers.
      const names = preview.servers.flatMap((s) =>
        Object.keys(Option.getOrElse(s.variables, () => ({}))),
      );
      expect(names).not.toContain("tenant");
    }),
  );
});

// ---------------------------------------------------------------------------
// The `server` input property exposes per-call host selection + variables
// ---------------------------------------------------------------------------

type ServerInputSchema = {
  readonly required?: readonly string[];
  readonly properties: {
    readonly server?: {
      readonly properties: {
        readonly url?: { readonly enum: readonly string[]; readonly default: string };
        readonly variables?: {
          readonly properties: Record<
            string,
            { readonly default?: string; readonly enum?: readonly string[] }
          >;
        };
      };
    };
  };
};

describe("buildInputSchema — server property", () => {
  it.effect("exposes a server picker and variables for multiple/templated servers", () =>
    Effect.gen(function* () {
      const spec = {
        openapi: "3.0.0",
        info: { title: "Example", version: "1.0" },
        servers: [
          { url: "https://api.example.com" },
          {
            url: "https://{branch}.{region}.example.com",
            variables: {
              branch: { default: "main" },
              region: { default: "us", enum: ["us", "eu"] },
            },
          },
        ],
        paths: {
          "/items": {
            get: { operationId: "listItems", responses: { "200": { description: "ok" } } },
          },
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const result = yield* extract(yield* parse(JSON.stringify(spec)));
      const op = result.operations.find((o) => o.operationId === "listItems")!;
      const schema = Option.getOrThrow(op.inputSchema) as ServerInputSchema;

      expect(schema.properties.server?.properties.url?.enum).toEqual([
        "https://api.example.com",
        "https://{branch}.{region}.example.com",
      ]);
      const vars = schema.properties.server?.properties.variables?.properties;
      expect(vars?.branch?.default).toBe("main");
      expect(vars?.region?.enum).toEqual(["us", "eu"]);
      // The host stays optional — defaults apply when the call omits `server`.
      expect(schema.required ?? []).not.toContain("server");
    }),
  );

  it.effect("omits the server property for a single concrete server", () =>
    Effect.gen(function* () {
      const spec = {
        openapi: "3.0.0",
        info: { title: "Example", version: "1.0" },
        servers: [{ url: "https://api.example.com" }],
        paths: {
          "/items/{id}": {
            get: {
              operationId: "getItem",
              parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
              responses: { "200": { description: "ok" } },
            },
          },
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const result = yield* extract(yield* parse(JSON.stringify(spec)));
      const op = result.operations.find((o) => o.operationId === "getItem")!;
      const schema = Option.getOrThrow(op.inputSchema) as ServerInputSchema;
      expect(schema.properties.server).toBeUndefined();
    }),
  );
});
