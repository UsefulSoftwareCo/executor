/**
 * A synthetic document shaped like the Graph document v1 stored for its Microsoft presets, which
 * the presets share: block YAML with two-space indents, thousands of path items in areas whose
 * schemas, responses and parameters reference each other across component sections, quoted path
 * keys, block scalars, a list at its parent key's indent and comments. All of it is generated; no
 * part of any real API's document is used.
 */

/** v1's tool for an operation, as v1 stored its row: name, method and path. */
export type GraphOperation = readonly [string, string, string];

/** The operations of an area, and the components they reach, by section. */
export interface GraphArea {
  readonly operations: readonly GraphOperation[];
  readonly components: Readonly<Record<string, readonly string[]>>;
}

/** Components every operation reaches through its error response and its parameters. */
const sharedComponents = {
  schemas: [
    "ODataErrors.ErrorDetails",
    "ODataErrors.MainError",
    "ODataErrors.ODataError",
    "synthetic.collectionResponse",
    "synthetic.entity",
    "synthetic.identity",
  ],
  responses: ["error"],
  parameters: ["select", "top"],
} as const;

const area = (index: number) => {
  const name = `area${index}`;
  const items = `/me/${name}/items`;
  const item = `${items}/{item-id}`;
  const range = `${item}/range(address='{address}')`;
  const operations: GraphOperation[] = [
    [`me.${name}.listItems`, "get", items],
    [`me.${name}.createItems`, "post", items],
    [`me.${name}.getItems`, "get", item],
    [`me.${name}.updateItems`, "patch", item],
    [`me.${name}.deleteItems`, "delete", item],
    [`me.${name}.items.range`, "get", range],
  ];
  const ref = (section: string, key: string) => `'#/components/${section}/${key}'`;
  const schema = (key: string) => ref("schemas", `synthetic.${name}.${key}`);
  const error = `        4XX:
          $ref: ${ref("responses", "error")}`;
  const idParameter = `    parameters:
      - name: item-id
        in: path
        description: The unique identifier of item
        required: true
        schema:
          type: string
        x-ms-docs-key-type: item`;
  const paths = `  ${items}:
    description: Provides operations to manage the items of ${name}.
    get:
      tags:
        - me.${name}
      summary: List items
      description: Get the items of ${name} — für alle, café ✓.
      operationId: me.${name}.ListItems
      parameters:
        - $ref: ${ref("parameters", "top")}
        - $ref: ${ref("parameters", "select")}
        - name: $filter
          in: query
          description: Filter items by property values
          style: form
          explode: false
          schema:
            type: string
      responses:
        2XX:
          $ref: ${ref("responses", `synthetic.${name}.itemCollectionResponse`)}
${error}
      x-ms-pageable:
        nextLinkName: '@odata.nextLink'
        operationName: listMore
      x-ms-docs-operation-type: operation
    post:
      tags:
        - me.${name}
      summary: Create new navigation property to items for me
      operationId: me.${name}.CreateItems
      requestBody:
        description: New navigation property
        content:
          application/json:
            schema:
              $ref: ${schema("item")}
        required: true
      responses:
        2XX:
          description: Created navigation property.
          content:
            application/json:
              schema:
                $ref: ${schema("item")}
${error}
      x-ms-docs-operation-type: operation
  '${item}':
    description: |
      Provides operations to manage one item of ${name}.
      paths: a line of the description that reads like a key
    get:
      tags:
        - me.${name}
      summary: Get items from me
      operationId: me.${name}.GetItems
      parameters:
        - $ref: ${ref("parameters", "select")}
      responses:
        2XX:
          description: Retrieved navigation property
          content:
            application/json:
              schema:
                $ref: ${schema("item")}
${error}
      x-ms-docs-operation-type: operation
    patch:
      tags:
        - me.${name}
      summary: Update the navigation property items in me
      operationId: me.${name}.UpdateItems
      requestBody:
        description: New navigation property values
        content:
          application/json:
            schema:
              $ref: ${schema("item")}
        required: true
      responses:
        2XX:
          description: Success
${error}
      x-ms-docs-operation-type: operation
    delete:
      tags:
        - me.${name}
      summary: Delete navigation property items for me
      operationId: me.${name}.DeleteItems
      parameters:
        - name: If-Match
          in: header
          description: ETag
          style: simple
          schema:
            type: string
      responses:
        2XX:
          description: Success
${error}
      x-ms-docs-operation-type: operation
${idParameter}
  '${range.replaceAll("'", "''")}':
    # Microsoft's generator writes a function's argument in its path.
    get:
      tags:
        - me.${name}
      summary: Invoke function range
      operationId: me.${name}.items.range
      responses:
        2XX:
          $ref: ${ref("responses", `synthetic.${name}.rangeResponse`)}
${error}
      x-ms-docs-operation-type: function
${idParameter}
      - name: address
        in: path
        description: 'Usage: address=''{address}'''
        required: true
        schema:
          type: string
          nullable: true
`;
  const schemas = `    synthetic.${name}.item:
      allOf:
        - $ref: ${ref("schemas", "synthetic.entity")}
        - title: item
          required:
            - '@odata.type'
          type: object
          properties:
            displayName:
              type: string
              description: >-
                The display name of the item, folded over
                more than one line: like this.
              nullable: true
            detail:
              $ref: ${schema("detail")}
            '@odata.type':
              type: string
    synthetic.${name}.detail:
      title: detail
      type: object
      properties:
        note:
          type: string
          description: Notizen für das Element — ✓
          nullable: true
        owner:
          $ref: ${ref("schemas", "synthetic.identity")}
    synthetic.${name}.itemCollectionResponse:
      title: Collection of item
      allOf:
        - $ref: ${ref("schemas", "synthetic.collectionResponse")}
        - type: object
          properties:
            value:
              type: array
              items:
                $ref: ${schema("item")}
    synthetic.${name}.unused:
      title: unused
      type: object
      description: No operation reaches this schema, so no cut keeps it.
      properties:
        detail:
          $ref: ${schema("detail")}
`;
  const responses = `    synthetic.${name}.itemCollectionResponse:
      description: Retrieved collection
      content:
        application/json:
          schema:
            $ref: ${schema("itemCollectionResponse")}
    synthetic.${name}.rangeResponse:
      description: Success
      content:
        application/json:
          schema:
            $ref: ${schema("detail")}
`;
  const examples = `    synthetic.${name}.item:
      value:
        displayName: String
        detail:
          '@odata.type': synthetic.${name}.detail
`;
  return {
    paths,
    schemas,
    responses,
    examples,
    area: {
      operations,
      components: {
        schemas: [
          ...sharedComponents.schemas,
          `synthetic.${name}.detail`,
          `synthetic.${name}.item`,
          `synthetic.${name}.itemCollectionResponse`,
        ],
        responses: [
          ...sharedComponents.responses,
          `synthetic.${name}.itemCollectionResponse`,
          `synthetic.${name}.rangeResponse`,
        ],
        parameters: sharedComponents.parameters,
      },
    } satisfies GraphArea,
  };
};

/** The components of several areas, each section's names sorted. */
export const graphComponents = (areas: readonly GraphArea[]) => {
  const sections: Record<string, string[]> = {};
  for (const { components } of areas)
    for (const [section, names] of Object.entries(components))
      sections[section] = [...new Set([...(sections[section] ?? []), ...names])].sort();
  return sections;
};

/**
 * A Graph-shaped document of `count` areas whose operations call `origin`, and each area's
 * operations and the components they reach.
 */
export const graphDocument = (origin: string, count: number) => {
  const areas = Array.from({ length: count }, (_, index) => area(index));
  const text = `# A synthetic graph API, shaped like a large generated document.
openapi: 3.0.4
info:
  title: Synthetic graph service
  description: This synthetic service is located at ${origin}/v1.0
  version: v1.0
  x-ms-generated-by:
    toolName: Synthetic.OpenApi
    toolVersion: 0.0.0.0
servers:
  - url: ${origin}/v1.0
paths:
${areas.map((generated) => generated.paths).join("")}components:
  schemas:
    synthetic.entity:
      title: entity
      required:
        - '@odata.type'
      type: object
      properties:
        id:
          type: string
          description: The unique identifier for an entity. Read-only.
        '@odata.type':
          type: string
      discriminator:
        propertyName: '@odata.type'
    synthetic.identity:
      title: identity
      type: object
      properties:
        displayName:
          type: string
          nullable: true
        id:
          type: string
          nullable: true
    synthetic.collectionResponse:
      title: Base collection pagination and count responses
      type: object
      properties:
        '@odata.count':
          type: integer
          format: int64
          nullable: true
        '@odata.nextLink':
          type: string
          nullable: true
    ODataErrors.ODataError:
      required:
        - error
      type: object
      properties:
        error:
          $ref: '#/components/schemas/ODataErrors.MainError'
    ODataErrors.MainError:
      required:
        - code
        - message
      type: object
      properties:
        code:
          type: string
        message:
          type: string
          x-ms-primary-error-message: true
        details:
          type: array
          items:
            $ref: '#/components/schemas/ODataErrors.ErrorDetails'
    ODataErrors.ErrorDetails:
      required:
        - code
        - message
      type: object
      properties:
        code:
          type: string
        message:
          type: string
${areas.map((generated) => generated.schemas).join("")}  responses:
    error:
      description: error
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ODataErrors.ODataError'
${areas.map((generated) => generated.responses).join("")}  parameters:
    top:
      name: $top
      in: query
      description: Show only the first n items
      style: form
      explode: false
      schema:
        minimum: 0
        type: integer
      example: 50
    select:
      name: $select
      in: query
      description: Select properties to be returned
      style: form
      explode: false
      schema:
        uniqueItems: true
        type: array
        items:
          type: string
  examples:
${areas.map((generated) => generated.examples).join("")}  securitySchemes:
    azureaadv2:
      type: oauth2
      flows:
        authorizationCode:
          authorizationUrl: https://login.example.invalid/common/oauth2/v2.0/authorize
          tokenUrl: https://login.example.invalid/common/oauth2/v2.0/token
          scopes: {}
security:
  - azureaadv2: []
tags:
${areas.map((_, index) => `- name: me.area${index}\n  x-ms-docs-toc-type: page\n`).join("")}`;
  return { text, areas: areas.map((generated) => generated.area) };
};
