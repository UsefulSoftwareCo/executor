import { Effect, Option } from "effect";

import { OpenApiExtractionError } from "./errors";
import type { ParsedDocument } from "./parse";
import {
  declaredContents,
  DocResolver,
  preferredResponseContent,
  resolveBaseUrl,
  type OperationObject,
  type ParameterObject,
  type PathItemObject,
  type RequestBodyObject,
  type ResponseObject,
  type ServerObject,
} from "./openapi-utils";
import {
  EncodingObject,
  ExtractedOperation,
  ExtractionResult,
  type HttpMethod,
  MediaBinding,
  OperationId,
  OperationParameter,
  OperationRequestBody,
  type ParameterLocation,
  ServerInfo,
  ServerVariable,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HTTP_METHODS: readonly HttpMethod[] = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
];

const VALID_PARAM_LOCATIONS = new Set<string>(["path", "query", "header", "cookie"]);

// ---------------------------------------------------------------------------
// Parameter extraction
// ---------------------------------------------------------------------------

const extractParameters = (
  pathItem: PathItemObject,
  operation: OperationObject,
  r: DocResolver,
): OperationParameter[] => {
  const merged = new Map<string, ParameterObject>();

  for (const raw of pathItem.parameters ?? []) {
    const p = r.resolve<ParameterObject>(raw);
    if (!p) continue;
    merged.set(`${p.in}:${p.name}`, p);
  }
  for (const raw of operation.parameters ?? []) {
    const p = r.resolve<ParameterObject>(raw);
    if (!p) continue;
    merged.set(`${p.in}:${p.name}`, p);
  }

  return [...merged.values()]
    .filter((p) => VALID_PARAM_LOCATIONS.has(p.in))
    .map((p) =>
      OperationParameter.make({
        name: p.name,
        location: p.in as ParameterLocation,
        required: p.in === "path" ? true : p.required === true,
        schema: Option.fromNullishOr(p.schema),
        style: Option.fromNullishOr(p.style),
        explode: Option.fromNullishOr(p.explode),
        allowReserved: Option.fromNullishOr("allowReserved" in p ? p.allowReserved : undefined),
        description: Option.fromNullishOr(p.description),
      }),
    );
};

// ---------------------------------------------------------------------------
// Request body extraction
// ---------------------------------------------------------------------------

const buildEncodingRecord = (
  encoding: Record<string, unknown> | undefined,
): Record<string, EncodingObject> | undefined => {
  if (!encoding) return undefined;
  const out: Record<string, EncodingObject> = {};
  for (const [prop, raw] of Object.entries(encoding)) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as {
      contentType?: string;
      style?: string;
      explode?: boolean;
      allowReserved?: boolean;
    };
    out[prop] = EncodingObject.make({
      contentType: Option.fromNullishOr(e.contentType),
      style: Option.fromNullishOr(e.style),
      explode: Option.fromNullishOr(e.explode),
      allowReserved: Option.fromNullishOr(e.allowReserved),
    });
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const extractRequestBody = (
  operation: OperationObject,
  r: DocResolver,
): OperationRequestBody | undefined => {
  if (!operation.requestBody) return undefined;

  const body = r.resolve<RequestBodyObject>(operation.requestBody);
  if (!body) return undefined;

  const contents = declaredContents(body.content).map(({ mediaType, media }) =>
    MediaBinding.make({
      contentType: mediaType,
      schema: Option.fromNullishOr(media.schema),
      encoding: Option.fromNullishOr(
        buildEncodingRecord((media as { encoding?: Record<string, unknown> }).encoding),
      ),
    }),
  );
  if (contents.length === 0) return undefined;

  // Default = first declared (spec author's preferred order). Callers can
  // override at invoke time with a `contentType` arg.
  const defaultContent = contents[0]!;

  return OperationRequestBody.make({
    required: body.required === true,
    contentType: defaultContent.contentType,
    schema: defaultContent.schema,
    contents: Option.some(contents),
  });
};

// ---------------------------------------------------------------------------
// Response schema extraction
// ---------------------------------------------------------------------------

const extractOutputSchema = (operation: OperationObject, r: DocResolver): unknown | undefined => {
  if (!operation.responses) return undefined;

  const entries = Object.entries(operation.responses);
  const preferred = [
    ...entries.filter(([s]) => /^2\d\d$/.test(s)).sort(([a], [b]) => a.localeCompare(b)),
    ...entries.filter(([s]) => s === "default"),
  ];

  for (const [, ref] of preferred) {
    const resp = r.resolve<ResponseObject>(ref);
    if (!resp) continue;
    const content = preferredResponseContent(resp.content);
    if (content?.media.schema) return content.media.schema;
  }

  return undefined;
};

// ---------------------------------------------------------------------------
// Input schema builder
// ---------------------------------------------------------------------------

const buildInputSchema = (
  parameters: readonly OperationParameter[],
  requestBody: OperationRequestBody | undefined,
): Record<string, unknown> | undefined => {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of parameters) {
    properties[param.name] = Option.getOrElse(param.schema, () => ({ type: "string" }));
    if (param.required) required.push(param.name);
  }

  if (requestBody) {
    properties.body = Option.getOrElse(requestBody.schema, () => ({ type: "object" }));
    if (requestBody.required) required.push("body");

    // When the spec declares multiple media types for this requestBody,
    // expose `contentType` so the model can pick. Default = first declared.
    // `body` schema tracks the default; the model is responsible for
    // supplying a body shape that matches whichever contentType it picks.
    const contents = Option.getOrUndefined(requestBody.contents);
    if (contents && contents.length > 1) {
      properties.contentType = {
        type: "string",
        enum: contents.map((c) => c.contentType),
        default: requestBody.contentType,
        description:
          "Content-Type for the request body. Declared media types for this operation, in spec order.",
      };
    }
  }

  if (Object.keys(properties).length === 0) return undefined;

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
};

// ---------------------------------------------------------------------------
// Operation ID derivation
// ---------------------------------------------------------------------------

const deriveOperationId = (
  method: HttpMethod,
  pathTemplate: string,
  operation: OperationObject,
): string =>
  operation.operationId ??
  (`${method}_${pathTemplate.replace(/[^a-zA-Z0-9]+/g, "_")}`.replace(/^_+|_+$/g, "") ||
    `${method}_operation`);

const explicitToolPath = (operation: OperationObject): string | undefined => {
  const value = (operation as Record<string, unknown>)["x-executor-toolPath"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const explicitPathTemplate = (operation: OperationObject): string | undefined => {
  const value = (operation as Record<string, unknown>)["x-executor-pathTemplate"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

// ---------------------------------------------------------------------------
// Server extraction
// ---------------------------------------------------------------------------

const extractServerList = (servers: readonly ServerObject[] | undefined): ServerInfo[] =>
  (servers ?? []).flatMap((server) => {
    if (!server.url) return [];
    const serverVariables = server.variables as
      | Record<
          string,
          {
            readonly default?: string;
            readonly enum?: readonly string[];
            readonly description?: string;
          }
        >
      | undefined;
    const vars = serverVariables
      ? Object.fromEntries(
          Object.entries(serverVariables).flatMap(([name, v]) => {
            if (v.default === undefined || v.default === null) return [];
            const enumValues = Array.isArray(v.enum)
              ? v.enum.filter((x): x is string => typeof x === "string")
              : undefined;
            return [
              [
                name,
                ServerVariable.make({
                  default: String(v.default),
                  enum:
                    enumValues && enumValues.length > 0 ? Option.some(enumValues) : Option.none(),
                  description: Option.fromNullishOr(v.description),
                }),
              ],
            ];
          }),
        )
      : undefined;
    return [
      ServerInfo.make({
        url: server.url,
        description: Option.fromNullishOr(server.description),
        variables: vars && Object.keys(vars).length > 0 ? Option.some(vars) : Option.none(),
      }),
    ];
  });

const extractServers = (doc: ParsedDocument): ServerInfo[] => extractServerList(doc.servers);

const extractOperationBaseUrl = (
  pathItem: PathItemObject,
  operation: OperationObject,
): string | undefined => {
  const operationServers = extractServerList(operation.servers);
  if (operationServers.length > 0) return resolveBaseUrl(operationServers);

  const pathServers = extractServerList(pathItem.servers);
  if (pathServers.length > 0) return resolveBaseUrl(pathServers);

  return undefined;
};

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------

/** Extract all operations from a bundled OpenAPI 3.x document */
export const extract = Effect.fn("OpenApi.extract")(function* (doc: ParsedDocument) {
  const paths = doc.paths;
  if (!paths) {
    return yield* new OpenApiExtractionError({
      message: "OpenAPI document has no paths defined",
    });
  }

  const r = new DocResolver(doc);
  const operations: ExtractedOperation[] = [];

  for (const [pathTemplate, pathItem] of Object.entries(paths).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!pathItem) continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const parameters = extractParameters(pathItem, operation, r);
      const requestBody = extractRequestBody(operation, r);
      const inputSchema = buildInputSchema(parameters, requestBody);
      const outputSchema = extractOutputSchema(operation, r);
      const tags = (operation.tags ?? []).filter((t) => t.trim().length > 0);
      const operationPathTemplate = explicitPathTemplate(operation) ?? pathTemplate;

      operations.push(
        ExtractedOperation.make({
          operationId: OperationId.make(deriveOperationId(method, pathTemplate, operation)),
          toolPath: Option.fromNullishOr(explicitToolPath(operation)),
          method,
          baseUrl: extractOperationBaseUrl(pathItem, operation),
          pathTemplate: operationPathTemplate,
          summary: Option.fromNullishOr(operation.summary),
          description: Option.fromNullishOr(operation.description),
          tags,
          parameters,
          requestBody: Option.fromNullishOr(requestBody),
          inputSchema: Option.fromNullishOr(inputSchema),
          outputSchema: Option.fromNullishOr(outputSchema),
          deprecated: operation.deprecated === true,
        }),
      );
    }
  }

  return ExtractionResult.make({
    title: Option.fromNullishOr(doc.info?.title),
    version: Option.fromNullishOr(doc.info?.version),
    servers: extractServers(doc),
    operations,
  });
});
