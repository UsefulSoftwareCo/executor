import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { OpenApiExtractionError } from "./errors";
import { previewSpecText, previewSpecTextStreaming } from "./preview";
import type { SpecPreview } from "./preview";

// Streamable block-YAML fixture: parameter/schema `$ref`s, a path-level
// parameter, a deprecated operation, top-level security, and a transitive
// schema chain (WidgetList → Widget → Owner) for the response-field walk.
const fixture = `openapi: 3.0.4
info:
  title: Streamed Fixture
  version: 1.2.3
  description: Fixture for streaming preview parity
servers:
  - url: https://api.example.com/v1
security:
  - appAuth: []
paths:
  /widgets:
    get:
      operationId: widgets.list
      summary: List widgets
      tags:
        - widgets
      parameters:
        - $ref: '#/components/parameters/PageSize'
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/WidgetList'
    post:
      operationId: widgets.create
      summary: Create a widget
      tags:
        - widgets
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Widget'
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Widget'
  /widgets/{widget-id}:
    parameters:
      - name: widget-id
        in: path
        required: true
        schema:
          type: string
    get:
      operationId: widgets.get
      deprecated: true
      tags:
        - widgets
        - detail
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Widget'
components:
  parameters:
    PageSize:
      name: pageSize
      in: query
      required: false
      description: Page size
      schema:
        type: integer
  securitySchemes:
    appAuth:
      type: oauth2
      flows:
        authorizationCode:
          authorizationUrl: https://auth.example.com/authorize
          tokenUrl: https://auth.example.com/token
          scopes:
            widgets.read: Read widgets
  schemas:
    WidgetList:
      type: object
      properties:
        items:
          type: array
          items:
            $ref: '#/components/schemas/Widget'
    Widget:
      type: object
      properties:
        id:
          type: string
        owner:
          $ref: '#/components/schemas/Owner'
    Owner:
      type: object
      properties:
        name:
          type: string
`;

const sortedOperations = (preview: SpecPreview) =>
  [...preview.operations].sort((a, b) =>
    `${a.operationId}:${a.method}`.localeCompare(`${b.operationId}:${b.method}`),
  );

describe("previewSpecTextStreaming", () => {
  it.effect("matches the whole-document preview on a streamable spec", () =>
    Effect.gen(function* () {
      const whole = yield* previewSpecText(fixture);
      const streamed = yield* previewSpecTextStreaming(fixture);

      expect(streamed.title).toEqual(whole.title);
      expect(streamed.description).toEqual(whole.description);
      expect(streamed.version).toEqual(whole.version);
      expect(streamed.servers).toEqual(whole.servers);
      expect(streamed.operationCount).toBe(whole.operationCount);
      expect(streamed.tags).toEqual(whole.tags);
      expect(streamed.securitySchemes).toEqual(whole.securitySchemes);
      expect(streamed.authStrategies).toEqual(whole.authStrategies);
      expect(streamed.headerPresets).toEqual(whole.headerPresets);
      expect(streamed.oauth2Presets).toEqual(whole.oauth2Presets);
      expect(streamed.healthCheckCandidates).toEqual(whole.healthCheckCandidates);
      expect(sortedOperations(streamed)).toEqual(sortedOperations(whole));
    }),
  );

  it.effect("projects response fields through the transitive schema closure", () =>
    Effect.gen(function* () {
      const streamed = yield* previewSpecTextStreaming(fixture);

      const listCandidate = streamed.healthCheckCandidates.find(
        (candidate) => candidate.method === "get" && candidate.operation.endsWith("list"),
      );
      expect(listCandidate).toBeDefined();
      expect(listCandidate!.responseFields ?? []).not.toHaveLength(0);
    }),
  );

  it.effect("applies the keep filter to counts, tags, and candidates", () =>
    Effect.gen(function* () {
      const streamed = yield* previewSpecTextStreaming(fixture, (path, pathItem) =>
        path === "/widgets/{widget-id}" ? null : pathItem,
      );

      expect(streamed.operationCount).toBe(2);
      expect(streamed.tags).toEqual(["widgets"]);
      expect(
        streamed.operations.every((operation) => operation.operationId !== "widgets.get"),
      ).toBe(true);
      expect(
        streamed.healthCheckCandidates.every((candidate) => candidate.method !== "delete"),
      ).toBe(true);
      expect(streamed.healthCheckCandidates).toHaveLength(2);
    }),
  );

  it.effect("fails cleanly on a spec outside the streamable profile", () =>
    Effect.gen(function* () {
      const error = yield* previewSpecTextStreaming(
        JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Inline", version: "1.0.0" },
          paths: {},
        }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(OpenApiExtractionError);
      expect(error).toHaveProperty("message", expect.stringMatching(/streamable/));
    }),
  );
});
