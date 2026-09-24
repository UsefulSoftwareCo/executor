/** Compile an API document into ordinary app source, never a second execution engine. */
import { Effect, Option, Schema } from "effect";
import { JsonObject, SourceFiles, type Json } from "@executor-js/sdk";
import { jsonSchema } from "apps";
import {
  OpenapiErrorResponse,
  openapiMediaKind,
  isOpenapiTextMedia,
  openapiBinaryResultSchema,
} from "apps/openapi";
import "../../../apps/src/contracts/swagger-client.ts";
import SwaggerClient from "swagger-client";
import {
  TemplateError,
  skippedOperationSummary,
  type SkippedOperation,
} from "../contracts/templates.ts";
import type { OpenApiImport } from "../contracts/openapi.ts";
import {
  Operation,
  Parameter,
  RequestBody,
  Specification,
  type CredentialBinding,
  type GeneratedOperation,
  type GeneratedSecrets,
} from "../contracts/openapi.ts";
import { packageFile, sourceFiles } from "./files.ts";
import { openApiDocument, type OpenApiDocument } from "./openapi-document.ts";

function fail(code: TemplateError["code"], reason: string): never {
  throw new TemplateError({ code, reason });
}
const record = (value: unknown): JsonObject => Schema.decodeUnknownSync(JsonObject)(value);
const serialize = (value: unknown) => JSON.stringify(value, null, 2);
/** One entry per line: indenting deeply nested schemas multiplied large APIs, and a line per entry still diffs well. */
const serializeLines = (value: readonly unknown[] | Readonly<Record<string, unknown>>) =>
  Array.isArray(value)
    ? `[\n${value.map((item) => JSON.stringify(item)).join(",\n")}\n]\n`
    : `{\n${Object.entries(value)
        .map(([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`)
        .join(",\n")}\n}\n`;
const identifier = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, "_");
function absolute(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    fail("server_protocol", "Only HTTP APIs can be imported.");
  if (url.username || url.password || url.hash || url.search || /[{}]/.test(value))
    fail("server_url", "This API needs a configured server URL before import.");
  return url.href.replace(/\/$/, "");
}
type Server = { readonly url: string; readonly variables?: JsonObject | undefined };
/** Swagger fills server variables from their defaults. A path- or operation-level server that
 * omits a variable's declaration uses the document server's declaration of the same name.
 */
function serverAddress(
  server: Server,
  connectUrl: string | undefined,
  documentServer?: Server,
): string {
  const variables = { ...documentServer?.variables, ...server.variables };
  const request = record(
    SwaggerClient.buildRequest({
      spec: {
        openapi: "3.1.0",
        servers: [{ url: server.url, variables }],
        paths: { "/": { get: { operationId: "server" } } },
      },
      operationId: "server",
    }),
  );
  return absolute(new URL(Schema.decodeUnknownSync(Schema.String)(request.url), connectUrl).href);
}
/** Converts one API Schema Object from the document's OpenAPI dialect to Draft 2020-12. */
type ApiSchema = (input: Json) => JsonObject;
/** Executor-authored Draft 2020-12; never passed through the OpenAPI dialect converter. */
const binaryInput: JsonObject = {
  type: "string",
  description: "File bytes encoded as base64.",
  contentEncoding: "base64",
};
/** Preserve every documented success shape. Missing schemas remain unknown rather than invented. */
function responseSchema(
  document: OpenApiDocument,
  operation: Operation,
  method: string,
): JsonObject | undefined {
  if (method === "HEAD") return { type: "null" };
  const success = Object.entries(operation.responses ?? {}).filter(([status]) =>
    /^2(?:[0-9]{2}|XX)$/i.test(status),
  );
  if (success.length === 0) return undefined;
  const shapes: Array<(api: ApiSchema) => JsonObject> = [];
  for (const [status, response] of success) {
    if (status === "204") {
      shapes.push(() => ({ type: "null" }));
      continue;
    }
    const content = document.resolve(response).content;
    if (content === undefined) return undefined;
    const media = Object.entries(record(content));
    if (media.length === 0) return undefined;
    for (const [type, body] of media) {
      if (!type.includes("json")) {
        shapes.push(() =>
          isOpenapiTextMedia(type) ? { type: "string" } : openapiBinaryResultSchema,
        );
        continue;
      }
      const schema = record(body).schema;
      if (schema === undefined) return undefined;
      shapes.push((api) => api(schema));
    }
  }
  return document.schema((api) => ({
    anyOf: shapes.map((shape) => shape(api)),
  }));
}
/** Unsupported response references cannot prevent importing otherwise executable calls. */
function errorContent(document: OpenApiDocument, response: JsonObject): Json | undefined {
  try {
    return document.resolve(response).content;
  } catch (error) {
    if (!(error instanceof TemplateError) && !Schema.isSchemaError(error)) throw error;
    return undefined;
  }
}

/** Keep tagged errors, including response/component refs and anyOf alternatives.
 * Public text comes from a declared string message or the schema's static description.
 */
function errorResponses(document: OpenApiDocument, operation: Operation): OpenapiErrorResponse[] {
  const errors: OpenapiErrorResponse[] = [];
  const tagged = Schema.Struct({
    description: Schema.optionalKey(Schema.String),
    required: Schema.Array(Schema.String),
    properties: Schema.Record(Schema.String, JsonObject),
  });
  const visit = (
    status: number,
    input: Json,
    visited = new Set<string>(),
    parents: readonly JsonObject[] = [],
  ) => {
    const object = Schema.decodeUnknownOption(JsonObject)(input);
    if (Option.isNone(object)) return;
    const value = object.value;
    try {
      if (typeof value.$ref === "string" && visited.has(value.$ref)) return;
      const next = typeof value.$ref === "string" ? new Set([...visited, value.$ref]) : visited;
      const shape = document.resolve(value);
      const variants = shape.anyOf;
      if (Array.isArray(variants)) {
        // Validate both the selected branch and its parents, including reference siblings.
        for (const variant of variants) visit(status, variant, next, [...parents, value]);
        return;
      }
      const parsed = Schema.decodeUnknownOption(tagged)(shape);
      if (Option.isNone(parsed) || !parsed.value.required.includes("_tag")) return;
      const tag = parsed.value.properties._tag;
      if (tag === undefined) return;
      const code =
        typeof tag.const === "string"
          ? tag.const
          : Array.isArray(tag.enum) && tag.enum.length === 1
            ? tag.enum[0]
            : undefined;
      const message = parsed.value.properties.message;
      const messageShape = message === undefined ? undefined : document.resolve(message);
      const hasMessage =
        messageShape !== undefined &&
        (messageShape.type === "string" ||
          typeof messageShape.const === "string" ||
          (Array.isArray(messageShape.enum) &&
            messageShape.enum.length > 0 &&
            messageShape.enum.every((value) => typeof value === "string")));
      const declaration = Schema.decodeUnknownOption(OpenapiErrorResponse)({
        code,
        status,
        message: hasMessage
          ? { source: "body" }
          : { source: "schema", value: parsed.value.description },
        schema: document.schema((api) => ({ allOf: [...parents, value].map(api) })),
      });
      if (Option.isSome(declaration)) errors.push(declaration.value);
    } catch (error) {
      // Unsupported error declarations must not prevent otherwise supported API calls.
      if (!(error instanceof TemplateError) && !Schema.isSchemaError(error)) throw error;
    }
  };
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    if (!/^[45][0-9]{2}$/.test(status)) continue;
    const content = errorContent(document, response);
    if (content === undefined) continue;
    for (const [type, body] of Object.entries(record(content))) {
      if (
        !type
          .split(";")[0]
          ?.trim()
          .match(/^application\/(?:[\w.-]+\+)?json$/i)
      )
        continue;
      const schema = record(body).schema;
      if (schema !== undefined) visit(Number(status), schema);
    }
  }
  return errors;
}
/** Parse and generate once at import; API calls only use retained source and selected account fields. */
const generateDefinition = (
  entry: OpenApiImport,
  inputDocument: unknown,
  options: { readonly baseUrl?: string } = {},
) =>
  Effect.tryPromise({
    try: async () => {
      const document = await openApiDocument(inputDocument);
      const { spec } = document;
      const schemes = { ...spec.components?.securitySchemes };
      const bindings = new Map<string, readonly CredentialBinding[]>();
      const oauth: Array<{ name: string; declaration: string }> = [];
      for (const [name, source] of Object.entries(schemes)) {
        const scheme = document.resolve(source);
        if (
          (scheme.type === "http" && scheme.scheme === "bearer") ||
          (scheme.type === "apiKey" &&
            (scheme.in === "header" || scheme.in === "query" || scheme.in === "cookie") &&
            typeof scheme.name === "string")
        ) {
          bindings.set(name, [
            {
              scheme: name,
              field: "token",
              part: "value",
              prefix: "",
            },
          ]);
        } else if (scheme.type === "http" && scheme.scheme === "basic") {
          bindings.set(name, [
            { scheme: name, field: "username", part: "username", prefix: "" },
            { scheme: name, field: "password", part: "password", prefix: "" },
          ]);
        } else if (scheme.type === "oauth2") {
          const code = record(scheme.flows).authorizationCode;
          if (code !== undefined) {
            const flow = record(code);
            if (typeof flow.authorizationUrl === "string" && typeof flow.tokenUrl === "string")
              oauth.push({
                name,
                declaration: `oauth2(${serialize(
                  entry.oauthDiscoveryUrl === undefined
                    ? {
                        authorizationUrl: absolute(
                          new URL(flow.authorizationUrl, entry.connectUrl).href,
                        ),
                        tokenUrl: absolute(new URL(flow.tokenUrl, entry.connectUrl).href),
                        scopes: [
                          ...(entry.scopes ?? Object.keys(record(flow.scopes ?? {}))),
                        ].sort(),
                      }
                    : { discover: absolute(entry.oauthDiscoveryUrl) },
                )})`,
              });
          }
        }
      }
      let fallback: GeneratedOperation["request"]["security"] | undefined;
      if (
        bindings.size === 0 &&
        Object.keys(schemes).length === 0 &&
        entry.auth?.header !== undefined
      ) {
        const header = /^([!#$%&'*+.^_`|~A-Za-z0-9-]+):\s*([^{}\r\n]*)\{[A-Za-z0-9_]+\}$/.exec(
          entry.auth.header,
        );
        if (!header?.[1] || header[2] === undefined)
          fail("auth_helper", "This catalog entry needs a custom authentication helper.");
        bindings.set("apiKey", [
          {
            scheme: "apiKey",
            field: "token",
            part: "value",
            prefix: header[2],
          },
        ]);
        schemes.apiKey = { type: "apiKey", in: "header", name: header[1] };
        fallback = [{ apiKey: [] }];
      }
      if (
        !fallback &&
        !Object.keys(schemes).length &&
        entry.auth &&
        !["none", "public"].includes(entry.auth.kind)
      )
        fail(
          "auth_missing",
          "This entry does not declare enough authentication details to generate an app.",
        );
      const methods = new Map<string, GeneratedSecrets>();
      const operations: GeneratedOperation[] = [];
      // An operation the importer cannot represent is skipped and reported, not fatal.
      const skipped: SkippedOperation[] = [];
      const causes = new Map<TemplateError["code"], TemplateError>();
      const built: { operation: GeneratedOperation; methods: GeneratedSecrets[] }[] = [];
      const documentServer = spec.servers?.[0];
      const candidates = Object.entries(spec.paths).flatMap(([path, source]) => {
        const item = document.resolve(source);
        return (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const)
          .filter((method) => item[method.toLowerCase()] !== undefined)
          .map((method) => ({ path, item, method }));
      });
      if (!candidates.length) fail("no_operations", "This API does not contain any operations.");
      for (const { path, item, method } of candidates) {
        const declared = Schema.decodeUnknownOption(Schema.Struct({ operationId: Schema.String }))(
          item[method.toLowerCase()],
        );
        const tool = identifier(
          Option.isSome(declared) ? declared.value.operationId : `${method.toLowerCase()}_${path}`,
        );
        try {
          if (!path.startsWith("/") || path.includes("?") || path.includes("#"))
            fail("operation_path", "An operation has an invalid API path.");
          const operationMethods: GeneratedSecrets[] = [];
          const operation = Schema.decodeUnknownSync(Operation)(
            document.resolve(record(item[method.toLowerCase()])),
          );
          const name = identifier(operation.operationId ?? `${method.toLowerCase()}_${path}`);
          if (built.some((op) => op.operation.name === name))
            fail(
              "duplicate_operation",
              "The API has duplicate tool names. Update its operation IDs first.",
            );
          const serverList =
            operation.servers ??
            (Array.isArray(item.servers)
              ? Schema.decodeUnknownSync(Specification.fields.servers)(item.servers)
              : undefined) ??
            spec.servers;
          const server = serverList?.[0];
          const serverUrl = options.baseUrl ?? server?.url;
          if (serverUrl === undefined)
            fail("server_missing", "The API has no server URL. Set an API base URL and try again.");
          const baseUrl = serverAddress(
            options.baseUrl === undefined && server !== undefined ? server : { url: serverUrl },
            entry.connectUrl,
            documentServer,
          );
          const combined = [
            ...(Array.isArray(item.parameters) ? item.parameters : []),
            ...(operation.parameters ?? []),
          ];
          const parameters = new Map<string, Parameter>();
          for (const parameter of combined) {
            const p = Schema.decodeUnknownSync(Parameter)(document.resolve(record(parameter)));
            parameters.set(`${p.in}:${p.name}`, p);
          }
          // Parameter schemas stay in the API dialect until the input schema is composed.
          const groups = new Map<
            string,
            { properties: Record<string, Json>; required: string[] }
          >();
          for (const p of parameters.values()) {
            const key = p.in === "header" ? "headers" : p.in;
            const group = groups.get(key) ?? { properties: {}, required: [] };
            const content = p.content === undefined ? undefined : Object.values(p.content)[0];
            group.properties[p.name] =
              p.schema ?? (content === undefined ? {} : (record(content).schema ?? {}));
            if (p.required || p.in === "path") group.required.push(p.name);
            groups.set(key, group);
          }
          const properties: Record<string, (api: ApiSchema) => Json> = {};
          const required: string[] = [];
          for (const [key, group] of groups) {
            properties[key] = (api) => ({
              type: "object",
              properties: Object.fromEntries(
                Object.entries(group.properties).map(([name, schema]) => [name, api(schema)]),
              ),
              required: group.required,
              additionalProperties: false,
            });
            if (group.required.length) required.push(key);
          }
          const bodyVariants: Array<(api: ApiSchema) => JsonObject> = [];
          let retainedBody: GeneratedOperation["request"]["requestBody"];
          if (operation.requestBody) {
            const request = Schema.decodeUnknownSync(RequestBody)(
              document.resolve(operation.requestBody),
            );
            const retainedContent: Record<string, (typeof RequestBody.Type.content)[string]> = {};
            for (const [contentType, content] of Object.entries(request.content)) {
              const kind = openapiMediaKind(contentType);
              const schema = document.resolve(content.schema ?? {});
              const declared = content.schema ?? {};
              // The converted input already holds the body schema. Retain only the resolved
              // multipart file shapes the runtime needs for base64 conversion.
              const retainedFiles: Record<string, JsonObject> = {};
              let inputSchema: (api: ApiSchema) => JsonObject =
                kind === "binary"
                  ? () => binaryInput
                  : kind === "text"
                    ? () => ({ type: "string" })
                    : (api) => api(declared);
              if (kind === "multipart") {
                const fields = { ...record(schema.properties ?? {}) };
                const files: Record<string, JsonObject> = {};
                for (const [key, field] of Object.entries(fields)) {
                  const shape = document.resolve(record(field));
                  if (shape.type === "string" && shape.format === "binary") {
                    delete fields[key];
                    files[key] = binaryInput;
                    retainedFiles[key] = shape;
                  }
                }
                const form = schema;
                // File fields take base64 input; the remaining form keeps its API constraints.
                inputSchema = (api) => {
                  const converted = api({ ...form, properties: fields });
                  return {
                    ...converted,
                    properties: { ...record(converted.properties ?? {}), ...files },
                  };
                };
              }
              retainedContent[contentType] = {
                ...(content.encoding === undefined ? {} : { encoding: content.encoding }),
                ...(Object.keys(retainedFiles).length
                  ? { schema: { type: "object", properties: retainedFiles } }
                  : {}),
              };
              const first = bodyVariants.length === 0;
              bodyVariants.push((api) => ({
                properties: { contentType: { enum: [contentType] }, body: inputSchema(api) },
                ...(first ? {} : { required: ["contentType"] }),
              }));
            }
            retainedBody = { ...request, content: retainedContent };
            if (!bodyVariants.length)
              fail("request_body", `Tool ${name} has no request media types.`);
            properties.body = () => ({});
            properties.contentType = () => ({
              type: "string",
              enum: Object.keys(request.content),
              description: "Request media type. Defaults to the first declared type.",
            });
            if (request.required) required.push("body");
          }
          const security = operation.security ?? spec.security ?? fallback ?? [];
          for (const requirement of security) {
            const keys = Object.keys(requirement).sort();
            if (!keys.length) continue;
            // Each selected account supplies one complete supported alternative.
            // Unsupported alternatives do not hide a usable key or public alternative.
            if (!keys.every((key) => bindings.has(key))) continue;
            const parts = keys.flatMap((key) => bindings.get(key) ?? []);
            const methodName =
              bindings.size === 1 && keys.length === 1 ? "apiKey" : keys.join("_and_");
            operationMethods.push({
              name: methodName,
              label: parts.length === 1 ? "API key" : keys.join(" + "),
              bindings: parts.map((part) => ({
                ...part,
                field: keys.length === 1 ? part.field : `${identifier(part.scheme)}_${part.field}`,
              })),
            });
          }
          const input = document.schema((api) => ({
            type: "object",
            properties: Object.fromEntries(
              Object.entries(properties).map(([key, shape]) => [key, shape(api)]),
            ),
            required,
            ...(bodyVariants.length ? { anyOf: bodyVariants.map((variant) => variant(api)) } : {}),
            additionalProperties: false,
          }));
          try {
            jsonSchema(input);
          } catch {
            fail(
              "input_schema",
              `Tool ${name} has an input schema this importer cannot preserve yet.`,
            );
          }
          const outputSchema = responseSchema(document, operation, method);
          const streaming = Object.values(operation.responses ?? {}).some((response) => {
            const content = errorContent(document, response);
            return content !== undefined && Object.hasOwn(record(content), "text/event-stream");
          });
          built.push({
            methods: operationMethods,
            operation: {
              ...(streaming ? { streaming: true as const } : {}),
              name,
              description: operation.summary ?? operation.description ?? name,
              method,
              path,
              baseUrl,
              openapi: spec.openapi,
              securitySchemes: Object.fromEntries(
                [...new Set(security.flatMap(Object.keys))].map((key) => [
                  key,
                  schemes[key] ??
                    fail("auth_method", "A security requirement names a missing scheme."),
                ]),
              ),
              request: {
                parameters: [...parameters.values()],
                ...(retainedBody === undefined ? {} : { requestBody: retainedBody }),
                security,
                responses: Object.fromEntries(
                  Object.entries(operation.responses ?? {}).flatMap(([status, response]) => {
                    const content = errorContent(document, response);
                    return content === undefined
                      ? []
                      : [
                          [
                            status,
                            {
                              content: Object.fromEntries(
                                Object.keys(record(content)).map((type) => [type, {}]),
                              ),
                            },
                          ],
                        ];
                  }),
                ),
              },
              input,
              ...(outputSchema === undefined ? {} : { outputSchema }),
              errorResponses: errorResponses(document, operation),
            },
          });
        } catch (error) {
          if (!(error instanceof TemplateError) && !Schema.isSchemaError(error)) throw error;
          const code = error instanceof TemplateError ? error.code : "invalid_document";
          if (error instanceof TemplateError && !causes.has(code)) causes.set(code, error);
          skipped.push({ tool, method, path, reason: code });
        }
      }
      // Every credential-bearing operation of one app addresses one origin, so an account's key
      // never reaches a second host. The origin most operations use is pinned; on a tie the
      // document server's origin wins, then the first origin seen. A document server that every
      // operation overrides is never called, so it cannot outvote them.
      const counts = new Map<string, number>();
      for (const { operation } of built) {
        const origin = new URL(operation.baseUrl).origin;
        counts.set(origin, (counts.get(origin) ?? 0) + 1);
      }
      let documentOrigin: string | undefined;
      try {
        if (documentServer !== undefined)
          documentOrigin = new URL(serverAddress(documentServer, entry.connectUrl)).origin;
      } catch (error) {
        if (!(error instanceof TemplateError)) throw error;
      }
      let pinnedOrigin: string | undefined;
      for (const [origin, count] of counts) {
        const best = pinnedOrigin === undefined ? 0 : (counts.get(pinnedOrigin) ?? 0);
        if (count > best || (count === best && origin === documentOrigin)) pinnedOrigin = origin;
      }
      for (const { operation, methods: operationMethods } of built) {
        if (new URL(operation.baseUrl).origin !== pinnedOrigin) {
          skipped.push({
            tool: operation.name,
            method: operation.method,
            path: operation.path,
            reason: "multiple_hosts",
          });
          continue;
        }
        operations.push(operation);
        for (const method of operationMethods) methods.set(method.name, method);
      }
      if (!operations.length) {
        // One shared cause, such as a missing server URL, keeps its own explanation.
        const [only, ...others] = causes.values();
        if (
          only !== undefined &&
          others.length === 0 &&
          skipped.every((op) => op.reason === only.code)
        )
          throw only;
        fail(
          "no_supported_operations",
          "Executor cannot import any operation in this API definition.",
        );
      }
      if (
        !operations.some(
          (operation) =>
            operation.streaming !== true &&
            (operation.request.security.length === 0 ||
              operation.request.security.some((requirement) => {
                const keys = Object.keys(requirement);
                return (
                  keys.every((key) => bindings.has(key)) ||
                  (keys.length === 1 && oauth.some((method) => method.name === keys[0]))
                );
              })),
        )
      )
        fail(
          "no_supported_operations",
          "This API has no operations supported by the available authentication and response transports.",
        );
      const secrets = [...methods.values()].sort((a, b) => a.name.localeCompare(b.name));
      const auth = [
        ...secrets.map(
          (method) =>
            `[${serialize(method.name)}]: secrets({ label: ${serialize(method.label)}, fields: object({ ${method.bindings.map((b) => `[${serialize(b.field)}]: string({ minLength: 1 })`).join(", ")} }) })`,
        ),
        ...oauth.map((method) => `[${serialize(method.name)}]: ${method.declaration}`),
      ];
      const hasAccount = auth.length > 0;
      const hasDefinitions = document.definitions.size > 0;
      return {
        toolCount: operations.length,
        operations,
        definitions: Object.fromEntries(document.definitions),
        skipped,
        methods: Object.fromEntries(secrets.map((method) => [method.name, method.bindings])),
        oauth: oauth.map(({ name }) => name),
        files: Schema.decodeUnknownSync(SourceFiles)(
          [
            {
              path: "index.ts",
              content: `${skipped.length ? "// Some API operations were not imported. skipped-operations.json lists each one and why.\n" : ""}import { defineApp${hasAccount ? ", accountOperations" : ""} } from "apps"\nimport { openapiOperations } from "apps/openapi"\n${hasAccount ? 'import { provider } from "./provider.ts"\n' : ""}import operations from "./operations.json"\n${hasDefinitions ? 'import definitions from "./definitions.json"\n' : ""}\nexport default defineApp({ accounts: ${hasAccount ? "{ service: provider.many() }" : "{}"} }, async ({ accounts, signal }) =>\n  ${hasAccount ? "accountOperations(accounts.service, async (account) => " : ""}openapiOperations({\n    operations,\n${hasDefinitions ? "    definitions,\n" : ""}    methods: ${serialize(Object.fromEntries(secrets.map((m) => [m.name, m.bindings])))},\n    oauth: ${serialize(oauth.map(({ name }) => name))},\n${hasAccount ? "    account,\n" : ""}    signal,\n  })${hasAccount ? ", { signal })" : ""},\n)\n`,
            },
            ...(hasAccount
              ? [
                  {
                    path: "provider.ts",
                    content: `import { defineProvider, object, string, secrets, oauth2 } from "apps"\n\nexport const provider = defineProvider({ name: ${serialize(entry.name)}, auth: {\n  ${auth.join(",\n  ")}\n} })\n`,
                  },
                ]
              : []),
            { path: "operations.json", content: serializeLines(operations) },
            ...(hasDefinitions
              ? [
                  {
                    path: "definitions.json",
                    content: serializeLines(Object.fromEntries(document.definitions)),
                  },
                ]
              : []),
            ...(skipped.length
              ? [
                  {
                    path: "skipped-operations.json",
                    content: serialize(
                      skipped.map((op) => ({ ...op, summary: skippedOperationSummary(op.reason) })),
                    ),
                  },
                ]
              : []),
            packageFile(entry.name),
            // Stored workspaces list files by path; generate them in the same order.
          ].sort((a, b) => a.path.localeCompare(b.path)),
        ),
      };
    },
    catch: (error) =>
      error instanceof TemplateError
        ? error
        : new TemplateError({
            code: "invalid_document",
            reason:
              "This API definition could not be read. It may contain unsupported OpenAPI features.",
          }),
  });

/** Compile credential-free metadata for bundled apps using the same importer as deployed apps. */
export const compileOpenApi = (
  entry: OpenApiImport,
  document: unknown,
  options: { readonly baseUrl?: string } = {},
) =>
  generateDefinition(entry, document, options).pipe(
    Effect.map(({ operations, definitions, methods, oauth, skipped }) => ({
      operations,
      definitions,
      methods,
      oauth,
      skippedOperations: skipped,
    })),
  );

/** Generate editable OpenAPI source; product overrides must already be applied to the document. */
export const generateOpenApiApp = (
  entry: OpenApiImport,
  document: unknown,
  options: { readonly baseUrl?: string } = {},
) =>
  Effect.gen(function* () {
    const generated = yield* generateDefinition(entry, document, options);
    return {
      toolCount: generated.toolCount,
      skippedOperations: generated.skipped,
      files: yield* sourceFiles(generated.files),
      metadata: {
        operations: generated.operations,
        definitions: generated.definitions,
        methods: generated.methods,
        oauth: generated.oauth,
      },
    };
  });
