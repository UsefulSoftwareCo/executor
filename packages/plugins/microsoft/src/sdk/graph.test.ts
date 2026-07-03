import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import {
  parseEntry,
  streamOperationBindingsFromStructure,
  structuralSplit,
} from "@executor-js/plugin-openapi";

import { microsoftGraphKeepPathItem } from "./graph";

// Mirrors the verbatim shape of the real Microsoft Graph v1.0 spec: every
// success response uses the OpenAPI wildcard status key `2XX` (the real spec
// has zero numeric 200/201 keys), drive content GET is already declared as a
// binary octet-stream, PUT declares a binary octet-stream requestBody, error
// responses are $refs, and path-level shared parameters carry
// `x-ms-docs-key-type`.
const driveContentFixture = `
openapi: 3.0.4
info:
  title: Microsoft Graph Fixture
  version: v1.0
servers:
  - url: https://graph.microsoft.com/v1.0
paths:
  /drives/{drive-id}/items/{driveItem-id}/content:
    get:
      tags:
        - drives.driveItem
      summary: Get content for the navigation property items from drives
      operationId: drives.GetItemsContent
      parameters:
        - name: $format
          in: query
          description: Format of the content
          style: form
          explode: false
          schema:
            type: string
      responses:
        2XX:
          description: Retrieved media content
          content:
            application/octet-stream:
              schema:
                type: string
                format: binary
        4XX:
          $ref: '#/components/responses/error'
        5XX:
          $ref: '#/components/responses/error'
    put:
      tags:
        - drives.driveItem
      summary: Update content for the navigation property items in drives
      operationId: drives.UpdateItemsContent
      requestBody:
        description: New media content.
        content:
          application/octet-stream:
            schema:
              type: string
              format: binary
        required: true
      responses:
        2XX:
          description: Success
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/microsoft.graph.driveItem'
        4XX:
          $ref: '#/components/responses/error'
        5XX:
          $ref: '#/components/responses/error'
    delete:
      tags:
        - drives.driveItem
      summary: Delete content for the navigation property items in drives
      operationId: drives.DeleteItemsContent
      responses:
        '204':
          description: Success
        4XX:
          $ref: '#/components/responses/error'
        5XX:
          $ref: '#/components/responses/error'
    parameters:
      - name: drive-id
        in: path
        description: The unique identifier of drive
        required: true
        schema:
          type: string
        x-ms-docs-key-type: drive
      - name: driveItem-id
        in: path
        description: The unique identifier of driveItem
        required: true
        schema:
          type: string
        x-ms-docs-key-type: driveItem
components:
  schemas:
    microsoft.graph.driveItem:
      type: object
      properties:
        id:
          type: string
    microsoft.graph.ODataErrors.ODataError:
      type: object
      properties:
        error:
          type: object
  responses:
    error:
      description: error
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/microsoft.graph.ODataErrors.ODataError'
`;

// Report-style Graph endpoints declare an octet-stream success response with an
// object schema (a `value` wrapper) instead of a binary string.
const reportContentFixture = `
openapi: 3.0.4
info:
  title: Microsoft Graph Fixture
  version: v1.0
servers:
  - url: https://graph.microsoft.com/v1.0
paths:
  /reports/getEmailActivityCounts(period={period}):
    get:
      tags:
        - reports.Functions
      summary: Invoke function getEmailActivityCounts
      operationId: reports.getEmailActivityCounts
      parameters:
        - name: period
          in: path
          required: true
          schema:
            type: string
      responses:
        2XX:
          description: Success
          content:
            application/octet-stream:
              schema:
                type: object
                properties:
                  value:
                    type: string
                    format: base64url
        4XX:
          $ref: '#/components/responses/error'
        5XX:
          $ref: '#/components/responses/error'
components:
  schemas:
    microsoft.graph.ODataErrors.ODataError:
      type: object
      properties:
        error:
          type: object
  responses:
    error:
      description: error
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/microsoft.graph.ODataErrors.ODataError'
`;

const identityPathFixture = `
openapi: 3.0.4
info:
  title: Microsoft Graph Fixture
  version: v1.0
servers:
  - url: https://graph.microsoft.com/v1.0
paths:
  /me:
    get:
      operationId: me.GetUser
      security:
        - azureAdDelegated:
            - User.Read
      responses:
        "200":
          description: OK
  /me/photo:
    get:
      operationId: me.photo.GetProfilePhoto
      security:
        - azureAdDelegated:
            - User.Read
      responses:
        "200":
          description: OK
  /me/messages:
    get:
      operationId: me.messages.ListMessages
      security:
        - azureAdDelegated:
            - Mail.ReadWrite
      responses:
        "200":
          description: OK
components: {}
`;

const fullGraphSelection = {
  coversFullGraph: true,
  presetIds: [],
  customScopes: [],
  exactPaths: [],
  pathPrefixes: [],
  tagPrefixes: [],
} as const;

const noWorkloadSelection = {
  coversFullGraph: false,
  presetIds: [],
  customScopes: [],
  exactPaths: [],
  pathPrefixes: [],
  tagPrefixes: [],
} as const;

const keptPathItem = (fixture: string): Record<string, unknown> => {
  const structure = structuralSplit(fixture);
  expect(structure).not.toBeNull();
  const entry = parseEntry(structure!.text, structure!.pathItems[0]!, 2);
  expect(entry).not.toBeNull();
  const [path, rawPathItem] = entry!;
  const pathItem = microsoftGraphKeepPathItem(fullGraphSelection)(
    path,
    rawPathItem as Record<string, unknown>,
  );
  expect(pathItem).not.toBeNull();
  return pathItem as Record<string, unknown>;
};

type StreamedBinding = {
  readonly binding: {
    readonly method: string;
    readonly pathTemplate: string;
    readonly responseBody: Option.Option<{
      readonly fileHint: Option.Option<{
        readonly kind: "binaryResponse" | "byteField";
      }>;
    }>;
  };
};

const streamBindings = (fixture: string) =>
  Effect.gen(function* () {
    const structure = structuralSplit(fixture);
    expect(structure).not.toBeNull();
    const chunks: StreamedBinding[] = [];
    yield* streamOperationBindingsFromStructure(
      structure!,
      { chunkSize: 10, keepPathItem: microsoftGraphKeepPathItem(fullGraphSelection) },
      (chunk) =>
        Effect.sync(() => {
          chunks.push(...chunk);
        }),
    );
    return chunks;
  });

const responseFileHintKind = (
  chunks: readonly StreamedBinding[],
  method: string,
  pathTemplate: string,
): string | undefined => {
  const match = chunks.find(
    (chunk) => chunk.binding.method === method && chunk.binding.pathTemplate === pathTemplate,
  );
  expect(match).toBeDefined();
  const hint = Option.flatMap(match!.binding.responseBody, (body) => body.fileHint);
  return Option.getOrUndefined(hint)?.kind;
};

it("keeps bare /me for identity health checks without keeping /me child paths", () => {
  const structure = structuralSplit(identityPathFixture);
  expect(structure).not.toBeNull();
  const keepPathItem = microsoftGraphKeepPathItem(noWorkloadSelection);
  const kept = new Map<string, Record<string, unknown>>();

  for (const range of structure!.pathItems) {
    const entry = parseEntry(structure!.text, range, 2);
    expect(entry).not.toBeNull();
    const [path, rawPathItem] = entry!;
    const pathItem = keepPathItem(path, rawPathItem as Record<string, unknown>);
    if (pathItem) kept.set(path, pathItem as Record<string, unknown>);
  }

  expect([...kept.keys()]).toEqual(["/me"]);
  expect(kept.get("/me")?.get).toMatchObject({ operationId: "me.GetUser" });
});

it("keeps already-binary drive content responses untouched", () => {
  const pathItem = keptPathItem(driveContentFixture);

  const get = pathItem.get as Record<string, unknown>;
  const getResponses = get.responses as Record<string, unknown>;
  expect(getResponses["2XX"]).toEqual({
    description: "Retrieved media content",
    content: {
      "application/octet-stream": {
        schema: { type: "string", format: "binary" },
      },
    },
  });
  expect(getResponses["4XX"]).toEqual({ $ref: "#/components/responses/error" });
  expect(getResponses["5XX"]).toEqual({ $ref: "#/components/responses/error" });

  // The real spec already declares the PUT requestBody as binary; the
  // normalization must not touch request bodies.
  const put = pathItem.put as Record<string, unknown>;
  expect(put.requestBody).toEqual({
    description: "New media content.",
    content: {
      "application/octet-stream": {
        schema: { type: "string", format: "binary" },
      },
    },
    required: true,
  });
  const putResponses = put.responses as Record<string, unknown>;
  expect(putResponses["2XX"]).toMatchObject({
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/microsoft.graph.driveItem" },
      },
    },
  });

  // Path-level shared parameters survive the filter.
  expect(pathItem.parameters).toMatchObject([
    { name: "drive-id", "x-ms-docs-key-type": "drive" },
    { name: "driveItem-id", "x-ms-docs-key-type": "driveItem" },
  ]);
});

it("normalizes report-style octet-stream object schemas to binary strings", () => {
  const pathItem = keptPathItem(reportContentFixture);

  const get = pathItem.get as Record<string, unknown>;
  const responses = get.responses as Record<string, unknown>;
  const success = responses["2XX"] as Record<string, unknown>;
  expect(success.description).toBe("Success");
  expect(success.content).toEqual({
    "application/octet-stream": {
      schema: { type: "string", format: "binary" },
    },
  });
  expect(responses["4XX"]).toEqual({ $ref: "#/components/responses/error" });
});

it.effect("streams drive content download bindings with a binaryResponse file hint", () =>
  Effect.gen(function* () {
    const chunks = yield* streamBindings(driveContentFixture);
    expect(
      responseFileHintKind(chunks, "get", "/drives/{drive-id}/items/{driveItem-id}/content"),
    ).toBe("binaryResponse");
  }),
);

it.effect("streams report-style download bindings with a binaryResponse file hint", () =>
  Effect.gen(function* () {
    const chunks = yield* streamBindings(reportContentFixture);
    expect(
      responseFileHintKind(chunks, "get", "/reports/getEmailActivityCounts(period={period})"),
    ).toBe("binaryResponse");
  }),
);
