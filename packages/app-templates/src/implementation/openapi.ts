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
import { TemplateError } from "../contracts/templates.ts";
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
const identifier = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, "_");
function absolute(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    fail("server_protocol", "Only HTTP APIs can be imported.");
  if (url.username || url.password || url.hash || url.search || /[{}]/.test(value))
    fail("server_url", "This API needs a configured server URL before import.");
  return url.href.replace(/\/$/, "");
}
function serverAddress(
  server: { readonly url: string; readonly variables?: JsonObject | undefined },
  connectUrl: string | undefined,
): string {
  const request = record(
    SwaggerClient.buildRequest({
      spec: {
        openapi: "3.1.0",
        servers: [server],
        paths: { "/": { get: { operationId: "server" } } },
      },
      operationId: "server",
    }),
  );
  return absolute(new URL(Schema.decodeUnknownSync(Schema.String)(request.url), connectUrl).href);
}
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
  const shapes: JsonObject[] = [];
  for (const [status, response] of success) {
    if (status === "204") {
      shapes.push({ type: "null" });
      continue;
    }
    const content = document.resolve(response).content;
    if (content === undefined) return undefined;
    const media = Object.entries(record(content));
    if (media.length === 0) return undefined;
    for (const [type, body] of media) {
      if (!type.includes("json")) {
        shapes.push(isOpenapiTextMedia(type) ? { type: "string" } : openapiBinaryResultSchema);
        continue;
      }
      const schema = record(body).schema;
      if (schema === undefined) return undefined;
      shapes.push(record(schema));
    }
  }
  return document.schema({ anyOf: shapes });
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
        schema: document.schema({ allOf: [...parents, value] }),
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
      // Every credential-bearing operation of one app addresses one origin. A document-,
      // path- or operation-level `servers` override that names another host would send the
      // connected account's key there, so the first resolved origin pins the rest.
      const rootServer =
        options.baseUrl === undefined ? spec.servers?.[0] : { url: options.baseUrl };
      let pinnedOrigin =
        rootServer === undefined
          ? undefined
          : new URL(serverAddress(rootServer, entry.connectUrl)).origin;
      for (const [path, source] of Object.entries(spec.paths)) {
        if (!path.startsWith("/") || path.includes("?") || path.includes("#"))
          fail("operation_path", "An operation has an invalid API path.");
        const item = document.resolve(source);
        for (const method of [
          "GET",
          "POST",
          "PUT",
          "PATCH",
          "DELETE",
          "HEAD",
          "OPTIONS",
        ] as const) {
          if (item[method.toLowerCase()] === undefined) continue;
          const operation = Schema.decodeUnknownSync(Operation)(
            document.resolve(record(item[method.toLowerCase()])),
          );
          const name = identifier(operation.operationId ?? `${method.toLowerCase()}_${path}`);
          if (operations.some((op) => op.name === name))
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
          );
          pinnedOrigin ??= new URL(baseUrl).origin;
          if (new URL(baseUrl).origin !== pinnedOrigin)
            fail(
              "multiple_hosts",
              "This API sends some operations to a different host. Set an API base URL first.",
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
          const properties: Record<string, Json> = {};
          const required: string[] = [];
          for (const [key, group] of groups) {
            properties[key] = { type: "object", ...group, additionalProperties: false };
            if (group.required.length) required.push(key);
          }
          const bodyVariants: JsonObject[] = [];
          let retainedBody: GeneratedOperation["request"]["requestBody"];
          if (operation.requestBody) {
            const request = Schema.decodeUnknownSync(RequestBody)(
              document.resolve(operation.requestBody),
            );
            const retainedContent: Record<string, (typeof RequestBody.Type.content)[string]> = {};
            for (const [contentType, content] of Object.entries(request.content)) {
              const kind = openapiMediaKind(contentType);
              let schema = document.resolve(content.schema ?? {});
              let inputSchema: JsonObject =
                kind === "binary"
                  ? binaryInput
                  : kind === "text"
                    ? { type: "string" }
                    : (content.schema ?? {});
              if (kind === "multipart") {
                const fields = { ...record(schema.properties ?? {}) };
                for (const [key, field] of Object.entries(fields)) {
                  const shape = document.resolve(record(field));
                  if (shape.type === "string" && shape.format === "binary") {
                    fields[key] = binaryInput;
                    // Retain the resolved file shape for runtime base64 conversion.
                    schema = {
                      ...schema,
                      properties: { ...record(schema.properties ?? {}), [key]: shape },
                    };
                  }
                }
                inputSchema = { ...schema, properties: fields };
              }
              retainedContent[contentType] = { ...content, schema };
              bodyVariants.push({
                properties: { contentType: { enum: [contentType] }, body: inputSchema },
                ...(bodyVariants.length === 0 ? {} : { required: ["contentType"] }),
              });
            }
            retainedBody = { ...request, content: retainedContent };
            if (!bodyVariants.length)
              fail("request_body", `Tool ${name} has no request media types.`);
            properties.body = {};
            properties.contentType = {
              type: "string",
              enum: Object.keys(request.content),
              description: "Request media type. Defaults to the first declared type.",
            };
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
            methods.set(methodName, {
              name: methodName,
              label: parts.length === 1 ? "API key" : keys.join(" + "),
              bindings: parts.map((part) => ({
                ...part,
                field: keys.length === 1 ? part.field : `${identifier(part.scheme)}_${part.field}`,
              })),
            });
          }
          const input = document.schema({
            type: "object",
            properties,
            required,
            ...(bodyVariants.length ? { anyOf: bodyVariants } : {}),
            additionalProperties: false,
          });
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
          operations.push({
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
          });
        }
      }
      if (!operations.length) fail("no_operations", "This API does not contain any operations.");
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
      return {
        toolCount: operations.length,
        operations,
        methods: Object.fromEntries(secrets.map((method) => [method.name, method.bindings])),
        oauth: oauth.map(({ name }) => name),
        files: Schema.decodeUnknownSync(SourceFiles)([
          {
            path: "index.ts",
            content: `import { defineApp${hasAccount ? ", accountOperations" : ""} } from "apps"\nimport { openapiOperations } from "apps/openapi"\n${hasAccount ? 'import { provider } from "./provider.ts"\n' : ""}import operations from "./operations.json"\n\nexport default defineApp({ accounts: ${hasAccount ? "{ service: provider.many() }" : "{}"} }, async ({ accounts, signal }) =>\n  ${hasAccount ? "accountOperations(accounts.service, async (account) => " : ""}openapiOperations({\n    operations,\n    methods: ${serialize(Object.fromEntries(secrets.map((m) => [m.name, m.bindings])))},\n    oauth: ${serialize(oauth.map(({ name }) => name))},\n${hasAccount ? "    account,\n" : ""}    signal,\n  })${hasAccount ? ", { signal })" : ""},\n)\n`,
          },
          ...(hasAccount
            ? [
                {
                  path: "provider.ts",
                  content: `import { defineProvider, object, string, secrets, oauth2 } from "apps"\n\nexport const provider = defineProvider({ name: ${serialize(entry.name)}, auth: {\n  ${auth.join(",\n  ")}\n} })\n`,
                },
              ]
            : []),
          { path: "operations.json", content: serialize(operations) },
          packageFile(entry.name),
        ]),
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
    Effect.map(({ operations, methods, oauth }) => ({ operations, methods, oauth })),
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
      files: yield* sourceFiles(generated.files),
      metadata: {
        operations: generated.operations,
        methods: generated.methods,
        oauth: generated.oauth,
      },
    };
  });
