// OneNote page write contracts. Graph's generated OpenAPI document declares a
// JSON body for page create and omits the documented PATCH page update; the
// Graph adapter corrects both. These tests cover the spec correction itself,
// the published slice, and the runtime path an existing integration takes
// when it re-fetches an uncorrected slice (`updateSpec`): the stored tool
// schemas and the wire requests the invoker sends.
//
// The published service emulators have no OneNote surface, so the runtime
// cases serve a synthetic Graph-shaped slice and capture requests through an
// in-memory HttpClient, as the other Graph adapter tests do.

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Match, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  type HttpBody,
} from "effect/unstable/http";
import { JSON_SCHEMA, dump as dumpYamlDocument } from "js-yaml";

import { AuthTemplateSlug, ConnectionName, IntegrationSlug, ToolAddress } from "@executor-js/sdk";
import { createExecutor } from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import { openApiPlugin } from "@executor-js/plugin-openapi";

import { microsoftGraphKeepPathItem } from "./graph";
import {
  MICROSOFT_AUTH_TEMPLATE_SLUG,
  microsoftGraphExactPathsForPresetIds,
  microsoftGraphPathPrefixesForPresetIds,
  microsoftGraphTagPrefixesForPresetIds,
} from "./presets";
import { buildGraphSliceDocument, parseGraphSourceDocument } from "./slice-build";
import { microsoftGraphSliceUrl } from "./slices";
import { microsoftGraphAdapter } from "./spec-format-adapter";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const record = (value: unknown): Json => {
  expect(isRecord(value)).toBe(true);
  return value as Json;
};

// ---------------------------------------------------------------------------
// Synthetic Graph-shaped source (uncorrected, as Graph generates it)
// ---------------------------------------------------------------------------

const ROOTS = [
  { path: "/me", prefix: "me" },
  { path: "/users/{user-id}", prefix: "users" },
  { path: "/groups/{group-id}", prefix: "groups" },
  { path: "/sites/{site-id}", prefix: "sites" },
] as const;

const SECTION_FORMS = [
  { path: "", prefix: "" },
  { path: "/sections/{onenoteSection-id}", prefix: ".sections" },
  {
    path: "/notebooks/{notebook-id}/sections/{onenoteSection-id}",
    prefix: ".notebooks.sections",
  },
  {
    path: "/sectionGroups/{sectionGroup-id}/sections/{onenoteSection-id}",
    prefix: ".sectionGroups.sections",
  },
  {
    path: "/notebooks/{notebook-id}/sectionGroups/{sectionGroup-id}/sections/{onenoteSection-id}",
    prefix: ".notebooks.sectionGroups.sections",
  },
] as const;

interface OneNoteVariant {
  readonly pagesPath: string;
  readonly contentPath: string;
  readonly actionPath: string;
  readonly operationPrefix: string;
}

const VARIANTS: readonly OneNoteVariant[] = ROOTS.flatMap((root) =>
  SECTION_FORMS.map((form) => {
    const pagesPath = `${root.path}/onenote${form.path}/pages`;
    return {
      pagesPath,
      contentPath: `${pagesPath}/{onenotePage-id}/content`,
      actionPath: `${pagesPath}/{onenotePage-id}/onenotePatchContent`,
      operationPrefix: `${root.prefix}.onenote${form.prefix}`,
    };
  }),
);

const errorResponses = {
  "4XX": { $ref: "#/components/responses/error" },
  "5XX": { $ref: "#/components/responses/error" },
};

const delegated = (scope: string) => [{ azureAdDelegated: [scope] }];

const pagesPathItem = (operationPrefix: string): Json => ({
  get: {
    tags: ["onenote"],
    operationId: `${operationPrefix}.ListPages`,
    security: delegated("Notes.Read"),
    responses: {
      "2XX": {
        description: "Retrieved collection",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/microsoft.graph.onenotePageCollectionResponse" },
          },
        },
      },
      ...errorResponses,
    },
  },
  post: {
    tags: ["onenote"],
    summary: "Create page",
    operationId: `${operationPrefix}.CreatePages`,
    security: delegated("Notes.Create"),
    requestBody: {
      description: "New navigation property",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/microsoft.graph.onenotePage" },
        },
      },
      required: true,
    },
    responses: {
      "2XX": {
        description: "Created navigation property.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/microsoft.graph.onenotePage" },
          },
        },
      },
      ...errorResponses,
    },
  },
});

const contentPathItem = (operationPrefix: string): Json => ({
  get: {
    tags: ["onenote"],
    operationId: `${operationPrefix}.GetPagesContent`,
    security: delegated("Notes.Read"),
    responses: {
      "2XX": {
        description: "Retrieved media content",
        content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
      },
      ...errorResponses,
    },
  },
  put: {
    tags: ["onenote"],
    summary: "Update page",
    externalDocs: {
      description: "Find more info here",
      url: "https://learn.microsoft.com/graph/api/page-update?view=graph-rest-1.0",
    },
    operationId: `${operationPrefix}.UpdatePagesContent`,
    security: delegated("Notes.ReadWrite"),
    requestBody: {
      content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
      required: true,
    },
    responses: { "204": { description: "Success" }, ...errorResponses },
  },
  parameters: [
    {
      name: "onenotePage-id",
      in: "path",
      required: true,
      schema: { type: "string" },
      "x-ms-docs-key-type": "onenotePage",
    },
  ],
});

const actionPathItem = (operationPrefix: string): Json => ({
  post: {
    tags: ["onenote"],
    summary: "Invoke action onenotePatchContent",
    operationId: `${operationPrefix}.pages.onenotePage.onenotePatchContent`,
    security: delegated("Notes.ReadWrite"),
    requestBody: {
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              commands: {
                type: "array",
                items: { $ref: "#/components/schemas/microsoft.graph.onenotePatchContentCommand" },
              },
            },
          },
        },
      },
      required: true,
    },
    responses: { "204": { description: "Success" }, ...errorResponses },
    "x-ms-docs-operation-type": "action",
  },
});

const DRIVE_CONTENT_PATH = "/drives/{drive-id}/items/{driveItem-id}/content";

const driveContentPathItem = (): Json => ({
  put: {
    tags: ["drives.driveItem"],
    summary: "Update content for the navigation property items in drives",
    operationId: "drives.UpdateItemsContent",
    security: delegated("Files.ReadWrite"),
    requestBody: {
      content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
      required: true,
    },
    responses: { "204": { description: "Success" }, ...errorResponses },
  },
});

const graphSourceDocument = (): Json => {
  const paths: Json = {};
  for (const variant of VARIANTS) {
    paths[variant.pagesPath] = pagesPathItem(variant.operationPrefix);
    paths[variant.contentPath] = contentPathItem(variant.operationPrefix);
    paths[variant.actionPath] = actionPathItem(variant.operationPrefix);
  }
  paths[DRIVE_CONTENT_PATH] = driveContentPathItem();
  return {
    openapi: "3.0.4",
    info: { title: "Microsoft Graph Fixture", version: "v1.0" },
    servers: [{ url: "https://graph.microsoft.com/v1.0" }],
    paths,
    components: {
      responses: {
        error: {
          description: "error",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/microsoft.graph.ODataErrors.ODataError" },
            },
          },
        },
      },
      securitySchemes: {
        azureAdDelegated: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
              tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
              scopes: { "Notes.ReadWrite": "Read and write notebooks" },
            },
          },
        },
      },
      schemas: {
        "microsoft.graph.onenotePage": {
          type: "object",
          properties: { id: { type: "string" }, title: { type: "string", nullable: true } },
        },
        "microsoft.graph.onenotePageCollectionResponse": {
          type: "object",
          properties: {
            value: {
              type: "array",
              items: { $ref: "#/components/schemas/microsoft.graph.onenotePage" },
            },
          },
        },
        "microsoft.graph.onenotePatchContentCommand": {
          type: "object",
          required: ["@odata.type"],
          properties: {
            action: { $ref: "#/components/schemas/microsoft.graph.onenotePatchActionType" },
            content: { type: "string", nullable: true },
            target: { type: "string" },
            "@odata.type": { type: "string" },
          },
        },
        "microsoft.graph.onenotePatchActionType": {
          type: "string",
          enum: ["Replace", "Append", "Delete", "Insert", "Prepend"],
        },
        "microsoft.graph.ODataErrors.ODataError": {
          type: "object",
          properties: { error: { type: "object" } },
        },
      },
    },
  };
};

const toBlockYaml = (document: Json): string =>
  dumpYamlDocument(document, { noRefs: true, lineWidth: -1, schema: JSON_SCHEMA });

const onenoteKeepPathItem = () =>
  microsoftGraphKeepPathItem({
    coversFullGraph: false,
    presetIds: ["onenote"],
    customScopes: [],
    exactPaths: microsoftGraphExactPathsForPresetIds(["onenote"]),
    pathPrefixes: microsoftGraphPathPrefixesForPresetIds(["onenote"]),
    tagPrefixes: microsoftGraphTagPrefixesForPresetIds(["onenote"]),
  });

const fullGraphKeepPathItem = () =>
  microsoftGraphKeepPathItem({
    coversFullGraph: true,
    presetIds: [],
    customScopes: [],
    exactPaths: [],
    pathPrefixes: [],
    tagPrefixes: [],
  });

const sourcePaths = (): Json => record(graphSourceDocument().paths);

// ---------------------------------------------------------------------------
// Spec correction
// ---------------------------------------------------------------------------

const expectCorrectedCreate = (post: Json, operationPrefix: string) => {
  expect(post.operationId).toBe(`${operationPrefix}.CreatePages`);
  expect(post.security).toEqual(delegated("Notes.Create"));
  const requestBody = record(post.requestBody);
  expect(requestBody.required).toBe(true);
  const content = record(requestBody.content);
  // text/html first: the invoker sends the first media type by default.
  expect(Object.keys(content)).toEqual(["text/html", "multipart/form-data"]);
  expect(record(record(content["text/html"]).schema).type).toBe("string");
  const multipart = record(content["multipart/form-data"]);
  expect(multipart.schema).toMatchObject({
    type: "object",
    required: ["Presentation"],
    properties: { Presentation: { type: "string" } },
    additionalProperties: { type: "string", format: "binary" },
  });
  expect(multipart.encoding).toEqual({ Presentation: { contentType: "text/html" } });
  // Responses stay as generated.
  expect(Object.keys(record(post.responses))).toEqual(["2XX", "4XX", "5XX"]);
};

const expectAddedPatch = (patch: Json, operationPrefix: string) => {
  expect(patch.operationId).toBe(`${operationPrefix}.PatchPagesContent`);
  // Write permissions from the generated PUT, not the GET's read scope.
  expect(patch.security).toEqual(delegated("Notes.ReadWrite"));
  const content = record(record(patch.requestBody).content);
  expect(Object.keys(content)).toEqual(["application/json"]);
  expect(record(content["application/json"]).schema).toMatchObject({
    type: "array",
    items: {
      type: "object",
      required: ["target", "action"],
      properties: {
        target: { type: "string" },
        action: { enum: ["append", "insert", "prepend", "replace", "delete"] },
        position: { enum: ["after", "before"] },
        content: { type: "string" },
      },
    },
  });
  expect(record(patch.responses)["204"]).toEqual({ description: "No Content" });
};

describe("OneNote page write contract correction", () => {
  it("corrects create and adds PATCH update for every root and nested section form", () => {
    const keep = onenoteKeepPathItem();
    const paths = sourcePaths();
    expect(VARIANTS).toHaveLength(20);

    for (const variant of VARIANTS) {
      const pages = keep(variant.pagesPath, record(paths[variant.pagesPath]));
      expect(pages, variant.pagesPath).not.toBeNull();
      expectCorrectedCreate(record(pages!.post), variant.operationPrefix);
      // The list operation is untouched.
      expect(pages!.get).toEqual(record(paths[variant.pagesPath]).get);

      const content = keep(variant.contentPath, record(paths[variant.contentPath]));
      expect(content, variant.contentPath).not.toBeNull();
      expectAddedPatch(record(content!.patch), variant.operationPrefix);
      expect(content!.get).toEqual(record(paths[variant.contentPath]).get);
      expect(content!.parameters).toEqual(record(paths[variant.contentPath]).parameters);

      // The generated PUT stays callable but deprecated, without the
      // PATCH-only update docs link.
      const put = record(content!.put);
      expect(put.deprecated).toBe(true);
      expect(put.externalDocs).toBeUndefined();
      expect(put.operationId).toBe(`${variant.operationPrefix}.UpdatePagesContent`);
      expect(put.requestBody).toEqual(record(record(paths[variant.contentPath]).put).requestBody);

      // The undocumented action stays exactly as generated.
      const action = keep(variant.actionPath, record(paths[variant.actionPath]));
      expect(action).toEqual(paths[variant.actionPath]);
    }
  });

  it("applies the same correction to full-graph selections", () => {
    const keep = fullGraphKeepPathItem();
    const paths = sourcePaths();
    const variant = VARIANTS[0]!;
    expectCorrectedCreate(
      record(keep(variant.pagesPath, record(paths[variant.pagesPath]))!.post),
      variant.operationPrefix,
    );
    expectAddedPatch(
      record(keep(variant.contentPath, record(paths[variant.contentPath]))!.patch),
      variant.operationPrefix,
    );
  });

  it("leaves non-OneNote content PUT operations unchanged", () => {
    const keep = fullGraphKeepPathItem();
    const driveItem = record(sourcePaths()[DRIVE_CONTENT_PATH]);
    expect(keep(DRIVE_CONTENT_PATH, driveItem)).toEqual(driveContentPathItem());
  });

  it("is idempotent over an already corrected path item", () => {
    const keep = onenoteKeepPathItem();
    const paths = sourcePaths();
    for (const variant of VARIANTS) {
      for (const path of [variant.pagesPath, variant.contentPath, variant.actionPath]) {
        const once = keep(path, record(paths[path]));
        expect(keep(path, once!), path).toEqual(once);
      }
    }
  });

  it("corrects a PATCH that the source declares and keeps its operationId", () => {
    const keep = onenoteKeepPathItem();
    const variant = VARIANTS[0]!;
    const declared = {
      operationId: `${variant.operationPrefix}.PatchPagesContent`,
      requestBody: {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/microsoft.graph.onenotePage" },
          },
        },
      },
      responses: { "2XX": { description: "Success" } },
    };
    const corrected = keep(variant.contentPath, {
      ...record(sourcePaths()[variant.contentPath]),
      patch: { ...declared, operationId: "upstream.PatchContent" },
    });
    const patch = record(corrected!.patch);
    expect(patch.operationId).toBe("upstream.PatchContent");
    expectAddedPatch({ ...patch, operationId: declared.operationId }, variant.operationPrefix);
  });

  it("builds an onenote slice with unique operationIds and resolvable refs", () => {
    const doc = parseGraphSourceDocument(toBlockYaml(graphSourceDocument()));
    expect(doc).not.toBeNull();
    const slice = buildGraphSliceDocument(doc!, ["onenote"]);
    const sliceDoc = parseGraphSourceDocument(slice.specText)!;
    const paths = record(sliceDoc.paths);

    expect(Object.keys(paths)).not.toContain(DRIVE_CONTENT_PATH);
    expect(Object.keys(paths)).toHaveLength(VARIANTS.length * 3);
    for (const variant of VARIANTS) {
      expectCorrectedCreate(record(record(paths[variant.pagesPath]).post), variant.operationPrefix);
      expectAddedPatch(record(record(paths[variant.contentPath]).patch), variant.operationPrefix);
    }

    const operationIds = Object.values(paths).flatMap((pathItem) =>
      Object.values(record(pathItem))
        .filter(isRecord)
        .map((operation) => operation.operationId)
        .filter((id): id is string => typeof id === "string"),
    );
    expect(new Set(operationIds).size).toBe(operationIds.length);

    const refs = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (isRecord(value))
        for (const [key, inner] of Object.entries(value)) {
          if (key === "$ref" && typeof inner === "string") refs.add(inner);
          else collect(inner);
        }
    };
    collect(sliceDoc);
    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) {
      const [, , section, name] = ref.split("/");
      expect(record(record(sliceDoc.components)[section!])[name!], ref).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Runtime: stored tool schemas and wire requests
// ---------------------------------------------------------------------------

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly contentType: string;
  readonly body: string;
}

// Encode the request body the way a fetch transport would put it on the wire.
const readBody = (
  body: HttpBody.HttpBody,
): Promise<{ readonly contentType: string; readonly text: string }> =>
  Match.value(body).pipe(
    Match.tag("Uint8Array", (bytes) =>
      Promise.resolve({
        contentType: bytes.contentType,
        text: new TextDecoder().decode(bytes.body),
      }),
    ),
    Match.tag("FormData", (form) => {
      const encoded = new Response(form.formData);
      return encoded.text().then((text) => ({
        contentType: encoded.headers.get("content-type") ?? "",
        text,
      }));
    }),
    // The OneNote calls under test never stream; an unexpected body records as empty.
    Match.tag("Empty", "Raw", "Stream", () => Promise.resolve({ contentType: "", text: "" })),
    Match.exhaustive,
  );

const decodeJsonArray = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);

const ONENOTE_SLICE_URL = microsoftGraphSliceUrl("onenote");

const graphHttpClientLayer = (sliceText: () => string, captured: CapturedRequest[]) =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        if (request.url === ONENOTE_SLICE_URL) {
          return HttpClientResponse.fromWeb(
            request,
            new Response(sliceText(), {
              status: 200,
              headers: { "content-type": "application/yaml" },
            }),
          );
        }
        const body = yield* Effect.promise(() => readBody(request.body));
        captured.push({
          method: request.method,
          url: request.url,
          contentType: request.headers["content-type"] ?? body.contentType,
          body: body.text,
        });
        const created = request.method === "POST";
        return HttpClientResponse.fromWeb(
          request,
          created
            ? new Response(JSON.stringify({ id: "page-1", title: "Test page" }), {
                status: 201,
                headers: { "content-type": "application/json" },
              })
            : new Response(null, { status: 204 }),
        );
      }),
    ),
  );

const PAGE_HTML =
  "<!DOCTYPE html><html><head><title>Test page</title></head><body><p>Hello</p></body></html>";

describe("OneNote page writes through the OpenAPI plugin", () => {
  it.effect(
    "re-fetching an uncorrected slice stores corrected tools and sends the documented wire shapes",
    () =>
      Effect.gen(function* () {
        // The slice as published before the correction: the published asset
        // carries the generated (wrong) request bodies.
        const uncorrectedSlice = toBlockYaml(graphSourceDocument());
        const captured: CapturedRequest[] = [];
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              openApiPlugin({
                httpClientLayer: graphHttpClientLayer(() => uncorrectedSlice, captured),
                specFormats: [microsoftGraphAdapter],
              }),
              memoryCredentialsPlugin(),
            ],
          }),
        );

        yield* executor.openapi.addSpec({
          spec: { kind: "url", url: ONENOTE_SLICE_URL },
          specFormat: "microsoft-graph",
          slug: "onenote_fixture",
        });
        // An existing integration refreshes its tools from the same URL.
        const updated = yield* executor.openapi.updateSpec("onenote_fixture");
        expect(updated.removedTools).toEqual([]);

        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("onenote_fixture"),
          template: AuthTemplateSlug.make(MICROSOFT_AUTH_TEMPLATE_SLUG),
          value: "test-access-token",
        });

        const tools = yield* executor.tools.list();
        const toolNamed = (suffix: string) => {
          const tool = tools.find((candidate) =>
            String(candidate.address).startsWith("tools.onenote_fixture.")
              ? String(candidate.address).endsWith(suffix)
              : false,
          );
          expect(tool, suffix).toBeDefined();
          return ToolAddress.make(String(tool!.address));
        };
        const createTool = toolNamed(".onenote.meOnenoteSectionsCreatePages");
        const patchTool = toolNamed(".onenote.meOnenotePatchPagesContent");

        const createSchema = yield* executor.tools.schema(createTool);
        expect(createSchema?.inputSchema).toMatchObject({
          properties: { body: { type: "string" } },
        });
        const patchSchema = yield* executor.tools.schema(patchTool);
        expect(patchSchema?.inputSchema).toMatchObject({
          properties: { body: { type: "array" } },
        });

        // Create with the default media type: raw HTML.
        yield* executor.execute(createTool, {
          "onenoteSection-id": "section-1",
          body: PAGE_HTML,
        });
        // Create with multipart: the Presentation part is text/html.
        yield* executor.execute(createTool, {
          "onenoteSection-id": "section-1",
          contentType: "multipart/form-data",
          body: { Presentation: PAGE_HTML },
        });
        // Update with a bare JSON array of patch commands; Graph answers 204.
        const commands = [{ target: "body", action: "append", content: "<p>More</p>" }];
        yield* executor.execute(patchTool, { "onenotePage-id": "page-1", body: commands });

        expect(captured).toHaveLength(3);
        const [htmlCreate, multipartCreate, patch] = captured;

        expect(htmlCreate!.method).toBe("POST");
        expect(htmlCreate!.url).toBe(
          "https://graph.microsoft.com/v1.0/me/onenote/sections/section-1/pages",
        );
        expect(htmlCreate!.contentType).toMatch(/^text\/html/);
        expect(htmlCreate!.body).toBe(PAGE_HTML);

        expect(multipartCreate!.method).toBe("POST");
        expect(multipartCreate!.contentType).toMatch(/^multipart\/form-data; boundary=/);
        expect(multipartCreate!.body).toMatch(
          /name="Presentation"[\s\S]*Content-Type: text\/html[\s\S]*<title>Test page<\/title>/i,
        );

        expect(patch!.method).toBe("PATCH");
        expect(patch!.url).toBe("https://graph.microsoft.com/v1.0/me/onenote/pages/page-1/content");
        expect(patch!.contentType).toMatch(/^application\/json/);
        expect(decodeJsonArray(patch!.body)).toEqual(commands);
      }),
  );
});
