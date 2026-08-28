import { describe, expect, it } from "@effect/vitest";

import { structuralSplit } from "../../sdk/split";
import { buildGraphSliceDocument, parseGraphSourceDocument } from "./slice-build";

// Graph-shaped source: a mail path, an unrelated path, and a schema chain
// where only part is reachable from the mail selection.
const source = `openapi: 3.0.4
info:
  title: Microsoft Graph Fixture
  version: v1.0
servers:
  - url: https://graph.microsoft.com/v1.0
paths:
  /me/messages:
    get:
      operationId: me.ListMessages
      security:
        - azureAdDelegated:
            - Mail.ReadWrite
      parameters:
        - $ref: '#/components/parameters/Top'
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/microsoft.graph.messageCollection'
  /irrelevant:
    get:
      operationId: irrelevant.Get
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/microsoft.graph.unrelated'
components:
  parameters:
    Top:
      name: $top
      in: query
      schema:
        type: integer
  securitySchemes:
    azureAdDelegated:
      type: oauth2
      flows:
        authorizationCode:
          authorizationUrl: https://login.microsoftonline.com/common/oauth2/v2.0/authorize
          tokenUrl: https://login.microsoftonline.com/common/oauth2/v2.0/token
          scopes:
            Mail.ReadWrite: Read and write mail
  schemas:
    microsoft.graph.messageCollection:
      type: object
      properties:
        value:
          type: array
          items:
            $ref: '#/components/schemas/microsoft.graph.message'
    microsoft.graph.message:
      type: object
      properties:
        id:
          type: string
    microsoft.graph.unrelated:
      type: object
      properties:
        name:
          type: string
`;

describe("buildGraphSliceDocument", () => {
  it("keeps the selection's paths and prunes components to the reachable closure", () => {
    const doc = parseGraphSourceDocument(source);
    expect(doc).not.toBeNull();
    const slice = buildGraphSliceDocument(doc!, ["mail"]);

    expect(slice.pathCount).toBe(1);
    expect(slice.operationCount).toBe(1);
    expect(slice.specText).toContain("/me/messages");
    expect(slice.specText).not.toContain("/irrelevant");
    expect(slice.specText).toContain("microsoft.graph.messageCollection");
    expect(slice.specText).toContain("microsoft.graph.message");
    expect(slice.specText).not.toContain("microsoft.graph.unrelated");
    // Referenced small components survive; securitySchemes always survive.
    expect(slice.specText).toContain("$top");
    expect(slice.specText).toContain("azureAdDelegated");
  });

  it("emits the streamable block-YAML profile the runtime splitter accepts", () => {
    const doc = parseGraphSourceDocument(source);
    expect(doc).not.toBeNull();
    const slice = buildGraphSliceDocument(doc!, ["mail"]);

    const structure = structuralSplit(slice.specText);
    expect(structure).not.toBeNull();
    expect(structure!.pathItems).toHaveLength(slice.pathCount);
    expect(structure!.schemas).toHaveLength(slice.schemaCount);
  });
});
